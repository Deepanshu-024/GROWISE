/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAgent } from "langchain";
import {
    createToolBudgetMiddleware,
    resolveCallbackToolName,
} from "./agent-middleware";
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

export interface RealtimeAgentInput {
    repositoryId: string;
    installationId: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface RealtimeAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}



const SYSTEM_PROMPT = `You are an elite realtime scalability analyst specializing in React/Next.js applications and backend realtime systems. Your mission is to analyze GitHub repositories and surface realtime risks that will cause WebSocket connection exhaustion, message fan-out overload, dropped messages, stale client state, or state synchronization failures as concurrent users and messages per second grow.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify realtime targets before making tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read likely realtime hotspots: websocket/socket routes, SSE routes, pub/sub config, presence/state sync code, chat/collaboration/notifications/live dashboard files
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files. Choose compact repository-specific searches. Use at most 3 searches total. **EARLY EXIT RULE: if 2 consecutive searchCode calls return 0 results, stop all further searchCode usage immediately and fall back to navigating the file tree with getFileContent. Do not try alternative keywords or rephrased queries.**

---

## ANALYSIS FRAMEWORK - REALTIME SCALE SPECIALIST

### NON-NEGOTIABLE SCOPE GATE - REALTIME ONLY

Only investigate and report findings that directly affect realtime connections, message fan-out, pub/sub delivery, backpressure, presence, live state synchronization, reconnect/replay behavior, or dropped realtime messages.

Before reading a file, decide whether it is a realtime target. Use the injected package.json dependencies and repository file tree to discover which realtime libraries and patterns the project actually uses — do not rely on a fixed checklist. A file is in scope when the package.json contains a realtime-related dependency (e.g., socket.io, ws, pusher, ably, supabase realtime channels, firebase realtime/firestore listeners, liveblocks, partykit, convex, or any other library whose primary purpose is live bidirectional or push-based communication) AND the file imports, configures, or implements one of the following patterns:
-> WebSocket or long-lived connection servers/clients (any library)
-> Server-Sent Events, streaming HTTP routes, or chunked transfer responses used for live updates
-> Pub/sub, channel, or room-based messaging infrastructure (any provider)
-> Fan-out logic: broadcast, emit, publish to multiple recipients, per-connection iteration
-> State synchronization: presence, cursor/document sync, optimistic updates, conflict resolution, replay/catch-up
-> Backpressure and reliability: per-client queues, send buffers, slow consumer handling, reconnect replay, sequence numbers, ACKs

If the package.json contains a realtime dependency you don't recognize by name, still treat files that import it as in-scope and analyze them for connection lifecycle, fan-out, and backpressure risks.

Ignore and do not report non-realtime findings, even if they are real issues:
-> Generic database performance unless it directly blocks realtime fan-out/state sync
-> Payment correctness, authentication/session issues, generic validation, static UI
-> One-off HTTP request/response APIs that do not maintain live connections or push updates

If a possible issue is adjacent, ask: "Would fixing this improve concurrent connection handling, messages per second, fan-out reliability, backpressure, or realtime state consistency?" If no, discard it silently.

### PHASE 1 - Realtime Stack Understanding (No Tools)

Infer from package.json and file tree:
- realtimeLibraries: socket.io | ws | pusher | ably | supabase-realtime | firebase | liveblocks | partysocket/partykit | convex | sse | redis pubsub | NONE
- transport: websocket | SSE | managed provider | polling | unknown
- connectionModel: single Node process | managed provider | serverless route | edge route | unknown
- pubsubArchitecture: in-memory | Redis/pubsub | provider channels | database polling | none | unknown
- stateSyncSignals: presence, room, channel, cursor, document, notification, chat, live, collaboration, dashboard
- reliabilitySignals: reconnect, replay, sequence, ack, heartbeat, ping/pong, backpressure, rate limit, queue, buffer

No realtime-looking dependencies or files = report INFO AND STOP WITHOUT USING TOOLS.

### PHASE 2 - Identify Investigation Targets

Build a target list from package.json and file tree first.
Prefer files that own connection lifecycle or fan-out:
- CRITICAL: websocket/socket server, SSE stream route, pubsub adapter/config, room/channel broadcast code, presence/state sync server logic
- HIGH: realtime client provider/hooks, chat/collaboration/notifications/live dashboard update paths, reconnect/replay logic
- MEDIUM: helper utilities used by critical/high realtime paths
- LOW/SKIP: static UI, simple CRUD routes, unrelated server actions

Use searchCode only if injected context is not enough to choose target files. Pick your own compact query based on repository signals. Do not run one search per keyword.
**searchCode fallback: if your first 2 searchCode calls both return 0 results, abandon searchCode entirely. The repository likely has no matching content for code search. Switch to reading files directly via getFileContent using paths you identified from the file tree.**
Read highest-impact files first. Stop expanding when the failure mode is clear.

### PHASE 3 - Deep Realtime Analysis

For each selected target, inspect:

WebSocket Connection Limits:
-> single-node WebSocket server with in-memory connection/room state
-> serverless/Next.js route trying to hold long-lived WebSocket connections
-> no heartbeat/ping-pong or stale connection cleanup
-> no connection limits, rate limits, auth gating, or per-tenant isolation

Message Fan-out:
-> broadcast loops over every connected client or every room member with no batching/backpressure
-> no pub/sub adapter for multi-instance fan-out
-> writes messages synchronously to all sockets before returning
-> no slow-client handling or send-buffer limits

State Synchronization:
-> in-memory presence/document/session state with no shared store
-> no sequence numbers, versions, ACKs, replay/catch-up, or conflict handling
-> reconnect loses missed messages or produces stale state
-> optimistic client state with no authoritative reconciliation

Pub/Sub Architecture:
-> no Redis/provider adapter when horizontal scaling is required
-> database polling used as realtime transport without throttling
-> no channel partitioning or tenant isolation
-> no clear strategy for multiple app instances

Backpressure Handling:
-> no per-client queue size, drop policy, compression/rate limit, or disconnect slow consumer strategy
-> no message size limit
-> no messages-per-second limit by user/room/channel

Scale Basis:
For each core flow, estimate the failure mode using:
-> concurrent connections
-> messages per second
-> fan-out multiplier = producers x recipients
-> shared-state requirements
State what fails first: connection limit, CPU, memory, slow clients, missed messages, stale state, pub/sub bottleneck, or dropped data.

### PHASE 4 - Synthesis

If you have fewer than 3 CRITICAL findings and still have tool budget remaining, continue investigating additional files before synthesizing. Only stop early if the repository genuinely has no more realtime surface to investigate.
After finding 3 CRITICAL issues, stop expanding to optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

For every meaningful finding, answer: "Can this handle many concurrent connections without dropping messages/data?"

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report.
Do NOT include executive summary, stack recap, priority list, code snippets, or follow-up offers.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[RT-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact realtime pattern and why it fails.
Impact: max 1 sentence. Include what breaks with high connections/messages.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[RT-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[RT-3] Short title, max 10 words
File: path/to/file.ts or package/tree context
Evidence: max 1 sentence.

Severity definitions:
- CRITICAL: proven connection exhaustion, single-node state/fan-out bottleneck, message loss, missing horizontal scaling for core realtime flow, stale/corrupt shared state, or unbounded fan-out/backpressure failure.
- WARNING: proven realtime scaling risk that degrades with concurrent connections/messages but is not an immediate outage.
- INFO: useful context, healthy observations, or no realtime surface found.

Compression rules:
- Report every distinct in-scope realtime finding discovered. Drop non-realtime findings silently.
- Merge only genuinely overlapping instances of the same root cause.
- Target 3-6 findings when possible.
- Sort by severity, then concurrent-connection/message-loss impact.
- Each finding must preserve file, evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding.
- No markdown tables. No nested bullets. No long explanations.

When investigation is complete, output findings as the final message only.`;

const realtimeAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

export async function runRealtimeAgent(
    input: RealtimeAgentInput
): Promise<RealtimeAgentOutput> {
    const { repositoryId, installationId, onEvent } = input;
    const startTime = Date.now();

    const emit = (event: StreamEvent) => {
        try { onEvent?.(event); } catch { /* ignore stream errors */ }
    };

    const shared = {
        toolCallCount: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        lastToolName: "unknown",
        startTime,
        emit,
    };

    console.log(`[realtimeAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting Realtime agent for ${repositoryId}`,
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

        console.log(`[realtimeAgent] Repo: ${repository.fullName} (${branch})`);

        const { middleware: toolBudgetMiddleware } = createToolBudgetMiddleware({
            agentLabel: "realtimeAgent",
            toolBudget: 15,
            searchBudget: 3,
            shared,
        });

        const agent = createAgent({
            model: gpt5Mini,
            tools: realtimeAgentTools,
            systemPrompt: SYSTEM_PROMPT,
            contextSchema: githubContextSchema,
            middleware: [toolBudgetMiddleware],
        });

        const result = await agent.invoke(
            {
                messages: [
                    {
                        role: "user",
                        content:
                            `Analyze the repository ${repository.fullName} for realtime scale risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

Primary objectives:
1. WebSocket/SSE connection limits
2. Message fan-out and pub/sub architecture
3. State synchronization and reconnect correctness
4. Single-node realtime server risks
5. Horizontal scaling strategy
6. Backpressure handling for slow clients and message bursts

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest, never exceed this limit
- Decide yourself whether searchCode is needed; do not follow a preset search query
- searchCode EARLY EXIT: if 2 consecutive searches return 0 results, stop using searchCode entirely and navigate the file tree with getFileContent instead
- Use package.json and file tree before tools
- If package.json and file tree show no realtime surface, return INFO without tool calls

Scope constraint: Only report realtime architecture risks: WebSocket/SSE connection scaling, message fan-out, pub/sub, state sync, reconnect/replay, single-node realtime state, and backpressure. Ignore unrelated issues silently.
Key question: Can we handle many concurrent connections without dropping messages/data?

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers. If you are near the tool limit, stop using tools and synthesize from available evidence.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, installationId },
                recursionLimit: 50,
                callbacks: [
                    {
                        handleToolStart(tool: any, input: string) {
                            shared.toolCallCount++;
                            const toolName = resolveCallbackToolName(tool, shared.lastToolName);
                            shared.lastToolName = toolName;
                            let parsedInput: unknown = input;
                            try { parsedInput = JSON.parse(input); } catch { /* keep raw */ }
                            const inputPreview = typeof parsedInput === "object"
                                ? JSON.stringify(parsedInput).slice(0, 200)
                                : String(parsedInput).slice(0, 200);
                            console.log(`\n🔧 [Step ${shared.toolCallCount}/15] TOOL CALL: ${toolName}`);
                            console.log(`   Input: ${inputPreview}`);
                            emit({ type: "tool_start", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, toolName, toolInput: parsedInput, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                        handleToolEnd(output: any) {
                            const outputStr = typeof output?.content === "string" ? output.content : typeof output === "string" ? output : JSON.stringify(output) ?? "";
                            const preview = outputStr.slice(0, 300);
                            console.log(`📄 [Step ${shared.toolCallCount}/15] TOOL RESPONSE: ${shared.lastToolName} (${outputStr.length} chars)`);
                            console.log(`   Preview: ${preview}${outputStr.length > 300 ? "..." : ""}`);
                            emit({ type: "tool_end", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, toolName: shared.lastToolName, toolOutput: outputStr.slice(0, 5000), toolOutputLength: outputStr.length, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                        handleChainError(error: Error) {
                            console.log(`\n[realtimeAgent] CHAIN ERROR: ${error.message}`);
                            emit({ type: "error", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, error: error.message, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
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
            console.error("[realtimeAgent] Error: Agent completed without returning any findings");
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
            `[realtimeAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`
        );
        console.log(`[realtimeAgent] Execution time: ${executionTimeMs}ms`);

        emit({
            type: "done",
            stepNumber: shared.toolCallCount,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings,
            totalToolCalls,
            executionTimeMs,
            cumulativeTokens: {
                inputTokens: shared.cumulativeInputTokens,
                outputTokens: shared.cumulativeOutputTokens,
                totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens,
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

        console.error(`[realtimeAgent] Chain Error: ${message}`);

        emit({
            type: "done",
            stepNumber: shared.toolCallCount,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings: null,
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
            cumulativeTokens: {
                inputTokens: shared.cumulativeInputTokens,
                outputTokens: shared.cumulativeOutputTokens,
                totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens,
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
