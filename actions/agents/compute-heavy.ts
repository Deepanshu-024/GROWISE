/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { createAgent } from "langchain";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import {
    searchCodeTool,
    getFileContentTool,
    githubContextSchema,
} from "../analysis/tools/agent-tools";

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
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
}

export interface ComputeHeavyAgentInput {
    repositoryId: string;
    accessToken: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface ComputeHeavyAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

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
    if (lower === "dynamicstructuredtool" || lower === "structuredtool") return null;
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

const SYSTEM_PROMPT = `You are an elite compute scalability analyst specializing in React/Next.js applications and backend code. Your mission is to analyze GitHub repositories and surface compute-heavy risks that will cause CPU saturation, memory pressure, long execution queues, request timeouts, or serverless function exhaustion as traffic and input sizes grow.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify likely compute hotspots before making tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read likely compute hotspots: API routes, server actions, workers, upload/image/PDF/CSV/video/AI processing, analytics, import/export, parsing, compression, encryption, report generation
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files. Choose compact repository-specific searches. Use at most 3 searches total.

---

## ANALYSIS FRAMEWORK - COMPUTE-HEAVY SCALE SPECIALIST

### NON-NEGOTIABLE SCOPE GATE - COMPUTE ONLY

Only investigate and report findings that directly affect CPU saturation, memory pressure, long execution queues, blocking execution, expensive algorithms, or missing offload/worker architecture for compute-heavy work.

Before reading a file, decide whether it is a compute target. A file is in scope only when it contains or configures one of these:
-> CPU-heavy work: image/video/audio processing, PDF generation/parsing, CSV/Excel import/export, compression, encryption, hashing, OCR, scraping/parsing, tree/code analysis, AST parsing, simulation, recommendation/ranking, analytics aggregation, report generation
-> Expensive algorithms: nested loops over growing data, all-pairs comparisons, recursive traversal over large trees, repeated sorting/filtering inside loops, unbounded in-memory transforms
-> Memory-heavy work: loading whole files/datasets into memory, buffering large request bodies, building huge arrays/maps/strings, base64 transforms for large files
-> Execution queue risks: synchronous processing inside request/route handlers, no background worker for long tasks, no concurrency limits, no chunking/batching/streaming
-> Parallelizability risks: independent tasks processed sequentially, no worker pool/queue, no batch partitioning, no timeout/cancellation boundary

Ignore and do not report non-compute findings, even if they are real issues:
-> Generic database missing indexes unless the query result is then processed with CPU-heavy logic
-> Payment correctness, authentication/session issues, generic validation, UI-only problems
-> Simple CRUD routes with no expensive local computation

If a possible issue is adjacent, ask: "Would fixing this reduce CPU saturation, memory pressure, long execution queues, or task timeout risk under larger inputs or 10x traffic?" If no, discard it silently.

### PHASE 1 - Compute Stack Understanding (No Tools)

Infer from package.json and file tree:
- computeLibraries: sharp | jimp | canvas | pdf-lib | pdfkit | puppeteer | playwright | cheerio | xlsx | csv | ffmpeg | bcrypt | crypto | tree-sitter | AI/embedding SDKs | NONE
- heavyFileTypes: image | video | audio | pdf | csv | xlsx | json | zip | code/tree | unknown
- executionModel: request path | server action | worker | queue | cron | script | unknown
- workerSupport: bull | bullmq | inngest | temporal | worker_threads | child_process | NONE
- memoryRiskSignals: upload, import, export, parse, transform, buffer, base64, readFile, JSON.parse
- taskDurationSignals: scrape, crawl, analyze, generate, render, process, batch, report

No compute-looking dependencies or files = report INFO and stop without tools.

### PHASE 2 - Identify Investigation Targets

Build a target list from package.json and file tree first.
Prefer files that are both user-triggered and compute-heavy:
- CRITICAL: upload/process, import/export, analyze, generate, render, scrape/crawl, parse, transcode, image/pdf/video/audio, embeddings, code analysis
- HIGH: analytics, report, sync, batch, worker, queue, job, cron
- MEDIUM: helper utilities used by critical/high paths
- LOW/SKIP: UI-only components, static pages, simple CRUD routes

Use searchCode only if the injected context is not enough to choose target files. Pick your own compact query based on repository signals. Do not run one search per keyword.
Read at most the highest-impact files first. Stop expanding when the failure mode is clear.

### PHASE 3 - Deep Compute Analysis

For each selected target, inspect:

CPU Saturation:
-> CPU-heavy work directly inside API routes/server actions
-> expensive loops, nested loops, repeated sort/filter/map over growing arrays, recursive traversal without bounds
-> synchronous crypto/compression/parsing/rendering in request path
-> no concurrency cap for expensive tasks

Memory Pressure:
-> loads entire files/datasets into memory
-> converts large data to base64/string/buffer unnecessarily
-> accumulates unbounded arrays/results before responding
-> no streaming/chunking for file import/export or report generation

Long Execution Queues:
-> long tasks run synchronously in web requests
-> no worker queue/background job for long-running work
-> independent tasks processed sequentially when parallelizable
-> no task timeout, cancellation, progress tracking, retry, or resume boundary

Time Complexity:
-> estimate whether core path is O(n), O(n log n), O(n^2), O(n*m), or worse
-> flag O(n^2)+ patterns on user/data-size-dependent inputs
-> flag repeated full scans inside loops

Parallelizability:
-> tasks are independent but processed serially
-> no worker pool, queue, batching, chunking, or concurrency limit
-> work cannot be resumed after failure

Task Duration Distribution:
-> identify if p95/p99 task duration grows with file size, row count, pages, records, images, or repository size
-> state what fails first at 10x traffic or 10x input size: CPU, memory, timeout, queue delay, or provider/serverless limit

### PHASE 4 - Synthesis

After finding 3 CRITICAL issues, stop expanding to optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

For every meaningful finding, answer: "What happens at 10x traffic or 10x input size?"

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report.
Do NOT include executive summary, stack recap, priority list, code snippets, or follow-up offers.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[CPU-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact compute pattern and why it fails.
Impact: max 1 sentence. Include what breaks at 10x traffic/input.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[CPU-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[CPU-3] Short title, max 10 words
File: path/to/file.ts or package/tree context
Evidence: max 1 sentence.

Severity definitions:
- CRITICAL: proven CPU saturation, memory exhaustion, request timeout, serverless timeout, unbounded execution queue, or O(n^2)+ work on user/data-size-dependent input.
- WARNING: proven compute scaling risk that degrades with traffic/input size but is not an immediate outage.
- INFO: useful context, healthy observations, or no compute-heavy surface found.

Compression rules:
- Report every distinct in-scope compute finding discovered. Drop non-compute findings silently.
- Merge only genuinely overlapping instances of the same root cause.
- Target 3-6 findings when possible.
- Sort by severity, then 10x impact.
- Each finding must preserve file, evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding.
- No markdown tables. No nested bullets. No long explanations.

When investigation is complete, output findings as the final message only.`;

const computeAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

export async function runComputeHeavyAgent(
    input: ComputeHeavyAgentInput
): Promise<ComputeHeavyAgentOutput> {
    const { repositoryId, accessToken, onEvent } = input;
    const startTime = Date.now();

    const agentLog: AgentLog = {
        repositoryId,
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

    console.log(`[computeAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting Compute-heavy agent for ${repositoryId}`,
    });

    try {
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [
                    { id: repositoryId },
                    { repositoryId },
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

        console.log(`[computeAgent] Repo: ${repository.fullName} (${branch})`);

        const agent = createAgent({
            model: gpt5Mini,
            tools: computeAgentTools,
            systemPrompt: SYSTEM_PROMPT,
            contextSchema: githubContextSchema,
        });

        const result = await agent.invoke(
            {
                messages: [
                    {
                        role: "user",
                        content:
                            `Analyze the repository ${repository.fullName} for compute-heavy scale risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

Primary objectives:
1. CPU saturation from expensive synchronous work
2. Memory pressure from large in-memory transforms
3. Long execution queues and request-path long tasks
4. Inefficient algorithms and time complexity on growing inputs
5. Parallelizability and lack of worker queues
6. Task duration distribution under 10x traffic or 10x input size

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest
- Decide yourself whether searchCode is needed; do not follow a preset search query
- Use package.json and file tree before tools
- If package.json and file tree show no compute-heavy surface, return INFO without tool calls

Scope constraint: Only report compute-heavy architecture risks: CPU saturation, memory pressure, blocking request-path work, long task queues, lack of worker queues, inefficient algorithms, and poor parallelizability. Ignore unrelated issues silently.

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers. If you are near the tool limit, stop using tools and synthesize from available evidence.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, accessToken },
                recursionLimit: 40,
                callbacks: [
                    {
                        handleAgentAction(action: any, _runId: string, _parentRunId?: string, _tags?: string[], metadata?: Record<string, any>) {
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
                            console.log("\n------------------------------------------");
                            console.log(`[Step ${stepCounter}] AGENT DECISION`);
                            console.log(`Tool: ${toolName}`);
                            console.log(`Reasoning: ${action.log}`);
                            console.log("------------------------------------------");
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

                            console.log(`\n[Step ${stepCounter}/50] -> Calling ${toolName}`);
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

                            console.log(`[Step ${stepCounter}] <- Tool response: ${outputStr.length} chars`);
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
                            if (metadata?.langgraph_step != null) {
                                stepCounter = metadata.langgraph_step;
                            }

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
                            console.log(`\n[computeAgent] CHAIN ERROR: ${error.message}`);

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

        const messages = result.messages ?? [];
        const toolMessages = messages.filter(
            (msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0
        );
        const totalToolCalls = toolMessages.length;

        const lastAiMessage = [...messages]
            .reverse()
            .find((msg: any) => msg._getType?.() === "ai" || msg.role === "assistant");

        const rawFindings: string =
            typeof lastAiMessage?.content === "string"
                ? lastAiMessage.content
                : JSON.stringify(lastAiMessage?.content ?? "");

        const executionTimeMs = Date.now() - startTime;

        if (!rawFindings || rawFindings.trim().length === 0) {
            console.error("[computeAgent] Error: Agent completed without returning any findings");
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

        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.finalReport = { rawFindings };

        console.log(
            `[computeAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`
        );
        console.log(`[computeAgent] Execution time: ${executionTimeMs}ms`);

        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `compute-agent-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));

        console.log("\n[computeAgent] ----------------------------------");
        console.log("[computeAgent] Full log written to:");
        console.log(`[computeAgent] ${logPath}`);
        console.log(`[computeAgent] Total steps: ${stepCounter}`);
        console.log("[computeAgent] ----------------------------------");

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

        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.error = message;

        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `compute-agent-ERROR-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));
        console.error(`[computeAgent] Error log written to: ${logPath}`);

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
