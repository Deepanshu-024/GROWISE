/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAgent } from "langchain";
import {
    createToolBudgetMiddleware,
    resolveCallbackToolName,
} from "../tools/agent-middleware";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import {
    searchCodeTool,
    getFileContentTool,
    githubContextSchema,
} from "../tools/agent-tools";

// --- Types --------------------------------------------------------------------

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

export interface AiPoweredAgentInput {
    repositoryId: string;
    installationId: string;
    userId?: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface AiPoweredAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}



// ------------------------------------System Prompt -------------------------------------------------------------

const SYSTEM_PROMPT = `You are an elite AI integration cost and performance analyst specializing in React/Next.js applications that consume LLM APIs (OpenAI, Anthropic, Google AI, Cohere, Replicate, Hugging Face, etc.) and AI SDKs (Vercel AI SDK, LangChain, LlamaIndex, etc.). Your mission is to analyze GitHub repositories and surface AI-integration risks that will cause cost explosions, latency spikes, token limit failures, or degraded user experience as usage scales — not theoretical best practices, but the patterns that break under real production traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify AI targets before making tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read AI route handlers, LLM client config, prompt templates, embedding pipelines, RAG chains, AI utility files
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files. Choose compact repository-specific searches. Use at most 3 searches total. **EARLY EXIT RULE: if 2 consecutive searchCode calls return 0 results, stop all further searchCode usage immediately and fall back to navigating the file tree with getFileContent.**

---

## ANALYSIS FRAMEWORK - AI COST & PERFORMANCE SCALE SPECIALIST

### NON-NEGOTIABLE SCOPE GATE - AI INTEGRATION ONLY

Only investigate and report findings that directly affect LLM API costs, AI call latency, token budget management, response caching, batching, streaming, or AI-related throughput at scale.

Before reading a file, decide whether it is an AI target. Use the injected package.json dependencies and repository file tree to discover which AI libraries and patterns the project actually uses. A file is in scope when the package.json contains an AI-related dependency (e.g., openai, @anthropic-ai/sdk, @google/generative-ai, ai, langchain, llamaindex, cohere-ai, replicate, @huggingface/inference, or any other library whose primary purpose is LLM/embedding/AI model invocation) AND the file imports, configures, or implements one of these:
-> LLM API calls: chat completions, text generation, embeddings, image generation, function calling, tool use
-> AI SDK usage: Vercel AI SDK (ai), LangChain chains/agents, LlamaIndex queries, custom LLM wrappers
-> Prompt construction: template assembly, system/user message building, context window management, token counting
-> RAG pipelines: vector search + LLM generation, document retrieval + completion, embedding + query flows
-> AI response handling: streaming (SSE/ReadableStream), caching of AI responses, retry/fallback logic
-> Cost control: rate limiting on AI routes, usage tracking, budget caps, model selection logic

Ignore and do not report non-AI findings, even if they are real issues:
-> General database performance unless it directly feeds an AI pipeline (e.g., RAG vector store queries)
-> Authentication, payment, event-driven, realtime, or content delivery issues — other agents own these
-> Generic API correctness, validation, or UI bugs unrelated to AI integration

If a possible issue is adjacent, ask: "Would fixing this reduce AI API costs, improve LLM response latency, prevent token limit failures, or improve AI throughput at scale?" If no, discard it silently.

### PHASE 1 - AI Stack Understanding (No Tools)

Infer from package.json and file tree:
- aiProvider: openai | anthropic | google-ai | cohere | replicate | huggingface | multiple | none
- aiSDK: vercel-ai-sdk | langchain | llamaindex | custom | none
- modelUsage: chat completion | embeddings | image generation | function calling | agents | multiple
- cachingSignals: redis/cache libraries alongside AI deps, response cache files, memoization utilities
- streamingSignals: AI SDK streaming helpers, ReadableStream usage in AI routes, SSE endpoints
- costControlSignals: rate limit middleware on AI routes, usage tracking, budget/quota files, model selection config
- ragSignals: vector store (pinecone, weaviate, chroma, pgvector, qdrant), embedding + retrieval files

No AI-related dependencies or AI-looking files = report INFO AND STOP WITHOUT USING TOOLS.

### PHASE 2 - Identify Investigation Targets

Build a target list from package.json and file tree first.
Prefer files that own AI API calls or cost:
- CRITICAL: AI route handlers (api/chat, api/generate, api/embed), LLM client config, AI middleware, prompt templates
- HIGH: RAG pipeline files, embedding generation, vector store queries, AI utility/helper files
- MEDIUM: AI response caching, rate limiting on AI routes, usage tracking
- LOW/SKIP: UI components consuming AI responses, static pages, non-AI API routes

Use searchCode only if injected context is not enough to choose target files. Pick your own compact query based on repository signals. Do not run one search per keyword.
**searchCode fallback: if your first 2 searchCode calls both return 0 results, abandon searchCode entirely. Switch to reading files directly via getFileContent using paths from the file tree.**
Read highest-impact files first. Stop expanding when the failure mode is clear.

### PHASE 3 - Deep AI Integration Analysis

For each selected target, inspect:

Repeated LLM Calls Without Caching:
-> Same prompt/input producing identical LLM calls on every request with no response cache
-> Identical embedding generation for the same text without memoization
-> System prompt + static context re-sent on every call without caching the completion
-> No semantic cache (e.g., GPTCache, custom hash-based cache) for similar queries
-> Severity: CRITICAL if high-traffic routes make uncached LLM calls — cost grows linearly with traffic

Cost Explosion Patterns:
-> Using expensive models (gpt-4, claude-3-opus) for tasks achievable with cheaper models (gpt-4o-mini, haiku)
-> No token/cost tracking or budget caps — usage is unbounded
-> Multi-step chains or agents that make N LLM calls per user request with no limit on N
-> Large context windows filled unnecessarily (sending full documents when summaries suffice)
-> Embedding entire documents on every query instead of pre-computing and storing vectors
-> Severity: CRITICAL if cost scales exponentially or is unbounded; WARNING if linear but unoptimized

No Batching:
-> Multiple independent LLM/embedding calls made sequentially when they could be batched
-> N users triggering N separate API calls when a single batched request would suffice
-> RAG pipelines that embed one chunk at a time instead of batching chunks
-> Severity: WARNING — increases latency and may hit rate limits but cost is similar

No Streaming Responses:
-> LLM responses waited for in full before sending to client (no streaming)
-> Long-running AI completions blocking the response — user sees nothing until complete
-> No ReadableStream, SSE, or Vercel AI SDK streamText/streamObject usage
-> Severity: WARNING — degrades UX and perceived latency but does not directly increase cost

Token Limit / Context Size Risks:
-> No token counting before sending prompts — large inputs may exceed model context window
-> No truncation or summarization strategy for long user inputs or retrieved documents
-> Chat history grows unbounded without sliding window, summarization, or pruning
-> Severity: CRITICAL if token overflow causes silent failures or lost context; WARNING if it just degrades quality

Rate Limiting and Throughput:
-> No rate limiting on AI-powered API routes — each request triggers an LLM call
-> No queue/throttle for AI calls during traffic spikes
-> No fallback model or graceful degradation when primary AI provider is rate-limited
-> Severity: CRITICAL if a traffic spike will exhaust API quota and break the app; WARNING for missing fallback

Scale Basis:
For each core AI flow, estimate the cost growth pattern:
-> calls per user request (1 call, N-step chain, agent loop)
-> tokens per call (prompt size + max completion)
-> cost per call at current model pricing
-> caching effectiveness (what % of calls could be cached)
State whether cost grows: linearly (proportional to users), exponentially (chains/agents multiply), or can be capped (cache + budget limits).

### PHASE 4 - Synthesis

If you have fewer than 3 CRITICAL findings and still have tool budget remaining, continue investigating additional files before synthesizing. Only stop early if the repository genuinely has no more AI/ML surface to investigate.
After finding 3 CRITICAL issues, stop expanding the investigation to new optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

For every meaningful finding, answer the key question: "Does cost grow linearly, exponentially, or can we cap it?"

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, priority list, code snippets, or "if you want" follow-ups.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[AI-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact AI pattern and why it causes cost explosion or failure at scale.
Impact: max 1 sentence. Include cost growth pattern (linear/exponential/unbounded).
Fix: max 1 sentence. State the concrete first fix.

[AI-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- WARNING FINDINGS ---

[AI-3] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[AI-4] Short title, max 10 words
File: path/to/file.ts or package/config context
Evidence: max 1 sentence.
Use INFO only for useful context, healthy observations, or lower-confidence findings.

Severity definitions:
- CRITICAL: proven cost explosion, unbounded LLM calls, no caching on high-traffic AI routes, token overflow causing failures, or missing rate limits that will exhaust API quota.
- WARNING: proven AI inefficiency that increases cost or latency under load but does not immediately cause failure.
- INFO: useful context, healthy observations, or no AI surface found.

Compression rules:
- Report every distinct in-scope AI finding you discovered. Drop non-AI findings silently.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then cost impact.
- Each finding must preserve: file, pattern/evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// --- Tools --------------------------------------------------------------------

const aiAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

// --- Main Exported Function ---------------------------------------------------

export async function runAiPoweredAgent(
    input: AiPoweredAgentInput
): Promise<AiPoweredAgentOutput> {
    const { repositoryId, installationId, userId, onEvent } = input;
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

    console.log(`[aiAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting AI-powered agent for ${repositoryId}`,
    });

    try {
        const repository = await prisma.repository.findFirst({
            where: userId ? {
                OR: [
                    { id: repositoryId },
                    {
                        userId,
                        repositoryId,
                    }
                ]
            } : {
                OR: [
                    { id: repositoryId },
                    { repositoryId }
                ]
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
                rawFindings: null, intermediateSteps: [], totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: `Repository "${repositoryId}" not found in database. Run framework analysis first.`,
            };
        }

        const [owner, repo] = repository.fullName.split("/");
        const branch = repository.defaultBranch ?? "main";
        const framework = repository.framework ?? "unknown";
        const packageJsonStr = repository.packageJson
            ? JSON.stringify(repository.packageJson).slice(0, 3000) : "Not available";
        const repoContentStr = repository.repoContent
            ? JSON.stringify(repository.repoContent) : "Not available";

        console.log(`[aiAgent] Repo: ${repository.fullName} (${branch})`);

        const { middleware: toolBudgetMiddleware } = createToolBudgetMiddleware({
            agentLabel: "aiAgent",
            toolBudget: 15,
            searchBudget: 3,
            shared,
        });

        const agent = createAgent({
            model: gpt5Mini,
            tools: aiAgentTools,
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
                            `Analyze the repository ${repository.fullName} for AI integration cost and performance risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **Repeated LLM Calls** - Find uncached LLM/embedding calls on high-traffic routes
2. **Cost Explosion** - Identify unbounded chains, expensive model usage, missing budget caps
3. **No Batching** - Find sequential AI calls that could be batched
4. **No Streaming** - Check if LLM responses are streamed or waited in full
5. **Token Limits** - Find unbounded chat history, missing truncation, context overflow risks
6. **Rate Limiting** - Check for missing throttles on AI-powered routes

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest, never exceed this limit
- searchCode EARLY EXIT: if 2 consecutive searches return 0 results, stop using searchCode entirely and navigate the file tree with getFileContent instead
- Decide yourself whether searchCode is needed; do not follow a preset search query
- Use package.json and file tree before tools
- If package.json and file tree show no AI surface, return INFO without tool calls

**Scope constraint:** Only report AI integration risks: LLM cost, token limits, caching, batching, streaming, rate limiting, and AI throughput. Ignore unrelated issues silently.
**Key question:** Does cost grow linearly, exponentially, or can we cap it?

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
                            console.log(`\n[aiAgent] CHAIN ERROR: ${error.message}`);
                            emit({ type: "error", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, error: error.message, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                    },
                ],
            }
        );

        const messages = result.messages ?? [];
        const toolMessages = messages.filter((msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0);
        const totalToolCalls = toolMessages.length;
        const lastAiMessage = [...messages].reverse().find((msg: any) => msg._getType?.() === "ai" || msg.role === "assistant");
        const rawFindings: string = typeof lastAiMessage?.content === "string" ? lastAiMessage.content : JSON.stringify(lastAiMessage?.content ?? "");
        const executionTimeMs = Date.now() - startTime;

        if (!rawFindings || rawFindings.trim().length === 0) {
            console.error("[aiAgent] Error: Agent completed without returning any findings");
            return { rawFindings: null, intermediateSteps: messages, totalToolCalls, executionTimeMs, error: "Agent completed without returning findings. Check intermediate steps for partial investigation." };
        }

        console.log(`[aiAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`);
        console.log(`[aiAgent] Execution time: ${executionTimeMs}ms`);

        emit({ type: "done", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: executionTimeMs, rawFindings, totalToolCalls, executionTimeMs, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
        return { rawFindings, intermediateSteps: messages, totalToolCalls, executionTimeMs };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const message = error instanceof Error ? error.message : "Unknown error occurred";
        console.error(`[aiAgent] Chain Error: ${message}`);
        emit({ type: "done", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: executionTimeMs, rawFindings: null, totalToolCalls: 0, executionTimeMs, error: message, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
        return { rawFindings: null, intermediateSteps: [], totalToolCalls: 0, executionTimeMs, error: message };
    }
}
