import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import { getRepoTreeTool, searchCodeTool, getFileContentTool, githubContextSchema } from "../analysis/tools/agent-tools";

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
    rawFindings?: string | null;
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
    rawFindings: string | null;
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

const SYSTEM_PROMPT = `You are an elite database scalability analyst specializing in React/Next.js applications. Your mission is to analyze GitHub repositories and surface the database-layer issues that will cause real failures as the business scales — not theoretical edge cases, but the patterns that break under traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js confirmed)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
🎯 **Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure — use it to identify targets before making any tool calls
- Make educated assumptions based on React/Next.js patterns
- Tool calls should be surgical, not exhaustive
- Maximum 8 tool calls total across all phases — spend them wisely

AVAILABLE TOOLS (Use Sparingly — repo details are injected automatically via context):
1. **getRepoTree()** - No input needed. Returns full project file tree (only if the tree in context is incomplete or truncated)
2. **getFileContent(path)** - Just pass the file path. For reading schema, ORM config, API routes, server actions
3. **searchCode(query)** - Just pass the search query. For locating patterns: PrismaClient, $transaction, findMany, N+1

---

## ANALYSIS FRAMEWORK — DATABASE SCALE SPECIALIST

---

### PHASE 1 — Stack & Project Understanding (No Tools)

**Step 1A — Infer the database stack from package.json:**

Extract and note:
- orm: prisma | drizzle | typeorm | mongoose | raw SQL
- database: postgresql | mysql | mongodb | sqlite
- framework: Next.js App Router | Pages Router
- isServerless: true if Next.js (Vercel deploys = ephemeral functions)
- cacheLayer: redis | memcached | NONE (from ioredis, upstash, etc.)
- authLibs: clerk | next-auth | supabase-auth | custom
- paymentLibs: stripe | razorpay | paddle | NONE

These directly shape severity of every finding:
→ No cache layer = every DB bottleneck hits harder
→ isServerless + no connection pooler = pool exhaustion guaranteed at scale
→ paymentLibs present = financial flows must be transactional
→ authLibs = session/user queries fire on every authenticated request

**Step 1B — Infer project type from root structure:**

Scan folder names in provided root content:
- E-commerce: /products, /cart, /checkout, /orders → core flows are browse → product → cart → checkout
- SaaS: /dashboard, /analytics, /billing, /workspace → core flows are login → dashboard → data interaction
- Social: /feed, /posts, /profile, /notifications → core flows are feed → post → profile → interact
- API Service: /api only → every endpoint matters equally
- Unknown: note uncertainty, assume all data routes are high-traffic

Write down stack summary and project type before continuing.

---

### PHASE 2 — Identify Investigation Targets (Minimal Tools)

**Step 2A — Determine architecture pattern from root structure:**

Infer from provided context first:
- App Router with route.ts files → API Routes pattern
- Files named actions.ts / paths containing /actions/ → Server Actions pattern
- Both present → Mixed pattern (most common in modern Next.js)

Only call **getRepoTree** if the root structure is ambiguous and you cannot determine the architecture pattern. Do not retry if it fails.

**Step 2B — Classify routes and actions by traffic priority:**

CRITICAL — financial and core write operations:
→ path contains: checkout, payment, order, purchase, confirm, verify-payment, create-order, razorpay, stripe, webhook

HIGH — core reads every user triggers constantly:
→ path contains: products, product, items, search, browse, categories, cart, user, profile, feed, home, dashboard, best-sellers, featured

MEDIUM — authenticated user actions triggered less frequently:
→ path contains: wishlist, reviews, address, coupon, settings, notifications, account

LOW — skip entirely:
→ path contains: admin, export, report, seed, migrate, debug, test, dummy

**Step 2C — Build your investigation list:**

Combine CRITICAL + top 3–4 HIGH items.
Skip MEDIUM and LOW unless they are the only items found.
Maximum 8 items total. Write the list explicitly before Phase 3.

---

### PHASE 3 — Deep File Analysis (Strategic Tool Calls)

For each item in your investigation list, use **getFileContent** to read the route handler or server action file.

**What to extract from each file:**

N+1 Queries — DB call inside a loop:
→ findMany/find followed by a .map() or for...of that makes another DB call
→ Example: fetching orders then fetching product details per order in a loop
→ At 1,000 concurrent users: 1,000 requests × N items = N,000 DB queries simultaneously

Unbounded Queries — findMany with no take/limit/skip:
→ SELECT * with no pagination on tables that grow indefinitely
→ Products, orders, users tables all grow — unbounded reads will eventually table-scan

Missing Transactions — multiple writes without wrapping:
→ Payment flows that do: create order → deduct inventory → charge card → update user
→ If step 3 fails, steps 1–2 already committed → data corruption at scale

Deeply Nested Includes — 3+ levels of eager loading:
→ include: { order: { items: { product: { category: true } } } }
→ Generates enormous JOINs — fine at 100 rows, catastrophic at 100,000

Expensive Aggregates — count/groupBy on unindexed columns:
→ COUNT(*) or SUM() on large tables with no index on the WHERE column
→ Dashboard analytics queries are the most common offender

**For server action files specifically:**
→ Use **searchCode** to find all files importing a high-frequency action
→ High import count = high traffic = higher severity for any issue found

**Severity assignment per finding:**

CRITICAL route + N+1 = CRITICAL
CRITICAL route + unbounded query = CRITICAL
HIGH route + N+1 = CRITICAL
HIGH route + missing pagination = WARNING
HIGH route + missing transaction on writes = CRITICAL (if financial)
MEDIUM route + any issue = WARNING
Any route + nested includes 3+ levels = WARNING

Stop investigating after finding 3 CRITICAL issues — you have enough for a complete report.

---

### PHASE 4 — Schema & Connection Pool Analysis (Targeted Tool Calls)

**Always run this phase. Never skip it.**

**Step 4A — Schema analysis:**

Use **getFileContent** to read the schema file.

Correct file paths by ORM:
- Prisma → prisma/schema.prisma (NOT src/lib/prisma.ts — that is the client)
- Drizzle → db/schema.ts or src/db/schema.ts (NOT drizzle.config.ts)
- TypeORM → *.entity.ts files (NOT the datasource config)
- Mongoose → *.model.ts or *.schema.ts (NOT the connection file)

Cross-reference with Phase 3 findings:
→ For every findMany with a WHERE clause: is that column indexed?
→ For every foreign key relationship found: is the FK column indexed?
→ For every ORDER BY pattern found: is the sort column indexed?
→ For high-traffic tables (products, orders, users): are status/timestamp columns indexed?

Missing indexes on high-traffic filter columns are silent until the table hits ~100k rows, then queries degrade from milliseconds to seconds.

**Step 4B — Connection pool analysis:**

Use **searchCode** to find "PrismaClient" (or equivalent ORM client instantiation).

What to look for:
- Is a singleton pattern used? (module-level client, not new Client() inside a function)
- Is a connection pooler referenced? (pgbouncer, prisma accelerate, supabase pooler in DATABASE_URL)
- Use **getFileContent** on .env.example if visible in tree to check DATABASE_URL for ?pgbouncer=true or pooler hostnames

Severity:
- isServerless + no singleton + no pooler = CRITICAL (new connection per request, exhausts DB at ~50 concurrent users)
- isServerless + singleton but no pooler = WARNING (module cache helps but not reliable across cold starts)
- isServerless + pooler confirmed = INFO (healthy)
- Not serverless + no pool config = WARNING
- Not serverless + explicit pool config = note it, no finding

---

### PHASE 5 — Synthesis & Scale Projection

Combine all findings and project scale ceilings:

**Scale tier definitions:**

10k users (light traffic, ~50–200 concurrent):
→ CRITICAL findings on core routes = service degradation
→ Warnings only = noticeable slowdowns, not failures
→ No issues = healthy

100k users (~500–2,000 concurrent):
→ Any CRITICAL finding = failure under load
→ Multiple warnings on core routes = cascading slowdowns
→ Single warnings = degraded but survivable
→ No issues = healthy

1M users (high scale, 10k+ concurrent):
→ No caching + high DB load = guaranteed failure
→ Full table scans on large tables = critical
→ Connection pool exhaustion = total outage
→ Well-indexed + pooled = degraded only on write bottlenecks

For each CRITICAL finding, state: "This breaks at approximately X concurrent users because..."
Be specific. Vague scale estimates are not useful.

---

## OUTPUT REQUIREMENTS

Deliver a comprehensive database scale analysis structured as:

1. **Executive Summary** (2–3 sentences: what will break first and at what scale)

2. **Stack Identification**
   - ORM, database, framework, serverless status, cache layer present/absent

3. **Critical Findings** (issues that will cause failures)
   - Each finding: location (file + function), specific pattern, estimated break point, fix

4. **Warning Findings** (issues that will degrade performance)
   - Each finding: location, pattern, scale at which degradation becomes user-visible

5. **Schema Analysis**
   - Missing indexes on high-traffic query patterns
   - Dangerous relationship patterns

6. **Connection Pool Assessment**
   - Current setup, risk level, recommendation

7. **Priority Fix Order**
   - Ranked list of what to fix first for maximum scale improvement

**Quality standards:**
- Be specific: name the file, the function, the exact pattern
- Quantify impact: "this query runs N+1 times per request — at 500 concurrent users that is 500×N simultaneous DB calls"
- Prioritize by traffic reality: a bug in /checkout matters 10× more than a bug in /admin/export
- Do not report findings for seed routes
- Focus entirely on what breaks the user experience under scale
- Do NOT estimate overall scale ceilings or breakpoints — the orchestrator agent will handle that

Remember: Tool efficiency is paramount. Make intelligent inferences from package.json and the file tree before reading files. Every tool call should answer a question you cannot answer from context alone.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const dbAgentTools = [
    getRepoTreeTool,
    searchCodeTool,
    getFileContentTool,
];

// ─── Main Exported Function ───────────────────────────────────────────────────

export async function runDatabaseAgent(
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
    let stepCounter = 0; // updated from langgraph_step metadata in callbacks
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let lastToolName = "unknown";
    let pendingDecisionReasoning: string | null = null;

    const emit = (event: StreamEvent) => {
        try { onEvent?.(event); } catch { /* ignore stream errors */ }
    };

    console.log(`[dbAgent] Starting investigation for: ${repositoryId}`);
    console.log(`[dbAgent] Archetype score: ${archetypeScore}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting DB agent for ${repositoryId} (archetype score: ${archetypeScore})`,
    });

    try {
        // ── Resolve repository metadata from DB ──────────────────────────
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [
                    { id: repositoryId },
                    { repositoryId: repositoryId },
                ],
            },
            select: {
                fullName: true,
                defaultBranch: true,
                packageJson: true,
                repoContent: true,
                framework: true,
            },
        });

        if (!repository || !repository.fullName) {
            return {
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: `Repository "${repositoryId}" not found in database. Run framework analysis first.`,
            };
        }

        const [owner, repo] = repository.fullName.split("/");
        const branch = repository.defaultBranch ?? "main";
        const framework = repository.framework ?? "unknown";
        const packageJsonStr = repository.packageJson
            ? JSON.stringify(repository.packageJson).slice(0, 3000)
            : "Not available";
        const repoContentStr = repository.repoContent
            ? JSON.stringify(repository.repoContent)
            : "Not available";

        console.log(`[dbAgent] Repo: ${repository.fullName} (${branch})`);

        // ── Create agent & invoke ────────────────────────────────────────
        const agent = createAgent({
            model: gpt5Mini,
            tools: dbAgentTools,
            systemPrompt: SYSTEM_PROMPT,
            contextSchema: githubContextSchema,
        });

        // NOTE: intermediateSteps and agentLog contain the raw accessToken
        // passed via context. These logs are for local debugging only.
        // Never persist agentLog to a database or external service.
        // Delete log files after debugging is complete.
        const result = await agent.invoke(
            {
                messages: [
                    {
                        role: "user",
                        content:
                            `Analyze the repository ${repository.fullName} for database scalability risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Archetype score: ${archetypeScore} (0-1, higher = more DB heavy)
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **N+1 Detection** — Find DB calls inside loops on high-traffic routes and actions
2. **Unbounded Query Detection** — Find findMany/SELECT calls with no pagination on growing tables
3. **Transaction Safety** — Identify multi-write flows (especially financial) with no transaction wrapper
4. **Index Gap Analysis** — Cross-reference query patterns against schema to find missing indexes
5. **Connection Pool Risk** — Assess whether the connection strategy survives serverless cold starts at scale

