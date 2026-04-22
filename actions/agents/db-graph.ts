/* eslint-disable @typescript-eslint/no-explicit-any */

import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import { getRepoTreeTool, searchCodeTool, getCodeBlockTool, githubContextSchema } from "../analysis/tools/agent-tools";
import { getDependenciesTool } from "../analysis/tools/getDependenciesTool";
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
        normalizeToolName(tool?.bound?.name) ??          // RunnableBinding wraps the real tool here
        normalizeToolName(tool?.lc_kwargs?.bound?.name) ?? // nested binding
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


// ─── Tools ────────────────────────────────────────────────────────────────────

const GRAPH_SYSTEM_PROMPT = `You are an elite Database Layer Analyst specializing in Next.js / Node.js backends. Your mission is to identify concrete, evidence-backed database issues in this repository by strategically combining a pre-built knowledge graph with targeted code reads.

This report will serve as the FACTUAL FOUNDATION for a later scalability analysis stage. Every finding you produce must be real — observed from actual code, not inferred from patterns alone.

═══════════════════════════════════════════════════════════════
TOOL PHILOSOPHY — READ BEFORE CALLING ANY TOOL
═══════════════════════════════════════════════════════════════
🎯 Use the knowledge graph as your PRIMARY source. It was built by statically analyzing every file.
📌 Only fall back to GitHub tools (getCodeBlock, searchCode) when:
   - The graph returns a step with lineStart/lineEnd you need to confirm
   - You need to verify a specific keyword ($transaction, take:, findMany in loop)
⛔ Never call the same tool with the same arguments twice.
⛔ Never fabricate findings. If evidence is incomplete, say so and lower confidence.

GRAPH TOOLS (prefer these):
  get_graph_stats       — repo-level summary: node count, edge count, flow count
  list_flows            — ranked list of DB-touching flows (sorted by dbCallCount) — YOUR MAIN TRIAGE TOOL
  get_flow              — full step-by-step trace of one flow with file + line references
  get_function_callers  — who calls a given function
  get_function_callees  — what a function calls
  get_file_summary      — lightweight summary of one file's functions and DB calls
  query_graph           — raw graph query: callers_of, callees_of, file_summary, impact
  get_route_call_chain  — route handler → full callee chain in one call

NON-GRAPH TOOLS (use sparingly — repo details are injected via context, no need to pass owner/repo/branch/accessToken):
  getDependencies       — ORM, auth, payment, cache libs from package.json
  getRepoTree           — find schema file path (call ONCE in Phase 1, no input needed)
  searchCode            — confirm specific token presence in a known hot file (just pass query)
  getCodeBlock          — read exact lines from a file (just pass filePath + lineStart + lineEnd)
  finalReport           — submit the completed report (call EXACTLY ONCE at the end)

═══════════════════════════════════════════════════════════════
HARD RULES — VIOLATIONS WASTE TOKENS AND PRODUCE BAD REPORTS
═══════════════════════════════════════════════════════════════
1. COMPLETE Phase N before starting Phase N+1. Never go backwards.
2. Never call get_flow on the same flowId twice.
3. Never call getRepoTree more than once.
4. Never call get_critical_flows — list_flows already provides the same data with better fields.
5. After Phase 4, call finalReport immediately. No more investigation.

═══════════════════════════════════════════════════════════════
INVESTIGATION PHASES
═══════════════════════════════════════════════════════════════

## Phase 1 — CONTEXT GATHERING (3 calls max: getDependencies + get_graph_stats + getRepoTree)
1. Call getDependencies(repositoryId) → extract: ORM, DB driver, cache layer presence, serverless indicators.
2. Call get_graph_stats → extract: node count, edge count, flow count.
3. Call getRepoTree ONCE → extract ONLY: schema file path (e.g. prisma/schema.prisma) and DB connection file path (e.g. src/lib/prisma.ts). Ignore everything else in the tree output.
4. From these three calls, note:
   - No cache layer? → hot read findings become more severe
   - Serverless? → pool/singleton findings become critical
   - ORM = Prisma? → look for findMany, $transaction, include patterns

## Phase 2 — FLOW TRIAGE (1 call: list_flows, then THINK before acting)
1. Call list_flows(sortBy="dbCallCount", minDbCalls=1, limit=20).
2. Read ALL flows returned before selecting any for investigation.

### HARD EXCLUSIONS — Auto-Skip These Flows:
Any flow whose routeLabel or entryPointQn contains:
  ⛔ webhook, clerk, stripe, svix, razorpay → external service callbacks, NOT user-load paths
  ⛔ auth, sign-in, sign-up, session, callback → auth agent's responsibility
  ⛔ admin, seed, migrate, debug, health, cron, revalidate, test → low-traffic internal
Example: A flow "POST /api/webhooks/clerk" with dbCallCount=5 → SKIP. It fires on Clerk events, not user requests.

### MINIMUM THRESHOLDS — Skip Tiny Flows:
  ⛔ Skip any flow with nodeCount < 5 — it is a thin wrapper, not a real data path
  ⛔ Skip any flow with fileCount < 2 — it never leaves one file, too shallow to analyze

### Flow Selection — Score Remaining Candidates On:
  **BREADTH**: nodeCount + fileCount + depth (higher = more complex, multi-layer data path)
  **TRAFFIC**: Is this a user-facing page/API? (product, checkout, cart, feed, search, dashboard = high)

### ⚠️ MANDATORY: Write Your Selection Before Investigating
Before calling ANY get_flow, you MUST write your reasoning in exactly this format:

  SHORTLIST:
  1. [routeLabel] — nodeCount=X, fileCount=Y, dbCallCount=Z — Selected because: [1 sentence]
  2. [routeLabel] — nodeCount=X, fileCount=Y, dbCallCount=Z — Selected because: [1 sentence]
  3. [routeLabel] — ...
  4. [routeLabel] — ...
  SKIPPED: [webhook flows, auth flows, tiny flows — name them and state why]

Only AFTER writing this shortlist may you proceed to Phase 3. If fewer than 4 flows pass the filters, investigate what you have — do not lower your standards to fill the list.

## Phase 3 — DEEP INVESTIGATION (max 6 get_flow + getCodeBlock calls total)
For each shortlisted flow:
- Call get_flow(flowId) ONCE per flow — copy the getFlowHint from list_flows verbatim.
- Examine the steps returned. When a step has lineStart/lineEnd → call getCodeBlock for that function.
- Look for:
  ✦ N+1: findMany/findUnique called inside a loop or called once per item in a list
  ✦ Missing pagination: findMany with no take/skip/limit/cursor
  ✦ Fan-out: one request triggers 5+ separate DB queries across the step list
  ✦ Missing transaction: multi-table writes (create + update + create) without $transaction
  ✦ Unbounded reads: a high-traffic page loading all records without limits
- Use searchCode ONLY for confirming a specific keyword in a specific file — not for broad discovery.
- Stop investigating a flow the moment you have enough evidence for one concrete finding.

## Phase 4 — SCHEMA & CONNECTION AUDIT (2 getCodeBlock calls max)
You already know the schema file path (e.g. prisma/schema.prisma) and the DB connection file path (e.g. src/lib/prisma.ts) from Phase 1's getRepoTree output. Do NOT call getRepoTree again.

1. Read the SCHEMA file with getCodeBlock(filePath=<schema path>, lineStart=1, lineEnd=500) → analyze the raw schema yourself:
   - Check every relation field — does the model have a corresponding @@index on the foreign key column?
   - Cross-reference with hot flows from Phase 3: columns used as filters/sorts in those flows — are they indexed?
   - Look for models with many relations but no composite indexes

2. Read the CONNECTION file with getCodeBlock(filePath=<connection path>, lineStart=1, lineEnd=100) → analyze the raw code yourself:
   - Is there a singleton/global pattern? (e.g. \`globalThis.prisma ??= new PrismaClient()\`)
   - Are pool size limits configured? (look for: connection_limit, pool_size, PgBouncer URL params)
   - Is Prisma Accelerate or a connection pooler URL used? (look for: prisma://accelerate, ?pgbouncer=true)
   - Serverless + no singleton + no pooler = CRITICAL finding

After Phase 4 → call finalReport IMMEDIATELY. Do not go back to Phase 3.

═══════════════════════════════════════════════════════════════
FINDING SEVERITY RULES
═══════════════════════════════════════════════════════════════
CRITICAL  — Will cause failures at production scale:
  • N+1 or fan-out DB calls on a checkout/order/payment/product flow
  • Unindexed foreign key or filter column on a high-traffic table
  • Serverless + no pooler + no singleton (connection exhaustion)
  • Multi-write flow with no transaction protection

WARNING   — Will degrade under load:
  • Unbounded findMany (no pagination) on a user-facing endpoint
  • Hot read path with no cache and heavy DB fan-out
  • Missing pool limits on a high-traffic app

INFO      — Lower-confidence or low-frequency risk:
  • Potential but unconfirmed N+1
  • Suboptimal index on a non-critical table

═══════════════════════════════════════════════════════════════
FINAL REPORT REQUIREMENTS
═══════════════════════════════════════════════════════════════
Call finalReport once with 4–5 findings. Each finding MUST:

✅ Be SPECIFIC — named file, function name, flow route
✅ Cite EVIDENCE — file path + function + line range from get_flow/getCodeBlock
✅ NOT be generic — "consider adding Redis" is NOT a finding
✅ Have severity: CRITICAL | WARNING | INFO
✅ Include a brief recommendation (1–2 sentences max)

Example of a GOOD finding:
  title: "N+1 Query in POST /api/checkout/create-order"
  evidence: "get_flow shows fetchCartItems() at checkout/route.ts:L45 calls prisma.product.findUnique inside a loop (nodeCount=12, dbCallCount=8)"
  severity: CRITICAL
  recommendation: "Batch with prisma.product.findMany({ where: { id: { in: ids } } }) before the loop"

Example of a BAD finding (DO NOT DO THIS):
  title: "Consider adding Redis cache"
  evidence: "getDependencies shows no cache layer"
  severity: WARNING
  recommendation: "Add Redis"

summary.topConcern    — name the actual hottest finding (specific route + issue)
summary.confidence    — low / medium / high (reflect how much code evidence you gathered)
toolsUsed             — list only tools actually called during this run

If investigation is incomplete → submit partial report with lower confidence. Never invent findings to fill slots.`;

