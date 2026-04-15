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
- Call list_flows with sortBy="dbCallCount", minDbCalls=1.
- The response includes: flowId, routeLabel (e.g. "POST /api/checkout/create-order"), priority (critical/high/medium/low), dbCallCount, hasN1Risk, getFlowHint.
- Build one ranked shortlist of 3-6 targets from top DB-heavy flows (highest dbCallCount).
- Prioritize: priority="critical" flows first, then priority="high". Ignore priority="low".
- Prioritize flows with hasN1Risk=true — these are the highest-risk targets.
- Remove admin/test/seed/migrate/debug/health/revalidate/utility-only items.

Phase 3:
- Maximum 8 graph investigation calls after the shortlist is chosen.
- ALWAYS use the flowId from list_flows output when calling get_flow — copy the getFlowHint value directly. Never construct a flowName from file paths.
- When get_flow returns steps with lineStart/lineEnd, use getCodeBlock(filePath, lineStart, lineEnd) to read just that function — NOT getFileContent for the whole file.
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
                                inputTokens  = usageMeta.input_tokens  ?? usageMeta.inputTokens  ?? 0;
                                outputTokens = usageMeta.output_tokens ?? usageMeta.outputTokens ?? 0;
                            } else if (legacyUsage) {
                                inputTokens  = legacyUsage.promptTokens     ?? legacyUsage.prompt_tokens     ?? legacyUsage.inputTokens  ?? legacyUsage.input_tokens  ?? 0;
                                outputTokens = legacyUsage.completionTokens ?? legacyUsage.completion_tokens ?? legacyUsage.outputTokens ?? legacyUsage.output_tokens ?? 0;
                            }
                            cumulativeInputTokens  += inputTokens;
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