**Analysis Approach:**
- Start with the package.json and file tree provided above — identify API routes, schema files, and lib files immediately (Phase 1, no tools needed)
- Classify routes and actions by traffic priority before reading any files
- Use getFileContent(path) strategically on high-priority targets only
- Use searchCode(query) to validate patterns (singleton usage, transaction usage, import frequency)
- Read schema file once to cross-reference all query findings at once
- Tools already know the repo details — just pass the file path or search query

**Constraint:** Minimize tool usage — leverage the file tree and package.json above first, then make targeted tool calls only for confirmed high-traffic files.

Return your findings as your final message. Do not call any report tool.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, accessToken },
                recursionLimit: 40,
                callbacks: [
                    {
                        handleAgentAction(action: any, _runId: string, _parentRunId?: string, _tags?: string[], metadata?: Record<string, any>) {
                            // Use LangGraph's built-in step counter if available
                            if (metadata?.langgraph_step != null) {
                                stepCounter = metadata.langgraph_step;
                            } else {
                                stepCounter++;
                            }
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
                        handleToolStart(tool: any, input: string, _runId?: string, _parentRunId?: string, _tags?: string[], metadata?: Record<string, any>) {
                            if (metadata?.langgraph_step != null) {
                                stepCounter = metadata.langgraph_step;
                            }
                            const toolName = resolveCallbackToolName(tool, lastToolName);
                            lastToolName = toolName;
                            let parsedInput: unknown = input;
                            try {
                                parsedInput = JSON.parse(input);
                            } catch {
                                // keep raw string
                            }
                            console.log(`\n[Step ${stepCounter}/50] → Calling ${toolName}`);
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
                        handleLLMEnd(output: any, _runId?: string, _parentRunId?: string, _tags?: string[], metadata?: Record<string, any>) {
                            // Sync step counter from LangGraph metadata
                            if (metadata?.langgraph_step != null) {
                                stepCounter = metadata.langgraph_step;
                            }

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

                                    emit({
                                        type: "agent_thought",
                                        stepNumber: stepCounter,
                                        timestamp: new Date().toISOString(),
                                        elapsedMs: Date.now() - startTime,
                                        reasoning: content.slice(0, 2000),
                                        cumulativeTokens: {
                                            inputTokens: cumulativeInputTokens,
                                            outputTokens: cumulativeOutputTokens,
                                            totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                        },
                                    });
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
                            console.log(`\n[dbAgent] CHAIN ERROR: ${error.message}`);

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

        // ── Extract findings from the agent's final AI message ──────────
        const messages = result.messages ?? [];
        const toolMessages = messages.filter(
            (msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0
        );
        const totalToolCalls = toolMessages.length;

        // The agent returns its findings as the content of its last AI message
        const lastAiMessage = [...messages]
            .reverse()
            .find((msg: any) => msg._getType?.() === "ai" || msg.role === "assistant");

        const rawFindings: string =
            typeof lastAiMessage?.content === "string"
                ? lastAiMessage.content
                : JSON.stringify(lastAiMessage?.content ?? "");

        const executionTimeMs = Date.now() - startTime;

        if (!rawFindings || rawFindings.trim().length === 0) {
            console.error(
                "[dbAgent] Error: Agent completed without returning any findings"
            );
            return {
                rawFindings: null,
                intermediateSteps: messages,
                totalToolCalls,
                executionTimeMs,
                error:
                    "Agent completed without returning findings. " +
                    "Check intermediate steps for partial investigation.",
            };
        }

        console.log(
            `[dbAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`
        );
        console.log(`[dbAgent] Execution time: ${executionTimeMs}ms`);

        // Finalize log
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.finalReport = { rawFindings };

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

        // Emit done event with final totals
        emit({
            type: "done",
            stepNumber: stepCounter,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings,
            totalToolCalls,
            executionTimeMs,
            cumulativeTokens: {
                inputTokens: cumulativeInputTokens,
                outputTokens: cumulativeOutputTokens,
                totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
            },
        });

        return {
            rawFindings,
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

        emit({
            type: "done",
            stepNumber: stepCounter,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings: null,
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
            rawFindings: null,
            intermediateSteps: [],
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
        };
    }
}