// void SYSTEM_PROMPT;

const dbGraphSupportTools = [
    getDependenciesTool,
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
            contextSchema: githubContextSchema,
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
                            `Analyze the database layer of repository ${repository.fullName}. ` +
                            `Legacy tools that ask for repositoryId should use ${repository.repositoryId}. ` +
                            `Knowledge graph repository row id: ${repository.id}. ` +
                            `Never pass the knowledge graph repository row id into legacy tools. ` +
                            `Knowledge graph status: ${repository.graphStatus ?? "unknown"}. ` +
                            `Knowledge graph built at: ${repository.graphBuiltAt?.toISOString() ?? "unknown"}. ` +
                            `Knowledge graph node count: ${graphNodeCount}. ` +
                            `Knowledge graph flow count: ${graphFlowCount}. ` +
                            `Archetype score: ${archetypeScore} (0-1, higher means more DB heavy). ` +
                            `Analyze performance against these scale targets: 10k, 100k, 1M users. ` +
                            `Tools already know the repo owner, name, branch, and access token — no need to pass them. ` +
                            `Use the knowledge graph as your primary context source and only use non-graph tools for gaps the graph cannot answer. ` +
                            `When investigation is complete call finalReport with your findings.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, accessToken },
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
                            try { parsedInput = JSON.parse(input); } catch { /* keep raw */ }

                            // ── Clean log ─────────────────────────────────────────────
                            const inputPreview = JSON.stringify(parsedInput, null, 2).slice(0, 400);
                            console.log([
                                `\n┌─ STEP #${stepCounter} ─ TOOL CALL ─────────────────────────`,
                                `│  Tool   : ${toolName}`,
                                `│  Tokens : ${(cumulativeInputTokens + cumulativeOutputTokens).toLocaleString()} total (↑${cumulativeInputTokens.toLocaleString()} in / ↓${cumulativeOutputTokens.toLocaleString()} out)`,
                                `│  Input  :`,
                                inputPreview.split("\n").map(l => `│    ${l}`).join("\n"),
                                `└─────────────────────────────────────────────────────`,
                            ].join("\n"));

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
                            // Extract the actual string content from LangChain's ToolMessage wrapper.
                            // When output is a serialized ToolMessage object {lc:1, kwargs:{content:"..."}},
                            // we want only the inner content string — not the whole object.
                            let rawContent: string;
                            if (typeof output === "string") {
                                rawContent = output;
                            } else if (typeof output?.kwargs?.content === "string") {
                                rawContent = output.kwargs.content; // LangChain ToolMessage serialized
                            } else if (typeof output?.content === "string") {
                                rawContent = output.content;         // ToolMessage direct
                            } else {
                                rawContent = JSON.stringify(output, null, 2) ?? "";
                            }
                            const lastDecisionStep = [...agentLog.steps]
                                .reverse()
                                .find((s) => s.type === "decision");
                            if (lastDecisionStep) {
                                lastDecisionStep.toolOutput =
                                    rawContent.length > 3000
                                        ? rawContent.slice(0, 3000) + "\n... [truncated]"
                                        : rawContent;
                            }

                            // Pretty-print JSON output
                            let humanOutput = rawContent;
                            if (rawContent.trim().startsWith("{") || rawContent.trim().startsWith("[")) {
                                try { humanOutput = JSON.stringify(JSON.parse(rawContent), null, 2); } catch { /* keep raw */ }
                            }

                            // ── Clean log ─────────────────────────────────────────────
                            const outputPreview = humanOutput.slice(0, 400);
                            console.log([
                                `│  Output : (${rawContent.length.toLocaleString()} chars)`,
                                outputPreview.split("\n").map((l: string) => `│    ${l}`).join("\n"),
                                humanOutput.length > 400 ? `│    … [${(humanOutput.length - 400).toLocaleString()} more chars]` : "",
                                `└─────────────────────────────────────────────────────`,
                            ].filter(Boolean).join("\n"));

                            emit({
                                type: "tool_end",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                toolName: lastToolName,
                                toolOutput: humanOutput.length > 5000
                                    ? humanOutput.slice(0, 5000) + "\n... [truncated]"
                                    : humanOutput,
                                toolOutputLength: rawContent.length,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },
                        handleLLMEnd(output: any) {
                            const generation = output.generations?.[0]?.[0];
                            const message = (generation as any)?.message;

                            // Token usage — standard format (usage_metadata) then legacy fallback
                            const usageMeta = message?.usage_metadata ?? null;
                            const legacyUsage = output?.llmOutput?.tokenUsage
                                ?? output?.llmOutput?.usage
                                ?? output?.llmOutput?.estimatedTokenUsage
                                ?? null;

                            let inputTokens = 0;
                            let outputTokens = 0;
                            if (usageMeta) {
                                inputTokens = usageMeta.input_tokens ?? usageMeta.inputTokens ?? 0;
                                outputTokens = usageMeta.output_tokens ?? usageMeta.outputTokens ?? 0;
                            } else if (legacyUsage) {
                                inputTokens = legacyUsage.promptTokens ?? legacyUsage.prompt_tokens ?? legacyUsage.inputTokens ?? legacyUsage.input_tokens ?? 0;
                                outputTokens = legacyUsage.completionTokens ?? legacyUsage.completion_tokens ?? legacyUsage.outputTokens ?? legacyUsage.output_tokens ?? 0;
                            }
                            cumulativeInputTokens += inputTokens;
                            cumulativeOutputTokens += outputTokens;

                            // Tool name(s) from standard LangChain AIMessage format
                            const resolveOneName = (tc: any): string | null =>
                                tc?.name ?? tc?.function?.name ?? null;

                            const stdToolCalls: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
                            const altToolCalls: any[] = Array.isArray(message?.additional_kwargs?.tool_calls) ? message.additional_kwargs.tool_calls : [];
                            const hasFnCall = Boolean(message?.additional_kwargs?.function_call);
                            const isSelectingTool = stdToolCalls.length > 0 || altToolCalls.length > 0 || hasFnCall;

                            const uniqueToolNames = [...new Set([
                                ...stdToolCalls.map(resolveOneName),
                                ...altToolCalls.map(resolveOneName),
                                message?.additional_kwargs?.function_call?.name ?? null,
                            ].filter(Boolean) as string[])];
                            const primaryToolName = uniqueToolNames[0] ?? null;
                            const toolNamesLabel = uniqueToolNames.join(", ") || "tool";

                            // Store in lastToolName so handleToolStart can fall back to it
                            if (primaryToolName) lastToolName = primaryToolName;

                            // Reasoning text
                            const content = String(message?.content ?? "").trim();

                            if (content.length > 0) {
                                const label = isSelectingTool
                                    ? `[→ ${toolNamesLabel}]\n\n${content}`
                                    : content;

                                // ── Clean log ─────────────────────────────────────────
                                console.log([
                                    `\n┌─ STEP #${stepCounter} ─ REASONING ──────────────────────────`,
                                    isSelectingTool ? `│  Selecting: ${toolNamesLabel}` : "",
                                    `│  Tokens   : +${inputTokens.toLocaleString()} in / +${outputTokens.toLocaleString()} out  (Σ ${(cumulativeInputTokens + cumulativeOutputTokens).toLocaleString()})`,
                                    `│  Reasoning:`,
                                    content.slice(0, 300).split("\n").map(l => `│    ${l}`).join("\n"),
                                    content.length > 300 ? `│    … [${content.length - 300} more chars]` : "",
                                    `└─────────────────────────────────────────────────────`,
                                ].filter(Boolean).join("\n"));

                                agentLog.steps.push({
                                    stepNumber: stepCounter,
                                    type: "agent_thought",
                                    timestamp: new Date().toISOString(),
                                    reasoning: label,
                                });
                                emit({
                                    type: "agent_thought",
                                    stepNumber: stepCounter,
                                    timestamp: new Date().toISOString(),
                                    elapsedMs: Date.now() - startTime,
                                    reasoning: label,
                                    toolName: primaryToolName ?? undefined,
                                    cumulativeTokens: {
                                        inputTokens: cumulativeInputTokens,
                                        outputTokens: cumulativeOutputTokens,
                                        totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                    },
                                });
                            } else if (isSelectingTool && primaryToolName) {
                                // No prose — just log the selection and tokens
                                console.log([
                                    `\n┌─ STEP #${stepCounter} ─ SELECTING ──────────────────────────`,
                                    `│  Tool   : ${toolNamesLabel}`,
                                    `│  Tokens : +${inputTokens.toLocaleString()} in / +${outputTokens.toLocaleString()} out  (Σ ${(cumulativeInputTokens + cumulativeOutputTokens).toLocaleString()})`,
                                    `└─────────────────────────────────────────────────────`,
                                ].join("\n"));
                            }

                            emit({
                                type: "llm_end",
                                stepNumber: stepCounter,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                tokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
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
