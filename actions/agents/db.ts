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

CRITICAL: Do NOT modify, guess, or retry with different owner/repo values.
If getRepoTree fails on the first attempt: skip it and proceed
to Phase 2. Do not retry getRepoTree more than once.

From the tree, identify:
1. Which architecture pattern this repo uses (see Phase 2)
2. The project type from folder/file names

Project type signals:
  E-commerce: /products, /cart, /checkout, /orders, stripe, razorpay
  SaaS: /dashboard, /analytics, /settings, /billing, /workspace
  Social: /feed, /posts, /profile, /notifications
  API Service: /api only, webhook handlers, no UI pages
  Unknown: note uncertainty, proceed carefully

Write down:
  a) Architecture pattern (determined in Phase 2)
  b) Project type
  c) Core user flows for this project type
before continuing.

---

## PHASE 2 — Identify Investigation Targets

This is the most important phase. The right approach depends
entirely on the architecture. Read the repo tree carefully
and choose ONE of the following approaches.

---

### APPROACH A — Next.js App Router / API Routes
USE THIS if you see: src/app/api/**/route.ts files

In this architecture UI pages call APIs via fetch() not imports.
The URL path tells you the traffic pattern directly.
Do NOT use buildImportFrequencyMap for this approach.

Step 1: Find all route.ts files from the repo tree.
Look for files matching this pattern: app/api/**/route.ts

Step 2: Classify each route by path:

CRITICAL priority — financial and core write operations:
→ path contains: checkout, payment, order, purchase,
                 confirm, verify-payment, create-order,
                 razorpay, stripe, webhook

HIGH priority — core read operations every user triggers:
→ path contains: products, product, items, item,
                 search, browse, categories, category,
                 cart, user, profile, feed, home,
                 best-sellers, new-arrivals, featured

MEDIUM priority — authenticated user actions:
→ path contains: wishlist, reviews, address, coupon,
                 settings, account, notifications

LOW priority — admin and utility routes:
→ path contains: admin, export, report, seed, migrate,
                 debug, test, dummy, upload (in admin path)

Step 3: Produce your investigation list:
  → All CRITICAL routes
  → Top 3-4 HIGH priority routes
  → Skip MEDIUM and LOW entirely

This is your INVESTIGATE LIST for Phase 4.
Maximum 7 routes total.

---

### APPROACH B — Server Actions (Next.js with use server)
USE THIS if you see: files with "use server" directive
AND very few or no API route files

In this architecture components call server actions directly.
Import frequency tells you the traffic pattern.

Call buildImportFrequencyMap with repositoryId and accessToken.

When you receive results:
FIRST remove these — they are never DB functions:
→ "prisma", "db", "client", "pool" — DB client instances
→ Any from cloudflare-images, r2-utils, fpixel, analytics
→ UI components: Button, Card, Input, etc.
→ Any from src/components/ui/

THEN rank remaining by uiImportCount:
→ 4+ imports from core pages = HIGH
→ 2-3 imports = MEDIUM  
→ 1 import = LOW

Produce INVESTIGATE LIST: top 5-7 non-UI functions only.

---

### APPROACH C — Express / Fastify / Custom Server
USE THIS if you see: express, fastify, hono, koa in dependencies
AND route files in: routes/, src/routes/, api/

Classify routes by path pattern same as Approach A.
Look for files in: routes/, src/routes/, controllers/
Identify route handlers and classify by URL pattern.

Produce INVESTIGATE LIST: CRITICAL + HIGH routes, max 7.

---

### APPROACH D — Mixed Architecture
USE THIS if you see BOTH API routes AND server actions

Do Approach A first for API routes.
Note any server actions separately.
Prioritize API routes over server actions in your list.

---

## PHASE 3 — Validate Investigation List

Before Phase 4, verify your INVESTIGATE LIST:

For each item ask:
"Will this function/route make database calls?"

REMOVE if:
→ It is an image/file upload route with no DB interaction
→ It is a pure UI utility (cloudflare images, r2 storage)
→ It is a health check or ping endpoint
→ The path suggests no data: /api/og, /api/revalidate

KEEP if:
→ Path suggests data reading: products, users, orders
→ Path suggests data writing: checkout, create, update
→ It is a financial operation: payment, order confirmation

Final list should be 3-7 items.
Write it down explicitly before Phase 4.

---

## PHASE 4 — Deep Dive Per Investigation Target

For each item in your INVESTIGATE LIST:

Step A: Call traceFunction with direction "downstream"
  functionName: the route handler function name OR
                the exported function name (GET, POST, etc.)
  filePath: the route file path
  direction: "downstream"

  Extract from result:
  → Does this make DB calls?
  → Are DB calls inside a loop? (N+1)
  → How many DB calls per invocation?
  → Does findMany have pagination (take/limit/skip)?
  → Are there nested includes 3+ levels deep?
  → Are multiple writes missing a transaction wrapper?

  If downstream returns ZERO DB calls:
  → Do NOT call upstream
  → Note "no DB calls found" and move on immediately
  → This does NOT count against your 7 call limit

