import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";
import { gpt4oMini } from "@/lib/llm";
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
- A partial report submitted on time beats a perfect report
  that never gets submitted because you hit the recursion limit

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

### 1B — Project type inference
Call getRepoTree with owner, repo, branch, accessToken.
Extract owner and repo from repository.fullName in the database.
Read the folder and file names carefully.

Infer the project type:

E-commerce signals:
  /products, /cart, /checkout, /orders, stripe, razorpay
  → Core flows: browse → product → cart → checkout
  → High traffic: home, product listing, product detail
  → Medium traffic: cart, user profile, order history
  → Low traffic: admin, analytics, export

SaaS / Dashboard signals:
  /dashboard, /analytics, /settings, /billing, /workspace
  → Core flows: login → dashboard → data interaction
  → High traffic: dashboard, data tables, API endpoints
  → Medium traffic: settings, team pages
  → Low traffic: billing, onboarding, admin

Social signals:
  /feed, /posts, /profile, /notifications, /messages
  → Core flows: feed → post → profile → interact
  → High traffic: feed, notifications, profile
  → Medium traffic: search, messages
  → Low traffic: settings, admin

API / Service signals:
  /api with no UI pages, webhook handlers
  → Every endpoint matters equally
  → High traffic: list, get, health endpoints
  → Medium traffic: create, update endpoints
  → Low traffic: delete, export, admin endpoints

Unknown / Mixed:
  → Note uncertainty
  → Treat all non-UI high import-count functions as high priority

Write down your project type before continuing.

---

## PHASE 2 — Build Import Frequency Map

Call buildImportFrequencyMap with repositoryId and accessToken.

This tool scans all .tsx and .jsx UI files and returns which
internal functions are imported and how many UI files use each.

When you receive results:
1. Read importedInUiFiles for each function
   Page names reveal traffic patterns directly
2. Note functions in core flow pages
3. Note functions ONLY in admin/settings pages — low priority
4. Note all server actions (isServerAction: true)

Do NOT investigate any functions yet.
Just understand what the UI actually uses.

---

## PHASE 3 — Filter + Contextual Re-ranking

This is the most critical phase. Do it carefully.
If you skip or rush this phase you will waste all your
traceFunctionTool calls on UI components with no DB calls.

### Step 3A — Remove non-DB functions FIRST

The frequency map contains UI components and utilities
that will NEVER make database calls. These always have the
highest import counts because they appear on every page.
You MUST remove them before ranking or you will investigate
Button and Card components instead of actual DB functions.

ALWAYS REMOVE from consideration — these never reach a database:

Remove by file location (check definedIn path):
→ Anything where definedIn contains: /components/ui/
→ Anything where definedIn contains: /ui/button
→ Anything where definedIn contains: /ui/card
→ Anything where definedIn contains: /ui/input
→ Anything where definedIn contains: cloudflare
→ Anything where definedIn contains: fpixel
→ Anything where definedIn contains: analytics
→ Anything where definedIn contains: tracking
→ Anything where definedIn contains: pixel
→ Anything where definedIn contains: sentry
→ Anything where definedIn contains: monitoring
→ Anything where definedIn is a pure utils file
   AND name is a single utility: cn, clsx, twMerge, formatDate

Remove by function name — these are always UI:
→ Button, Card, Input, Textarea, Badge, Dialog, Sheet,
  Modal, Drawer, Dropdown, Select, Checkbox, Radio,
  Switch, Toast, Alert, Avatar, Skeleton, Spinner,
  Loader, Tabs, Table, Form, Label, Separator,
  ScrollArea, Progress, Accordion, Popover, Tooltip
→ cn, clsx, twMerge, formatDate, formatPrice, formatCurrency
→ Any name that is clearly a React UI component
  (starts with capital letter AND is a visual element)

Remove React hooks that manage UI state only:
→ useCartContext — this is a React context consumer
→ useCart — UI state management
→ useModal, useTheme, useToast — UI only
→ Any hook where definedIn contains: /contexts/
→ Any hook where definedIn contains: /hooks/ AND
  the hook clearly manages UI state not data fetching

