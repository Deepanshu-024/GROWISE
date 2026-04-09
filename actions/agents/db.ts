import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";
import { gpt5Mini } from "@/lib/llm";
import { getRepoTreeTool, searchCodeTool, getFileContentTool } from "../analysis/tools/agent-tools";
import { getDependenciesTool } from "../analysis/tools/getDependenciesTool";
import { buildImportFrequencyMapTool } from "../analysis/tools/buildImportFrequencyMapTool";
import { getSchemaDefinitionsTool } from "../analysis/tools/getSchemaDefinitionsTool";
import { checkConnectionPoolTool } from "../analysis/tools/checkConnectionPoolTool";
import { traceFunctionTool } from "../analysis/tools/traceFunctionTool";
import { resolveImportsTool } from "../analysis/tools/resolveImportsTool";

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

export interface DbAgentInput {
    repositoryId: string;
    accessToken: string;
    archetypeScore: number;
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

        console.log("[dbAgent] FINAL_REPORT received");

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

const dbAgentTools = [
    getDependenciesTool,
    buildImportFrequencyMapTool,
    getSchemaDefinitionsTool,
    checkConnectionPoolTool,
    traceFunctionTool,
    resolveImportsTool,
    getRepoTreeTool,
    searchCodeTool,
    getFileContentTool,
    finalReportTool,
];

// ─── Main Exported Function ───────────────────────────────────────────────────

export async function runDatabaseAgent(
    input: DbAgentInput
): Promise<DbAgentOutput> {
    const { repositoryId, accessToken, archetypeScore } = input;
    const startTime = Date.now();

    const agentLog: AgentLog = {
        repositoryId,
        archetypeScore,
        startTime: new Date().toISOString(),
        totalSteps: 0,
        steps: [],
    };
    let stepCounter = 0;

    console.log(`[dbAgent] Starting investigation for: ${repositoryId}`);
    console.log(`[dbAgent] Archetype score: ${archetypeScore}`);

    try {
        const agent = createAgent({
            model: gpt5Mini,
            tools: dbAgentTools,
            systemPrompt: SYSTEM_PROMPT,
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
                            `Access token: ${accessToken}. ` +
                            `Archetype score: ${archetypeScore} (0-1, higher means more DB heavy). ` +
                            `Analyze performance against these scale targets: 10k, 100k, 1M users. ` +
                            `Follow the investigation phases in your instructions. ` +
                            `When investigation is complete call FINAL_REPORT with your findings.`,
                    },
                ],
            },
            {
                recursionLimit: 150,
                callbacks: [
                    {
                        handleAgentAction(action: any) {
                            stepCounter++;
                            agentLog.steps.push({
                                stepNumber: stepCounter,
                                type: "decision",
                                timestamp: new Date().toISOString(),
                                toolName: action.tool,
                                toolInput: action.toolInput,
                                reasoning: action.log,
                            });
                            console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                            console.log(`[Step ${stepCounter}] AGENT DECISION`);
                            console.log(`Tool: ${action.tool}`);
                            console.log(`Reasoning: ${action.log}`);
                            console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        },
                        handleToolStart(tool: any, input: string) {
                            // LangChain serializes tool as { id: string[], name?: string }
                            // The actual tool name is the last element of the id array
                            const toolName: string =
                                tool.name ??
                                (Array.isArray(tool.id) ? tool.id[tool.id.length - 1] : undefined) ??
                                "unknown";
                            let parsedInput: unknown = input;
                            try {
                                parsedInput = JSON.parse(input);
                            } catch {
                                // keep raw string
                            }
                            console.log(`\n[Step ${stepCounter}] → Calling ${toolName}`);
                            console.log(`Input: ${JSON.stringify(parsedInput, null, 2).slice(0, 300)}`);
                        },
                        handleToolEnd(output: any) {
                            // output may be an object in newer LangChain versions — always coerce to string
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
                        },
                        handleLLMEnd(output: any) {
                            const generation = output.generations?.[0]?.[0];
                            const message = (generation as any)?.message;
                            const fnCall = message?.additional_kwargs?.function_call;
                            if (fnCall) {
                                console.log(`[Step ${stepCounter}] Agent selecting: ${fnCall.name}`);
                            } else {
                                const content = String(message?.content ?? "").trim();
                                if (content.length > 0) {
                                    agentLog.steps.push({
                                        stepNumber: stepCounter,
                                        type: "agent_thought",
                                        timestamp: new Date().toISOString(),
                                        reasoning: content.slice(0, 1000),
                                    });
                                    console.log(`[Step ${stepCounter}] Agent thought: ${content.slice(0, 300)}`);
                                }
                            }
                        },
                        handleChainError(error: Error) {
                            agentLog.steps.push({
                                stepNumber: ++stepCounter,
                                type: "error",
                                timestamp: new Date().toISOString(),
                                reasoning: error.message,
                            });
                            agentLog.error = error.message;
                            console.log(`\n[dbAgent] CHAIN ERROR: ${error.message}`);
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
                "[dbAgent] Error: Agent completed without calling FINAL_REPORT"
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
            `[dbAgent] Complete. ${criticalCount} critical, ${warningCount} warnings, ${infoCount} info`
        );
        console.log(`[dbAgent] Execution time: ${executionTimeMs}ms`);

        // Finalize log
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.finalReport = report;

        // Write to JSON file
        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `db-agent-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));

        console.log(`\n[dbAgent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`[dbAgent] Full log written to:`);
        console.log(`[dbAgent] ${logPath}`);
        console.log(`[dbAgent] Total steps: ${stepCounter}`);
        console.log(`[dbAgent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

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

        console.error(`[dbAgent] Error: ${message}`);

        // Write partial error log so you can see what happened before the crash
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.error = message;

        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `db-agent-ERROR-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));
        console.error(`[dbAgent] Error log written to: ${logPath}`);

        return {
            report: null,
            intermediateSteps: [],
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
        };
    }
}