Step B: Only if downstream found DB calls:
  Call traceFunction direction "upstream"
  Extract:
  → Is this on a public route or authenticated?
  → Is auth middleware present?

Step C: Assign severity:
  CRITICAL route + N+1 = CRITICAL finding
  CRITICAL route + unbounded findMany = CRITICAL finding
  HIGH route + N+1 = CRITICAL finding
  HIGH route + missing pagination = WARNING finding
  MEDIUM route + any issue = WARNING finding
  LOW route + any issue = INFO finding

Step D: Record finding with:
  → Route path and file
  → What DB calls it makes
  → The specific pattern issue
  → Estimated break point

HARD CONTROLS:
→ Maximum 7 traceFunctionTool calls — never exceed this
→ Stop Phase 4 after 6 calls regardless of list remaining
→ Stop Phase 4 if you find 3+ critical findings
→ Move immediately to Phase 5 when either limit is hit

---

## PHASE 5 — Schema + Connection Pool

Run this immediately after Phase 4.
Do not skip or delay this phase.

### 5A — Schema analysis

IMPORTANT: Find the correct schema file.
For Prisma: look for files ending in .prisma in the repo tree.
  The schema is at: prisma/schema.prisma
  NOT at: src/lib/prisma.ts (that is the client file)
  Passing prisma.ts returns 0 tables — always use schema.prisma

For TypeORM: *.entity.ts files — NOT the datasource config
For Mongoose: *.model.ts or *.schema.ts — NOT the connection file
For Drizzle: schema.ts in db/ folder — NOT drizzle.config.ts

Call getSchemaDefinitions with:
  schemaFiles: the correct schema file paths from above
  detectedOrm: from Phase 1
  detectedDatabase: from Phase 1

Cross-reference with Phase 4:
→ For each DB call found: is the filtered column indexed?
→ For each foreign key: is the FK column indexed?
→ For each findMany without pagination: is it bounded somehow?

### 5B — Connection pool

Call searchCode for "PrismaClient" to find connection files.
Look for .env.example in the repo tree.
Call checkConnectionPool with found connection files + env file.

Cross-reference with Phase 1:
  isServerless + no pooler + no singleton = CRITICAL
  isServerless + pooler detected = INFO
  not serverless + no explicit pool config = WARNING
  not serverless + explicit config = good, note it

---

## CALL FINAL REPORT NOW IF ANY OF THESE IS TRUE

→ Phase 5 is complete ← primary trigger, always call after Phase 5
→ You have found 3+ critical findings
→ You have used 6 of your 7 traceFunctionTool calls
→ Your investigation list had fewer than 3 items
  and you investigated all of them

After Phase 5 completes: call finalReport IMMEDIATELY.
Do NOT investigate more routes after Phase 5.
Do NOT re-run any tool you already ran.
Do NOT call any tool after Phase 5 except finalReport.

If uncertain whether to call finalReport: call it now.
Partial confident report > perfect report that times out.

---

## SEVERITY RULES

CRITICAL — will break under load:
→ N+1 on a CRITICAL or HIGH priority route
→ Unbounded findMany (no pagination) on HIGH priority route
→ Unindexed FK on a table used by CRITICAL/HIGH routes
→ Serverless + no connection pooler + no singleton pattern
→ Missing transaction on payment/order write operations

WARNING — will degrade under load:
→ N+1 on MEDIUM priority route
→ Missing pagination on MEDIUM priority route
→ Unindexed timestamp/status column on core tables
→ Connection pool with no timeouts configured
→ Deeply nested includes 3+ levels on any priority route

INFO — worth noting:
→ Raw SQL usage
→ Missing index on LOW priority route queries
→ Pool size potentially suboptimal
→ No soft delete strategy

DO NOT create findings for:
→ LOW priority admin routes unless truly critical
→ Routes not in your investigation list
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
  No caching layer + high DB load = failure
  Full table scans on large tables = critical
  Connection pool exhaustion = failure
  Minor issues only = degraded

---

## FINAL REPORT RULES

findings:
→ Include ALL critical findings
→ Include warnings on HIGH/MEDIUM priority routes
→ Include INFO sparingly
→ Do NOT include findings for LOW priority routes
  unless they are genuinely critical

summary.topConcern:
→ Most impactful issue for THIS specific project
→ Name the actual route and the actual issue
→ Example: "POST /api/checkout/confirm-order has DB
   write inside for...of loop — N+1 on every order
   confirmation, will break at ~500 concurrent checkouts"

summary.estimatedScaleCeiling:
→ Based on most critical finding only
→ Specific: "~500 concurrent users" not "low"

confidence:
→ 0.9+ if all CRITICAL + HIGH routes investigated
→ 0.7-0.9 if most covered but hit limits
→ 0.5-0.7 if schema or pool incomplete
→ below 0.5 only if major phases skipped

toolsUsed:
→ Only list tools you actually called

---

## ABSOLUTE CONSTRAINTS

→ Maximum 7 traceFunctionTool calls — never exceed
→ Never retry getRepoTree more than once
→ Call finalReport immediately after Phase 5
→ Never output prose as final answer
→ If recursion limit approaching: call finalReport NOW
→ The report must be specific to THIS project`;

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
