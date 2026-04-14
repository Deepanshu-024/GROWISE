/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import { getRepoTreeTool, searchCodeTool, getCodeBlockTool } from "../analysis/tools/agent-tools";
import { getDependenciesTool } from "../analysis/tools/getDependenciesTool";
import { getSchemaDefinitionsTool } from "../analysis/tools/getSchemaDefinitionsTool";
import { checkConnectionPoolTool } from "../analysis/tools/checkConnectionPoolTool";
import { createKnowledgeGraphTools } from "../../scale-analyzer/knowledge-graph";
import { findRepositoryByAnyId } from "../analysis/tools/repositoryLookup";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScaleVerdict = "healthy" | "degraded" | "critical" | "failure";
type FindingSeverity = "critical" | "warning" | "info";
type FindingCategory =
    | "query_pattern"
    | "missing_index"
    | "connection_pool"
    | "schema_design"
    | "missing_cache"
    | "transaction";

interface ScaleTier {
    verdict: ScaleVerdict;
    primaryIssues: string[];
}

interface Finding {
    id: string;
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    detail: string;
    evidence: Record<string, unknown>;
    breaksAt: string;
    fix: string;
}

interface ReportSummary {
    totalFindings: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    overallRisk: "critical" | "warning" | "low";
    topConcern: string;
    estimatedScaleCeiling: string;
}

export interface DbAgentReport {
    agentType: "database";
    repositoryId: string;
    archetypeScore: number;
    scaleAnalysis: {
        "10k_users": ScaleTier;
        "100k_users": ScaleTier;
        "1M_users": ScaleTier;
    };
    findings: Finding[];
    summary: ReportSummary;
    toolsUsed: string[];
    confidence: number;
}

export interface StreamEvent {
    type: "tool_start" | "tool_end" | "llm_end" | "agent_thought" | "error" | "done" | "agent_start";
    stepNumber: number;
    timestamp: string;
    elapsedMs: number;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
    toolOutputLength?: number;
    reasoning?: string;
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    cumulativeTokens?: { inputTokens: number; outputTokens: number; totalTokens: number };
    // done event fields
    report?: DbAgentReport | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
}

export interface DbAgentInput {
    repositoryId: string;
    accessToken: string;
    archetypeScore: number;
    onEvent?: (event: StreamEvent) => void;
}

export interface DbAgentOutput {
    report: DbAgentReport | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

// ─── Logging Types ────────────────────────────────────────────────────────────

interface AgentLogStep {
    stepNumber: number;
    type: "decision" | "tool_call" | "tool_response" | "agent_thought" | "error";
    timestamp: string;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
    reasoning?: string;
}

interface AgentLog {
    repositoryId: string;
    archetypeScore: number;
    startTime: string;
    endTime?: string;
    totalSteps: number;
    steps: AgentLogStep[];
    finalReport?: unknown;
    error?: string;
}

function normalizeToolName(name: unknown): string | null {
    if (typeof name !== "string") return null;

    const trimmed = name.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower === "dynamicstructuredtool" || lower === "structuredtool") {
        return null;
    }

    return trimmed;
}

function resolveCallbackToolName(tool: any, fallback?: string): string {
    const idCandidate = Array.isArray(tool?.id)
        ? tool.id[tool.id.length - 1]
        : tool?.id;

    return (
        normalizeToolName(tool?.name) ??
        normalizeToolName(tool?.lc_kwargs?.name) ??
        normalizeToolName(idCandidate) ??
        normalizeToolName(fallback) ??
        "unknown"
    );
}

// ─── Final Report Tool (defined in-file) ──────────────────────────────────────

const finalReportSchema = z.object({
    agentType: z.literal("database"),
    repositoryId: z.string(),
    archetypeScore: z.number(),

    scaleAnalysis: z.object({
        "10k_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
        "100k_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
        "1M_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
    }),

    findings: z.array(
        z.object({
            id: z.string(),
            severity: z.enum(["critical", "warning", "info"]),
            category: z.enum([
                "query_pattern",
                "missing_index",
                "connection_pool",
                "schema_design",
                "missing_cache",
                "transaction",
            ]),
            title: z.string(),
            detail: z.string(),
            evidence: z.record(z.unknown()),
            breaksAt: z.string(),
            fix: z.string(),
        })
    ),

    summary: z.object({
        totalFindings: z.number(),
        criticalCount: z.number(),
        warningCount: z.number(),
        infoCount: z.number(),
        overallRisk: z.enum(["critical", "warning", "low"]),
        topConcern: z.string(),
        estimatedScaleCeiling: z.string(),
    }),

    toolsUsed: z.array(z.string()),
    confidence: z.number().min(0).max(1),
});