KEEP — these might make DB calls:
→ Functions from: src/lib/actions*.ts (server actions)
→ Functions from: src/app/api/**/route.ts (API routes)
→ Functions from: src/lib/*.ts EXCEPT pure utils
→ Functions from: src/services/*.ts
→ Functions from: src/db/*.ts
→ Functions from: src/server/*.ts

After filtering you should have a much smaller list.
If your list still has more than 20 entries:
→ Remove any remaining hooks that clearly manage UI state
→ Remove any remaining pure component names
→ Keep only functions that COULD reach a database

### Step 3B — Contextual re-ranking

Apply priority scoring to your FILTERED list only:

BASE SCORE = uiImportCount

MULTIPLY by context weight:
× 3.0 if imported from a core flow page
       (home, product, dashboard, feed, checkout)
× 1.5 if isServerAction: true
× 1.0 if imported from a regular page
× 0.3 if imported ONLY from admin/settings pages
× 0.1 if imported ONLY from error/404/loading pages

BOOST if:
+ imported from checkout/payment page
+ imported from root page.tsx
+ name contains: get, fetch, load, find, query, process

DEPRIORITIZE if:
- name contains: export, report, seed, migrate
- imported only from admin/settings/debug/test paths

Produce two lists and write them down explicitly:

INVESTIGATE LIST — max 7 functions, top scores only
SKIP LIST — everything else with reason

---

## PHASE 4 — Deep Dive Per Priority Function

CRITICAL CHECK before calling traceFunctionTool on ANY function:
Ask yourself: "Can this function possibly reach a database?"

If definedIn is in components/ui/ → SKIP immediately
If definedIn is a React context file → SKIP immediately
If definedIn is an image/analytics utility → SKIP immediately
If name is a UI component (Button, Card etc.) → SKIP immediately
If name is a React hook managing UI state only → SKIP immediately

Only call traceFunctionTool if the function genuinely
COULD reach a database based on its file path and name.
This check is mandatory before every single traceFunctionTool call.

For each function in INVESTIGATE LIST that passes the check:

Step A: Call traceFunction with direction "downstream"
  Extract:
  → Does this function make DB calls?
  → Are DB calls inside a loop? (N+1)
  → How many DB calls per invocation?
  → Does it have pagination on findMany?
  → Are there nested includes 3+ levels deep?

  If downstream returns ZERO DB calls:
  → Do NOT call upstream
  → Mark as "no DB calls — not relevant"
  → Move to next function immediately
  → This does NOT count toward your 7 call limit

Step B: Only if downstream found DB calls:
  Call traceFunction with direction "upstream"
  Extract:
  → Is this reachable from a public route?
  → Is it behind auth middleware?
  → Is it on core flow route or admin route?

Step C: Cross-reference with priority score:
  High priority + N+1 + public route = CRITICAL
  High priority + N+1 + auth required = WARNING
  Low priority + N+1 + public route = WARNING
  Low priority + any issue = INFO

Step D: Record finding with evidence:
  → Function name and file
  → Which UI pages trigger it
  → What DB calls it makes
  → Public or authenticated route
  → Specific scale issue
  → Estimated break point

HARD CONTROLS:
→ Maximum 7 traceFunctionTool calls total — absolute hard limit
→ If you reach 6 calls: stop Phase 4, go to Phase 5 immediately
→ If you find 3+ critical findings: stop Phase 4 immediately
→ Never call traceFunctionTool on SKIP LIST functions
→ Never call traceFunctionTool on UI components

---

## PHASE 5 — Schema + Connection Pool

Run this phase immediately after Phase 4.
Do not delay calling Phase 5 tools.

### 5A — Schema analysis
From the repo tree fetched in Phase 1:
Find schema files based on ORM from Phase 1:
  prisma    → *.prisma files
  typeorm   → *.entity.ts files
  mongoose  → *.model.ts or *.schema.ts files
  drizzle   → schema.ts in db/ or database/ folders
  sequelize → *.model.ts in models/ folder
  unknown   → schema.ts, models.ts, entities.ts

Call getSchemaDefinitions with:
  schemaFiles: identified schema file paths
  detectedOrm: from Phase 1
  detectedDatabase: from Phase 1

Cross-reference with Phase 4 findings:
→ For each DB call found: is the filtered column indexed?
→ For each FK: is the FK column indexed?
→ For each findMany: is the filtered column indexed?

### 5B — Connection pool analysis
Call searchCode for "PrismaClient"
Call searchCode for "mongoose.connect"
Call searchCode for "new Pool("
Look for .env.example in the repo tree.

Call checkConnectionPool with found files + env file.

Cross-reference with Phase 1:
  isServerless + no pooler + no singleton = CRITICAL
  isServerless + pooler detected = INFO only
  not serverless + no pool config = WARNING
  not serverless + explicit config = note it

---

## WHEN TO CALL FINAL REPORT

Call finalReport IMMEDIATELY when ANY of these is true:
→ Phase 5 is complete — this is the primary trigger
→ You have found 3+ critical findings
→ You have used 6 of your 7 traceFunctionTool calls
→ Your INVESTIGATE LIST had fewer than 3 functions
  and you investigated all of them

After Phase 5 is complete: call finalReport RIGHT AWAY.
Do NOT keep searching for more issues after Phase 5.
Do NOT re-investigate functions you already checked.
Do NOT call any tool after Phase 5 except finalReport.

If you feel uncertain whether to call finalReport:
→ Call it immediately.
→ A partial confident report is always better than timeout.
→ You can note low confidence in the confidence field.

---

## SEVERITY RULES

CRITICAL — will break under load:
→ N+1 query on a core flow public route
→ Unbounded findMany on a high priority function
→ Unindexed FK on a table queried by high priority functions
→ Serverless + no connection pooler + no singleton
→ Missing transaction on payment/order write operations

WARNING — will degrade under load:
→ N+1 on authenticated route only
→ Missing pagination on medium priority function
→ Unindexed timestamp/status column on core tables
→ Connection pool with no timeouts
→ Deeply nested includes 3+ levels on any priority function

INFO — worth noting but not urgent:
→ Raw SQL usage
→ Missing index on low priority function queries
→ Pool size potentially suboptimal
→ No soft delete strategy

DO NOT create findings for:
→ UI components or utility functions
→ Admin-only functions with no issues
→ Functions in SKIP LIST unless genuinely critical
→ Patterns that users never trigger

---

## SCALE TIER RULES

10k_users:
  CRITICAL findings on core flow = failure
  Multiple critical = failure
  Warnings only = degraded
  No issues = healthy

100k_users:
  Any CRITICAL = failure
  Multiple warnings on core flows = critical
  Single warnings = degraded
  No issues = healthy

1M_users:
  No caching layer + high DB load = failure
  Full table scans on large tables = critical
  Connection pool exhaustion = failure
  Minor issues only = degraded

---

## FINAL REPORT RULES

findings array:
→ Include ALL critical findings
→ Include warnings on high/medium priority functions
→ Include INFO sparingly — only if genuinely notable
→ Do NOT include findings for UI components
→ Do NOT include findings for SKIP LIST functions
   unless critical regardless of traffic

summary.topConcern:
→ Single most impactful issue for THIS project
→ Reference actual function name and page it comes from
→ Example: "CheckoutSession called from checkout page
   has DB write inside for...of loop — N+1 on every order"

summary.estimatedScaleCeiling:
→ Based on the most critical finding only
→ Be specific: "~500 concurrent users" not "low"

confidence:
→ 0.9+ if all high priority functions investigated
→ 0.7-0.9 if most covered but hit tool call limits
→ 0.5-0.7 if schema or pool analysis incomplete
→ below 0.5 only if major phases skipped

toolsUsed:
→ List every tool actually called
→ Do not list tools not called

---

## ABSOLUTE CONSTRAINTS

→ Maximum 7 traceFunctionTool calls — hard limit, never exceed
→ Never call traceFunctionTool on UI components
→ Never call traceFunctionTool on SKIP LIST functions
→ If downstream finds no DB calls: do NOT call upstream
→ Call finalReport immediately after Phase 5 — no exceptions
→ Never output prose as final answer — always use finalReport
→ The report must be specific to THIS project
→ If recursion limit is approaching: call finalReport NOW
   with whatever findings you have — partial is fine`;

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
            model: gpt4oMini,
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