const finalReportTool = tool(
    async (input): Promise<string> => {
        const parsed = input as z.infer<typeof finalReportSchema>;

        // Fill safe defaults for any missing optional-ish fields
        const report: DbAgentReport = {
            agentType: "database",
            repositoryId: parsed.repositoryId ?? "unknown",
            archetypeScore: parsed.archetypeScore ?? 0,
            scaleAnalysis: {
                "10k_users": parsed.scaleAnalysis?.["10k_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
                "100k_users": parsed.scaleAnalysis?.["100k_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
                "1M_users": parsed.scaleAnalysis?.["1M_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
            },
            findings: (parsed.findings ?? []).map((f, i) => ({
                id: f.id ?? `finding-${i + 1}`,
                severity: f.severity ?? "info",
                category: f.category ?? "query_pattern",
                title: f.title ?? "Untitled finding",
                detail: f.detail ?? "",
                evidence: f.evidence ?? {},
                breaksAt: f.breaksAt ?? "unknown",
                fix: f.fix ?? "No fix suggested",
            })),
            summary: {
                totalFindings: parsed.summary?.totalFindings ?? parsed.findings?.length ?? 0,
                criticalCount: parsed.summary?.criticalCount ?? 0,
                warningCount: parsed.summary?.warningCount ?? 0,
                infoCount: parsed.summary?.infoCount ?? 0,
                overallRisk: parsed.summary?.overallRisk ?? "low",
                topConcern: parsed.summary?.topConcern ?? "No concerns identified",
                estimatedScaleCeiling: parsed.summary?.estimatedScaleCeiling ?? "unknown",
            },
            toolsUsed: parsed.toolsUsed ?? [],
            confidence: parsed.confidence ?? 0.5,
        };

        console.log("[dbGraphAgent] FINAL_REPORT received");

        return JSON.stringify(report);
    },
    {
        name: "finalReport",
        description:
            "Submit the final structured findings report. You MUST call this tool when your investigation is complete. " +
            "Pass the complete report with all fields: agentType, repositoryId, archetypeScore, scaleAnalysis, findings, summary, toolsUsed, confidence. " +
            "Never output your final answer as prose — always use this tool. The orchestrator cannot read prose output.",
        schema: finalReportSchema,
    }
);

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Database Specialist Agent.
Your job is to investigate a GitHub repository's database layer
and produce a findings report that reflects what ACTUALLY MATTERS
at scale — not every bad pattern, but the ones real users will
trigger frequently enough to cause real problems.

You think like a senior backend engineer doing a pre-launch review:
- Understand the project before analyzing it
- Weight findings by how often users will actually hit them
- Investigate deeply only what genuinely matters
- Stop when you have enough evidence — do not over-investigate
- Never guess — if you cannot find evidence, say so
- Always call finalReport when done — never output prose
- A partial confident report beats a perfect report that times out

---

## PHASE 1 — Understand The Stack AND The Project

### 1A — Stack understanding
Call getDependencies with repositoryId.
Extract and note:
  orm: which ORM is in use
  database: which database
  framework: Next.js, Express, Fastify, etc.
  isServerless: true if Next.js, Nuxt, Remix, Astro
  cacheLayer: Redis, Memcached, or NONE
  paymentLibs: Stripe, Razorpay, Paddle, etc.
  authLibs: Clerk, NextAuth, Auth0, etc.

These shape severity of everything that follows:
→ No cache layer = every DB finding is more severe
→ isServerless + no pooler = connection pool is critical
→ Payment libs = financial flows need transactions
→ Auth libs = session queries on every request

### 1B — Project structure analysis
Call getRepoTree using the exact values from your task message:
  owner: use the EXACT owner value given to you
  repo: use the EXACT repo value given to you
  branch: use the EXACT branch value given to you
  accessToken: use the accessToken given to you

CRITICAL: Do NOT modify or guess owner/repo values.
If getRepoTree fails on first attempt: skip it and proceed.
Do not retry getRepoTree more than once.

From the tree, determine TWO things:

THING 1 — Architecture pattern:
Scan the file tree and answer these questions:

  hasApiRoutes: does the tree contain files matching
    src/app/api/**/route.ts OR pages/api/**/*.ts?
    → true if ANY route.ts or pages/api file exists

  hasServerActions: does the tree contain files matching
    ANY of these patterns:
    - path contains "actions" AND ends in .ts
      e.g. src/lib/actions.ts, src/app/actions/cart.ts
    - path contains "action" AND ends in .ts
    - filename is: actions.ts, action.ts
    - path contains: server-actions, server-action
    Note: route.ts files are NOT server actions
          only standalone .ts files with action patterns

  hasExpressRoutes: do dependencies include
    express, fastify, hono, koa, nestjs?

Based on answers choose your approach for Phase 2:
  hasApiRoutes AND hasServerActions → APPROACH D (Mixed)
  hasApiRoutes only                 → APPROACH A (API Routes)
  hasServerActions only             → APPROACH B (Server Actions)
  hasExpressRoutes                  → APPROACH C (Express/Fastify)
  none of the above                 → APPROACH A (try API routes anyway)

Write down which approach you chose and why.

THING 2 — Project type:
Read folder names to infer what kind of app this is:

  E-commerce: /products, /cart, /checkout, /orders, stripe, razorpay
  → Core flows: browse → product → cart → checkout
  → High traffic: home, product listing, product detail
  → Medium: cart, user profile, order history
  → Low: admin, export, reports

  SaaS: /dashboard, /analytics, /settings, /billing, /workspace
  → Core flows: login → dashboard → data interaction
  → High traffic: dashboard, data tables, API endpoints
  → Medium: settings, team pages
  → Low: billing, onboarding, admin

  Social: /feed, /posts, /profile, /notifications
  → Core flows: feed → post → profile → interact
  → High traffic: feed, notifications, profile
  → Medium: search, messages
  → Low: settings, admin

  API Service: /api only, no UI pages
  → Every endpoint matters equally
  → High: list, get, health endpoints
  → Medium: create, update endpoints
  → Low: delete, export, admin endpoints

  Unknown: note uncertainty, treat non-UI high-frequency
           functions as high priority

Write down project type before continuing.

---

## PHASE 2 — Identify Investigation Targets

Use the approach you chose in Phase 1B.

---

### APPROACH A — Next.js API Routes Only
USE THIS if: hasApiRoutes=true AND hasServerActions=false

In this architecture UI calls APIs via fetch().
The route path tells you traffic pattern directly.
Do NOT call buildImportFrequencyMap.

Step 1: Find all route.ts files from the repo tree.

Step 2: Classify each by path:

  CRITICAL — financial and core write operations:
  → path contains: checkout, payment, order, purchase,
                   confirm, verify-payment, create-order,
                   razorpay, stripe, webhook

  HIGH — core reads every user triggers:
  → path contains: products, product, items, item,
                   search, browse, categories, category,
                   cart, user, profile, feed, home,
                   best-sellers, new-arrivals, featured

  MEDIUM — authenticated user actions:
  → path contains: wishlist, reviews, address, coupon,
                   settings, account, notifications

  LOW — admin and utility (skip these):
  → path contains: admin, export, report, seed, migrate,
                   debug, test, dummy, upload (in admin path)

Step 3: Build investigation list:
  All CRITICAL routes + top 3-4 HIGH routes
  Skip MEDIUM and LOW entirely
  Maximum 10 total

---

### APPROACH B — Server Actions Only
USE THIS if: hasServerActions=true AND hasApiRoutes=false

In this architecture components call server actions directly.
Import frequency tells you the traffic pattern.
Do NOT classify routes.

Step 1: Call buildImportFrequencyMap with repositoryId
        and accessToken.

Step 2: Filter results — remove these immediately:
  → name is exactly: prisma, db, client, pool, connection
  → definedIn contains: /components/ui/
  → definedIn contains: cloudflare, r2-utils, fpixel,
                        analytics, tracking
  → name is a UI component: Button, Card, Input, etc.
  → name is a utility: cn, clsx, twMerge, formatDate

Step 3: From remaining functions keep only server actions:
  → definedIn path contains: actions, action,
                              server-actions, server-action
  → OR isServerAction: true in the frequency map result

Step 4: Classify by uiImportCount:
  HIGH:     4+ UI file imports
  MEDIUM:   2-3 UI file imports
  LOW:      1 UI file import (skip these)

Step 5: Further boost by context:
  × 3.0 if imported from core flow page
           (checkout, product, cart, dashboard, feed)
  × 1.5 if isServerAction: true
  × 0.3 if imported only from admin pages

Step 6: Build investigation list:
  All HIGH + top MEDIUM server actions
  Maximum 10 total

---

### APPROACH C — Express / Fastify / Custom Server
USE THIS if: hasExpressRoutes=true

Look for route files in: routes/, src/routes/, controllers/
Classify by URL pattern same as APPROACH A.
Maximum 10 routes total.

---

### APPROACH D — Mixed (API Routes + Server Actions)
USE THIS if: hasApiRoutes=true AND hasServerActions=true

This is the most common modern Next.js pattern.
You need BOTH tools to get the complete picture.
API routes are called via fetch(). Server actions are
called directly from components. Both hit the database.

Step 1: Classify API routes from repo tree
  Same classification as APPROACH A:
  CRITICAL / HIGH / MEDIUM / LOW by path pattern
  Note all CRITICAL and HIGH routes

Step 2: Call buildImportFrequencyMap with repositoryId
        and accessToken.

  From the results filter to server actions only:
  → Keep ONLY functions where definedIn path contains:
    actions, action, server-actions, server-action
  → Also keep if isServerAction: true in result
  → Remove: prisma, db, UI components, utilities
    (same filter rules as APPROACH B)

  Classify server actions by uiImportCount:
  HIGH:   4+ imports from core flow pages
  MEDIUM: 2-3 imports
  LOW:    1 import (skip)

  Apply context boost:
  × 3.0 if imported from core flow page
  × 1.5 if isServerAction: true
  × 0.3 if admin only

Step 3: Merge into ONE ranked list

  Assign a combined priority score to each item:

  API route scores:
    CRITICAL route = score 100
    HIGH route     = score 60
    MEDIUM route   = score 20
    LOW route      = score 0 (skip)

  Server action scores:
    HIGH server action (4+ core imports)   = score 80
    MEDIUM server action (2-3 imports)     = score 40
    LOW server action (1 import)           = score 0 (skip)

  Sort combined list by score descending.
  Take top 10 items from sorted list.
  This is your INVESTIGATE LIST for Phase 4.

  Example merged list for an e-commerce app:
    score 100: POST /api/checkout/confirm-order (CRITICAL route)
    score 100: POST /api/checkout/create-order  (CRITICAL route)
    score 80:  addToCart() in actions/cart.ts   (HIGH server action)
    score 60:  GET /api/products/route.ts       (HIGH route)
    score 60:  GET /api/products/[slug]/route.ts (HIGH route)
    score 40:  removeFromCart() in actions/cart.ts (MEDIUM action)
    score 20:  GET /api/cart/route.ts           (MEDIUM route)
    → Take top 10: all scores 40 and above

---

## PHASE 3 — Validate Investigation List

Before Phase 4, verify each item in your list:

Remove if:
→ It is a pure image/file utility with no DB interaction
→ It is a health check or ping endpoint
→ Path suggests no data: /api/og, /api/revalidate
→ It is a UI component or hook (not a data function)

Keep if:
→ Path suggests data reading: products, users, orders
→ Path suggests data writing: checkout, create, update
→ It is a financial operation: payment, order, webhook

Final list: 3-10 items maximum.
Write it explicitly before Phase 4.

---

## PHASE 4 — Deep Dive Per Investigation Target

BEFORE calling traceFunctionTool on any item:
Ask: "Could this possibly make a DB call?"
If the answer is no → skip it immediately.

For each item in your validated INVESTIGATE LIST:

Step A: Call traceFunction with direction "downstream"

  For API routes:
    functionName: the HTTP method handler name
                  e.g. "GET", "POST", "PUT", "DELETE"
    filePath: the route.ts file path

  For server actions:
    functionName: the exported function name
                  e.g. "addToCart", "processPayment"
    filePath: the actions file path

  Extract from result:
  → Does this make DB calls?
  → DB calls inside a loop? (N+1)
  → DB calls count per invocation?
  → findMany with no pagination (take/limit/skip)?
  → Nested includes 3+ levels deep?
  → Multiple writes without transaction wrapper?

  If downstream returns ZERO DB calls:
  → Do NOT call upstream
  → Note "no DB calls" and move immediately to next item
  → This does NOT count against your 10 call limit

Step B: Only if downstream found DB calls AND
        functionName is NOT a generic HTTP method
        (GET, POST, PUT, DELETE):
  Call traceFunction direction "upstream"

  IMPORTANT: If functionName is "GET", "POST", "PUT",
  or "DELETE" — do NOT call upstream. These are route
  handlers and searching for them will match every
  route file in the repo causing massive slowdown.
  Instead assume the route is public unless you saw
  auth middleware in the downstream trace.

  Extract from upstream:
  → Reachable from public route?
  → Auth middleware present?

Step C: Assign severity using priority score + findings:
  score 100 route + N+1              = CRITICAL
  score 100 route + unbounded query  = CRITICAL
  score 80 action + N+1             = CRITICAL
  score 60 route + N+1              = CRITICAL
  score 60 route + missing pagination = WARNING
  score 40 action + any issue       = WARNING
  score 20 route + any issue        = INFO

Step D: Record finding with evidence:
  → Route path or function name and file
  → What DB calls it makes
  → The specific pattern (N+1, unbounded, no transaction)
  → Estimated break point

HARD CONTROLS:
→ Maximum 10 traceFunctionTool calls total — never exceed
→ Stop after 6 calls regardless of list remaining
→ Stop if 3+ critical findings found — go to Phase 5
→ Never call traceFunctionTool on generic HTTP methods
  upstream — only downstream for route handlers

---

## PHASE 5 — Schema + Connection Pool

Run immediately after Phase 4. Never skip this phase.

### 5A — Schema analysis

IMPORTANT — find the correct schema file:
  Prisma:    look for *.prisma files in the tree
             The file is almost always: prisma/schema.prisma
             NEVER pass src/lib/prisma.ts — that is the client
  TypeORM:   *.entity.ts files — NOT the datasource config
  Mongoose:  *.model.ts or *.schema.ts — NOT the connection file
  Drizzle:   schema.ts in db/ folder — NOT drizzle.config.ts
  Sequelize: *.model.ts in models/ folder

Call getSchemaDefinitions with:
  schemaFiles: correct schema file paths from tree
  detectedOrm: from Phase 1
  detectedDatabase: from Phase 1

Cross-reference with Phase 4 findings:
→ For each DB call found: is the filtered column indexed?
→ For each foreign key: is the FK column indexed?
→ For each findMany: is the filtered column indexed?

### 5B — Connection pool

Call searchCode for "PrismaClient" to find connection files.
Look for .env.example in repo tree.
Call checkConnectionPool with found files + env file.

Cross-reference with Phase 1:
  isServerless + no pooler + no singleton = CRITICAL
  isServerless + pooler detected          = INFO
  not serverless + no pool config         = WARNING
  not serverless + explicit config        = note it

---

## CALL FINAL REPORT NOW IF ANY OF THESE IS TRUE

→ Phase 5 is complete ← primary trigger, always call after Phase 5
→ 3+ critical findings found
→ 9 of 10 traceFunctionTool calls used
→ Investigation list had fewer than 3 items and all investigated

After Phase 5 completes: call finalReport IMMEDIATELY.
Do NOT investigate more routes after Phase 5.
Do NOT call any tool after Phase 5 except finalReport.
If uncertain: call finalReport now.
Partial confident report > perfect report that times out.

---

## SEVERITY RULES

CRITICAL — will break under load:
→ N+1 on CRITICAL or HIGH priority route/action
→ Unbounded findMany on HIGH priority route/action
→ Unindexed FK on table used by CRITICAL/HIGH items
→ Serverless + no connection pooler + no singleton
→ Missing transaction on payment/order writes

WARNING — will degrade under load:
→ N+1 on MEDIUM priority route/action
→ Missing pagination on MEDIUM priority item
→ Unindexed timestamp/status column on core tables
→ Connection pool with no timeouts
→ Nested includes 3+ levels on any priority item

INFO — worth noting:
→ Raw SQL usage
→ Missing index on LOW priority queries
→ Pool size suboptimal
→ No soft delete strategy

DO NOT create findings for:
→ LOW priority admin routes
→ Items not in investigation list
→ Utility functions with no DB calls

---

## SCALE TIER RULES

10k_users:
  CRITICAL findings on core routes = failure
  Warnings only = degraded
  No issues = healthy

100k_users:
  Any CRITICAL = failure
  Multiple warnings on core routes = critical
  Single warnings = degraded
  No issues = healthy

1M_users:
  No caching + high DB load = failure
  Full table scans on large tables = critical
  Connection pool exhaustion = failure
  Minor issues only = degraded

---

## FINAL REPORT RULES

findings:
→ Include ALL critical findings
→ Include warnings on HIGH/MEDIUM priority items
→ Include INFO sparingly
→ Do NOT include findings for LOW priority items
  unless genuinely critical regardless of traffic

summary.topConcern:
→ Most impactful issue for THIS specific project
→ Name the actual route/function and actual issue
→ Example: "POST /api/checkout/create-order has DB
   writes inside for...of loop — N+1 on every order"

summary.estimatedScaleCeiling:
→ Based on most critical finding only
→ Specific: "~500 concurrent users" not "low"

confidence:
→ 0.9+ if all CRITICAL + HIGH items investigated
→ 0.7-0.9 if most covered but hit limits
→ 0.5-0.7 if schema or pool incomplete
→ below 0.5 only if major phases skipped

toolsUsed:
→ Only list tools actually called

---

## ABSOLUTE CONSTRAINTS

→ Maximum 10 traceFunctionTool calls — never exceed
→ Never call upstream trace on generic HTTP methods
  (GET, POST, PUT, DELETE) — causes massive slowdown
→ Never retry getRepoTree more than once
→ Call finalReport immediately after Phase 5
→ Never output prose as final answer
→ If recursion limit approaching: call finalReport NOW
→ Report must be specific to THIS project`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const GRAPH_SYSTEM_PROMPT = `You are a Database Specialist Agent using a repository knowledge graph as your PRIMARY context source.

Your goal is to analyze database scalability for 10k, 100k, and 1M users while keeping time and token usage low.

Core rules:
- Prefer graph tools over GitHub fetch/search tools whenever the graph can answer.
- Start with cheap graph summaries, then deepen only on the hottest paths.
- Use legacy tools only for gaps the graph does not cover: dependencies, repo tree, schema extraction, connection pool facts, targeted code search.
- Never guess. If evidence is incomplete, say so and lower confidence.
- Always call finalReport exactly once when done.

Graph tools:
- get_graph_stats
- list_flows
- get_flow
- get_critical_flows
- get_db_heavy_functions
- get_function_callers
- get_function_callees
- get_file_summary
- query_graph
- get_route_call_chain

Non-graph tools:
- getDependencies
- getRepoTree
- searchCode
- getCodeBlock    ← PREFER this over getFileContent when you have lineStart/lineEnd from get_flow steps
- getSchemaDefinitions
- checkConnectionPool
- finalReport

Phase 1:
- Call getDependencies with repositoryId.
- Call get_graph_stats.
- Extract ORM, database, framework, serverless status, cache layer, payment libs, auth libs, graph node count, edge count, and flow count.
- No cache makes hot reads more severe.
- Serverless plus no pooler or singleton makes pool issues critical.

Phase 2:
- Call list_flows with sortBy="criticality", detailLevel="minimal".
- Call get_db_heavy_functions.
- Only if still unclear, call get_critical_flows with a small limit.
- Build one ranked shortlist of 3-6 targets from top critical flows plus top DB-heavy functions.
- Prioritize checkout, payment, order, webhook, product, cart, search, dashboard, analytics, feed, profile, user.
- Remove admin/test/seed/migrate/debug/health/revalidate/utility-only items.
- Prefer targets that appear in both a critical flow and the DB-heavy function list.

Phase 3:
- Maximum 8 graph investigation calls after the shortlist is chosen.
- Prefer one get_flow call over several caller/callee hops.
- Stop early once you have enough evidence for the top concerns.
- For each shortlisted target, prefer get_flow first.
- If get_flow is not enough, use one of get_function_callees, get_function_callers, or query_graph with callers_of/callees_of.
- Use get_file_summary or query_graph with file_summary for lightweight file context.
- Use get_route_call_chain only when the target is clearly a route handler and you need a direct route-to-callee chain.
- Look for repeated DB access in one hot flow, DB-heavy fan-out, likely N+1, hot reads with no cache, multi-write payment/order paths that may need transactions, and wide or deep data-loading paths that likely degrade under load.
- For exact token-level confirmation that the graph cannot provide, use searchCode sparingly on selected hot files only with queries such as $transaction, transaction(, findMany, take:, skip:, limit, queryRaw, executeRaw.
- If targeted search cannot confirm a pattern, do not overclaim it.

Phase 4:
- Call getRepoTree exactly once to find schema files and env files.
- Call getSchemaDefinitions with the correct schema files.
- Verify foreign key indexing and indexes on columns likely used by hot flows.
- Use searchCode to find connection setup files such as PrismaClient, new Pool(, mongoose.connect, createPool, DATABASE_URL.
- Call checkConnectionPool with the connection files and env file.
- Serverless + no pooler + no singleton is critical.
- After Phase 4, call finalReport immediately.

Severity:
- Critical: hot checkout/order/payment flow with repeated DB fan-out or likely N+1; unindexed foreign key or hot filter path on a core table; serverless app with no pooler and no singleton; strong evidence of multi-write payment/order flow without transaction protection.
- Warning: hot read path with no cache layer and heavy DB usage; likely unbounded reads or expensive graph path on high-traffic flows; missing pool limits/timeouts in a hot app; schema design that will degrade under load but may not fail immediately.
- Info: lower-confidence or lower-frequency risks worth noting.

Scale tiers:
- 10k_users: critical findings on core flows => failure; warnings only => degraded; no meaningful issues => healthy.
- 100k_users: any critical finding => failure; multiple warnings on hot flows => critical; minor issues only => degraded.
- 1M_users: no cache plus hot DB-heavy reads => failure; pool exhaustion risk => failure; unindexed hot joins/lookups => critical or failure depending on evidence; only minor issues => degraded.

Final report rules:
- Findings must be specific to this repository.
- Cite actual files, functions, flow names, or graph paths in evidence.
- summary.topConcern must name the actual hottest issue.
- summary.estimatedScaleCeiling should be specific.
- confidence must reflect how complete the graph-led investigation was.
- toolsUsed must list only tools actually called.

If time is running out, submit a partial but evidence-based report with finalReport.`;

// void SYSTEM_PROMPT;

const dbGraphSupportTools = [
    getDependenciesTool,
    getSchemaDefinitionsTool,
    checkConnectionPoolTool,
    getRepoTreeTool,
    searchCodeTool,
    getCodeBlockTool,
    finalReportTool,
];

// ─── Main Exported Function ───────────────────────────────────────────────────

export async function runDatabaseGraphAgent(
    input: DbAgentInput
): Promise<DbAgentOutput> {
    const { repositoryId, accessToken, archetypeScore, onEvent } = input;
    const startTime = Date.now();

    const agentLog: AgentLog = {
        repositoryId,
        archetypeScore,
        startTime: new Date().toISOString(),
        totalSteps: 0,
        steps: [],
    };
    let stepCounter = 0;
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let lastToolName = "unknown";
    let pendingDecisionReasoning: string | null = null;

    const emit = (event: StreamEvent) => {
        try { onEvent?.(event); } catch { /* ignore stream errors */ }
    };

    try {
        const repository = await findRepositoryByAnyId(repositoryId, {
            id: true,
            repositoryId: true,
            fullName: true,
            defaultBranch: true,
            graphStatus: true,
            graphBuiltAt: true,
        });

        if (!repository) {
            const errorMessage =
                `Repository "${repositoryId}" was not found by id or repositoryId.`;

            emit({
                type: "error",
                stepNumber: 0,
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMessage,
                cumulativeTokens: {
                    inputTokens: cumulativeInputTokens,
                    outputTokens: cumulativeOutputTokens,
                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                },
            });

            emit({
                type: "done",
                stepNumber: 0,
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                report: null,
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: errorMessage,
                cumulativeTokens: {
                    inputTokens: cumulativeInputTokens,
                    outputTokens: cumulativeOutputTokens,
                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                },
            });

            return {
                report: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: errorMessage,
            };
        }

        const [owner, repo] = repository.fullName.split("/");
        const branch = repository.defaultBranch ?? "main";
        const [graphNodeCount, graphFlowCount] = await Promise.all([
            prisma.codeNode.count({ where: { repositoryId: repository.id } }),
            prisma.codeFlow.count({ where: { repositoryId: repository.id } }),
        ]);

        if (graphNodeCount === 0) {
            const errorMessage =
                `Knowledge graph is not ready for repository "${repository.fullName}". ` +
                `graphStatus=${repository.graphStatus ?? "unknown"}, codeNodes=${graphNodeCount}, codeFlows=${graphFlowCount}.`;

            emit({
                type: "error",
                stepNumber: 0,
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMessage,
                cumulativeTokens: {
                    inputTokens: cumulativeInputTokens,
                    outputTokens: cumulativeOutputTokens,
                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                },
            });

            emit({
                type: "done",
                stepNumber: 0,
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                report: null,
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: errorMessage,
                cumulativeTokens: {
                    inputTokens: cumulativeInputTokens,
                    outputTokens: cumulativeOutputTokens,
                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                },
            });

            return {
                report: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: errorMessage,
            };
        }

        const dbGraphTools = [
            ...createKnowledgeGraphTools(prisma, repository.id),
            ...dbGraphSupportTools,
        ];

        console.log(`[dbGraphAgent] Starting investigation for: ${repositoryId}`);
        console.log(`[dbGraphAgent] Repo: ${repository.fullName} (${branch})`);
        console.log(`[dbGraphAgent] Archetype score: ${archetypeScore}`);
        console.log(
            `[dbGraphAgent] Graph status: ${repository.graphStatus ?? "unknown"}; ` +
            `nodes=${graphNodeCount}; flows=${graphFlowCount}`
        );

        emit({
            type: "agent_start",
            stepNumber: 0,
            timestamp: new Date().toISOString(),
            elapsedMs: 0,
            reasoning:
                `Starting graph-backed DB agent for ${repository.fullName} (${branch}). ` +
                `Archetype score: ${archetypeScore}. ` +
                `Graph nodes: ${graphNodeCount}, flows: ${graphFlowCount}.`,
        });

        const agent = createAgent({
            model: gpt5Mini,
            tools: dbGraphTools,
            systemPrompt: GRAPH_SYSTEM_PROMPT,
        });

        // NOTE: intermediateSteps and agentLog contain the raw accessToken
        // passed in the human message. These logs are for local debugging only.
        // Never persist agentLog to a database or external service.
        // Delete log files after debugging is complete.
        const result = await agent.invoke(
            {
                messages: [
                    {
                        role: "user",
                        content:
                            `Analyze the database layer of repository ${repositoryId}. ` +
                            `Owner: ${owner}. ` +
                            `Repo: ${repo}. ` +
                            `Branch: ${branch}. ` +
                            `Full name: ${repository.fullName}. ` +
                            `Legacy tools that ask for repositoryId should use ${repository.repositoryId}. ` +
                            `Knowledge graph repository row id: ${repository.id}. ` +
                            `Never pass the knowledge graph repository row id into legacy tools. ` +
                            `Knowledge graph status: ${repository.graphStatus ?? "unknown"}. ` +
                            `Knowledge graph built at: ${repository.graphBuiltAt?.toISOString() ?? "unknown"}. ` +
                            `Knowledge graph node count: ${graphNodeCount}. ` +
                            `Knowledge graph flow count: ${graphFlowCount}. ` +
                            `Access token: ${accessToken}. ` +
                            `Archetype score: ${archetypeScore} (0-1, higher means more DB heavy). ` +
                            `Analyze performance against these scale targets: 10k, 100k, 1M users. ` +
                            `Use the knowledge graph as your primary context source and only use non-graph tools for gaps the graph cannot answer. ` +
                            `When investigation is complete call finalReport with your findings.`,
                    },
                ],
            },
            {
                recursionLimit: 150,
                callbacks: [
                    {
                        handleAgentAction(action: any) {
                            stepCounter++;
                            const toolName = resolveCallbackToolName(action, action.tool);
                            lastToolName = toolName;
                            pendingDecisionReasoning =
                                typeof action.log === "string" && action.log.trim().length > 0
                                    ? action.log.trim()
                                    : null;
                            agentLog.steps.push({
                                stepNumber: stepCounter,
                                type: "decision",
                                timestamp: new Date().toISOString(),
                                toolName,
                                toolInput: action.toolInput,
                                reasoning: action.log,
                            });
                            console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                            console.log(`[Step ${stepCounter}] AGENT DECISION`);
                            console.log(`Tool: ${toolName}`);
                            console.log(`Reasoning: ${action.log}`);
                            console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                            if (pendingDecisionReasoning) {
                                emit({
                                    type: "agent_thought",
                                    stepNumber: stepCounter,
                                    timestamp: new Date().toISOString(),
                                    elapsedMs: Date.now() - startTime,
                                    toolName,
                                    reasoning: pendingDecisionReasoning,
                                    cumulativeTokens: {
                                        inputTokens: cumulativeInputTokens,
                                        outputTokens: cumulativeOutputTokens,
                                        totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                    },
                                });
                            }
                        },
                        handleToolStart(tool: any, input: string) {
                            const toolName = resolveCallbackToolName(tool, lastToolName);
                            lastToolName = toolName;
                            let parsedInput: unknown = input;
                            try {
                                parsedInput = JSON.parse(input);
                            } catch {
                                // keep raw string
                            }
                            console.log(`\n[Step ${stepCounter}] → Calling ${toolName}`);
                            console.log(`Input: ${JSON.stringify(parsedInput, null, 2).slice(0, 300)}`);

                            emit({
                                type: "tool_start",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                toolName,
                                toolInput: parsedInput,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                            pendingDecisionReasoning = null;
                        },
                        handleToolEnd(output: any) {
                            const outputStr: string =
                                typeof output === "string"
                                    ? output
                                    : JSON.stringify(output, null, 2) ?? "";
                            const lastDecisionStep = [...agentLog.steps]
                                .reverse()
                                .find((s) => s.type === "decision");
                            if (lastDecisionStep) {
                                lastDecisionStep.toolOutput =
                                    outputStr.length > 3000
                                        ? outputStr.slice(0, 3000) + "\n... [truncated]"
                                        : outputStr;
                            }
                            console.log(`[Step ${stepCounter}] ← Tool response: ${outputStr.length} chars`);
                            console.log(`Preview: ${outputStr.slice(0, 500)}`);

                            emit({
                                type: "tool_end",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                toolName: lastToolName,
                                toolOutput: outputStr.length > 5000
                                    ? outputStr.slice(0, 5000) + "\n... [truncated]"
                                    : outputStr,
                                toolOutputLength: outputStr.length,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },
                        handleLLMEnd(output: any) {
                            // Extract token usage from LangChain output metadata
                            const usage = output?.llmOutput?.tokenUsage
                                ?? output?.llmOutput?.usage
                                ?? output?.llmOutput?.estimatedTokenUsage
                                ?? null;

                            let inputTokens = 0;
                            let outputTokens = 0;
                            if (usage) {
                                inputTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0;
                                outputTokens = usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0;
                            }
                            cumulativeInputTokens += inputTokens;
                            cumulativeOutputTokens += outputTokens;

                            const generation = output.generations?.[0]?.[0];
                            const message = (generation as any)?.message;

                            // ── Extract reasoning text ──────────────────────────────
                            // With modern tool-calling models (GPT-4o-mini), the assistant
                            // message often contains content text ALONGSIDE tool_calls.
                            // This is the model "thinking out loud" before/while selecting tools.
                            // Previously we only captured content when there were NO tool_calls,
                            // which meant we missed all mid-investigation reasoning.
                            const content = String(message?.content ?? "").trim();
                            const hasFnCall = Boolean(message?.additional_kwargs?.function_call);
                            const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
                            const hasToolCallsAlt = Array.isArray(message?.additional_kwargs?.tool_calls) && message.additional_kwargs.tool_calls.length > 0;
                            const isSelectingTool = hasFnCall || hasToolCalls || hasToolCallsAlt;

                            if (content.length > 0) {
                                // Include reasoning whether or not a tool is also being called
                                const label = isSelectingTool
                                    ? `[selecting: ${message?.tool_calls?.[0]?.function?.name ?? message?.additional_kwargs?.function_call?.name ?? "tool"}]\n\n${content}`
                                    : content;

                                agentLog.steps.push({
                                    stepNumber: stepCounter,
                                    type: "agent_thought",
                                    timestamp: new Date().toISOString(),
                                    reasoning: label,
                                });
                                console.log(`[Step ${stepCounter}] Agent reasoning${isSelectingTool ? " (pre-tool)" : ""}: ${content.slice(0, 300)}`);

                                emit({
                                    type: "agent_thought",
                                    stepNumber: stepCounter,
                                    timestamp: new Date().toISOString(),
                                    elapsedMs: Date.now() - startTime,
                                    reasoning: label,
                                    toolName: isSelectingTool
                                        ? (message?.tool_calls?.[0]?.function?.name
                                            ?? message?.additional_kwargs?.function_call?.name
                                            ?? undefined)
                                        : undefined,
                                    cumulativeTokens: {
                                        inputTokens: cumulativeInputTokens,
                                        outputTokens: cumulativeOutputTokens,
                                        totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                    },
                                });
                            } else if (isSelectingTool) {
                                // No prose content, but we can still log the tool name selection
                                const toolName =
                                    message?.tool_calls?.[0]?.function?.name
                                    ?? message?.additional_kwargs?.function_call?.name
                                    ?? null;
                                if (toolName) {
                                    console.log(`[Step ${stepCounter}] Agent selecting tool: ${toolName} (no reasoning text)`);
                                }
                            }

                            // Always emit llm_end with token info
                            emit({
                                type: "llm_end",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                tokenUsage: {
                                    inputTokens,
                                    outputTokens,
                                    totalTokens: inputTokens + outputTokens,
                                },
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },
                        handleChainError(error: Error) {
                            agentLog.steps.push({
                                stepNumber: ++stepCounter,
                                type: "error",
                                timestamp: new Date().toISOString(),
                                reasoning: error.message,
                            });
                            agentLog.error = error.message;
                            console.log(`\n[dbGraphAgent] CHAIN ERROR: ${error.message}`);

                            emit({
                                type: "error",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                error: error.message,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },
                    },
                ],
            }
        );

        // Extract tool calls from message history
        const messages = result.messages ?? [];
        const toolMessages = messages.filter(
            (msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0
        );
        const totalToolCalls = toolMessages.length;

        // Find the finalReport tool call in messages
        let report: DbAgentReport | null = null;

        for (const msg of messages) {
            // Tool response messages carry the tool name and content
            if ((msg as any).role === "tool" && (msg as any).name === "finalReport") {
                try {
                    report = JSON.parse(
                        typeof (msg as any).content === "string"
                            ? (msg as any).content
                            : JSON.stringify((msg as any).content)
                    );
                } catch {
                    // Try next match
                }
            }
        }

        // Fallback: check tool_calls on assistant messages
        if (!report) {
            for (const msg of [...messages].reverse()) {
                const toolCalls = (msg as any).tool_calls ?? [];
                for (const tc of toolCalls) {
                    if (tc.name === "finalReport" && tc.args) {
                        try {
                            report = typeof tc.args === "string"
                                ? JSON.parse(tc.args)
                                : tc.args;
                        } catch {
                            // continue
                        }
                    }
                }
                if (report) break;
            }
        }

        const executionTimeMs = Date.now() - startTime;

        if (!report) {
            console.error(
                "[dbGraphAgent] Error: Agent completed without calling FINAL_REPORT"
            );
            return {
                report: null,
                intermediateSteps: messages,
                totalToolCalls,
                executionTimeMs,
                error:
                    "Agent completed without calling FINAL_REPORT. " +
                    "Check intermediate steps for partial investigation.",
            };
        }

        const { criticalCount, warningCount, infoCount } = report.summary;

        console.log(
            `[dbGraphAgent] Complete. ${criticalCount} critical, ${warningCount} warnings, ${infoCount} info`
        );
        console.log(`[dbGraphAgent] Execution time: ${executionTimeMs}ms`);

        // Finalize log
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.finalReport = report;

        // Write to JSON file
        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `db-graph-agent-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));

        console.log(`\n[dbAgent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[dbAgent] Full log written to:`);
        console.log(`[dbAgent] ${logPath}`);
        console.log(`[dbAgent] Total steps: ${stepCounter}`);
        console.log(`[dbAgent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

        // Emit done event with final totals
        emit({
            type: "done",
            stepNumber: stepCounter,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            report,
            totalToolCalls,
            executionTimeMs,
            cumulativeTokens: {
                inputTokens: cumulativeInputTokens,
                outputTokens: cumulativeOutputTokens,
                totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
            },
        });

        return {
            report,
            intermediateSteps: messages,
            totalToolCalls,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const message =
            error instanceof Error ? error.message : "Unknown error occurred";

        console.error(`[dbGraphAgent] Error: ${message}`);

        // Write partial error log so you can see what happened before the crash
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.error = message;

        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `db-graph-agent-ERROR-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));
        console.error(`[dbGraphAgent] Error log written to: ${logPath}`);

        emit({
            type: "done",
            stepNumber: stepCounter,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            report: null,
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
            cumulativeTokens: {
                inputTokens: cumulativeInputTokens,
                outputTokens: cumulativeOutputTokens,
                totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
            },
        });

        return {
            report: null,
            intermediateSteps: [],
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
        };
    }
}
