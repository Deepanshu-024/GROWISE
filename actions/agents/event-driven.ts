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

export interface EventDrivenAgentInput {
    repositoryId: string;
    installationId: string;
    userId?: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface EventDrivenAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}



// --- System Prompt -------------------------------------------------------------

const SYSTEM_PROMPT = `You are an elite event-driven architecture analyst specializing in React/Next.js applications and their backend integrations. Your mission is to analyze GitHub repositories and surface event-processing risks that will cause queue backlog, consumer lag, duplicate side effects, or lost asynchronous work when traffic spikes - especially what happens if events spike 10x suddenly.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify targets before making any tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS (Use Sparingly - repo details are injected automatically via context):
1. **getFileContent(path)** - Just pass the file path. For reading event producers, consumers, webhook handlers, queue config, background jobs, schema files
2. **searchCode(query)** - Just pass one compact query when you decide search is necessary. Use at most 3 searches total.

---

## ANALYSIS FRAMEWORK - EVENT-DRIVEN SCALE SPECIALIST

---

### NON-NEGOTIABLE SCOPE GATE - EVENT-DRIVEN ONLY

Only investigate and report findings that directly affect asynchronous event production, queueing, background jobs, webhooks, consumers, workers, retries, deduplication, idempotency, or dead-letter handling.

Do NOT investigate authentication or payment event surfaces. Auth and payment have dedicated agents. Skip these files and flows even if they are event-driven:
-> auth, authentication, login, signup, session, clerk, nextauth, auth0, supabase-auth, jwt, user-sync auth webhooks
-> payment, checkout, billing, invoice, subscription, stripe, razorpay, paddle, paypal, lemonsqueezy, refund, dispute, payment webhooks
If the only event-driven files in the repository are auth or payment related, return INFO that no non-auth/non-payment event-driven surface was found.

Before reading a file, decide whether it is an event target. A file is in scope only when it contains or configures one of these:
-> Event producers: calls to send, publish, emit, enqueue, schedule, create job, trigger workflow
-> Event consumers: handlers, workers, inngest functions, bull processors, webhook handlers, cron jobs that process queued work
-> Queue/workflow infrastructure: Bull, BullMQ, Inngest, Temporal, Trigger.dev, Upstash QStash, SQS, Kafka, Pub/Sub, RabbitMQ, Redis queues
-> Retry policies, concurrency settings, rate limits, backoff, batch size, timeout, max attempts
-> Dead-letter queues, failed job handling, poison message handling, alerting on exhausted retries
-> Idempotency and deduplication: event ID tables, processed-event records, unique provider event IDs, idempotency keys

Ignore and do not report non-event findings, even if they are real issues. Examples to exclude:
-> General database performance unless it directly blocks event consumers
-> Payment events, payment webhooks, checkout events, billing events, subscription events, refund/dispute events
-> Authentication events, auth provider webhooks, login/signup/session events, user-sync auth events
-> Generic input validation
-> UI-only problems

If a possible issue is adjacent, ask: "Would fixing this prevent queue backlog, consumer lag, duplicate side effects, lost events, or retry storms during a 10x event spike?" If no, discard it silently.
If the answer is yes but the file is auth-related or payment-related, still discard it silently because another agent owns that scope.

---

### PHASE 1 - Event Stack Understanding (No Tools)

**Step 1A - Identify event stack from package.json:**

Extract and note:
- eventLibraries: inngest | bull | bullmq | temporal | trigger.dev | qstash | svix | kafka | amqplib | NONE
- queueBackend: redis | sqs | kafka | postgres | provider-managed | unknown
- producerPatterns: API route emits event, webhook emits job, server action enqueues job, cron schedules work
- consumerPatterns: worker process, route handler, inngest function, queue processor, webhook handler
- retrySupport: explicit retry/backoff/maxAttempts or provider defaults
- dlqSupport: dead letter queue, failed job table, exhausted retry handler, alerting
- idempotencySupport: processed event table, unique event ID, dedupe key, idempotency key

These directly shape severity:
-> Event libraries present with consumers but no retry/DLQ/idempotency = high risk
-> Non-auth and non-payment webhooks are event consumers even when no queue library exists
-> Serverless handlers processing events synchronously are vulnerable to spikes and provider retry storms
-> No event-related libraries or event-looking files = report INFO and stop without tools

**Step 1B - Identify event paths from file tree:**

Scan folder and file names for:
- CRITICAL: webhook, webhooks, worker, workers, queue, queues, jobs, inngest, bull, events, consumers, processors
- HIGH: cron, schedule, sync, import, export, email, notification, analytics
- MEDIUM: background, task, batch, pipeline, replay, retry
- LOW/SKIP: static UI, components, styles, docs unless they configure event behavior; all auth/payment/billing/checkout/subscription webhook paths

Write down the classification before continuing

---

### PHASE 2 - Identify Investigation Targets (Minimal Tools)

**Step 2A - Build investigation list from file tree:**

Combine CRITICAL + top 3-4 HIGH items.
Maximum 8 items total. Prefer consumer/handler files over producers when choosing.
Do not try to retrieve the repo tree. The injected tree is the only tree context you should use.

**Step 2B - Search event patterns:**

Use **searchCode** only if the injected package.json and file tree are not enough to choose target files.
Choose your own compact search query based on what the repository appears to use.
Do not use search to explore auth or payment terminology.
Never run separate searches for each keyword.

---

### PHASE 3 - Deep Event Flow Analysis

For each item in your investigation list, use **getFileContent** to read only the highest-impact files.

**What to look for in each file:**

Queue Backlog:
-> Producers can enqueue/publish faster than consumers process
-> No concurrency limits, rate limits, batching, throttling, or backpressure
-> Long-running synchronous work inside webhook/API handlers instead of enqueueing
-> Severity: CRITICAL if a public/high-volume event source can overwhelm a single consumer; WARNING if bounded but still fragile

Consumer Lag:
-> Single worker/consumer with no configured concurrency
-> Sequential processing of independent events
-> No timeout handling or long external API calls inside handlers
-> No monitoring/metrics for queue length, oldest job age, failed jobs, or consumer lag
-> Severity: CRITICAL if lag causes user-visible failures or provider retry storms; WARNING if lag only delays background work

Event Duplication:
-> Non-auth/non-payment webhook handlers or consumers perform side effects without checking event ID/idempotency key
-> Retries can create duplicate DB rows, duplicate emails, duplicate notifications, duplicate external calls
-> No unique constraint on processed event IDs
-> Severity: CRITICAL if duplicate delivery corrupts data, bills/sends twice, or repeats irreversible side effects; WARNING for duplicate analytics/non-critical side effects

Retry Strategy:
-> No explicit retry policy where transient failures are likely
-> Infinite/unbounded retries or immediate retries with no backoff
-> Retry wraps non-idempotent side effects
-> Errors swallowed without retry or alerting
-> Severity: CRITICAL if events can be lost or retry storms amplify load; WARNING for delayed non-critical jobs

Dead-Letter Handling:
-> No DLQ, failed job table, onFailure handler, exhausted retry path, or alerting
-> Poison events can loop forever or disappear silently
-> Severity: CRITICAL if financial/account/user lifecycle events can be lost; WARNING for non-critical async work

Throughput Basis:
For each core flow, estimate the 10x spike failure mode:
-> producer rate = public webhook/API/events per request
-> consumer capacity = concurrency x processing time
-> backlog growth = producer rate - consumer rate
State what fails first: queue length, provider retries, duplicate side effects, timeout, DB/API bottleneck.

---

### PHASE 4 - Schema & Idempotency Storage

Run this phase only when event consumers exist AND the schema path is obvious from the injected file tree.

Use **getFileContent** to read the schema once only if it fits inside the 15-tool total budget.

Check:
- Is there a ProcessedEvent / WebhookEvent / EventLog / Job / Outbox model?
- Are provider event IDs or job IDs stored with unique constraints?
- Are event statuses tracked: pending, processing, completed, failed, dead_lettered?
- Is there an outbox pattern for publishing events after DB writes?
- Are retry counts, lastError, nextRunAt, lockedAt, or worker lease fields present for custom queues?

Cross-reference:
-> Consumer with no idempotency check AND schema has no processed-event unique store = CRITICAL for important side effects
-> Custom queue without status/retry/dead-letter fields = CRITICAL or WARNING depending on event criticality
-> Producer writes DB then emits event without outbox/transactional handoff = WARNING; CRITICAL if event loss breaks critical workflow

---

### PHASE 5 - Synthesis

If you have fewer than 3 CRITICAL findings and still have tool budget remaining, continue investigating additional files before synthesizing. Only stop early if the repository genuinely has no more event-driven surface to investigate.
After finding 3 CRITICAL issues, stop expanding the investigation to new optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

For every meaningful finding, answer the key question: "What happens if events spike 10x suddenly?"

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, priority list, code snippets, or "if you want" follow-ups.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[EVT-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact event/queue/consumer pattern and why it fails.
Impact: max 1 sentence. Include what breaks during a 10x event spike.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[EVT-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[EVT-3] Short title, max 10 words
File: path/to/file.ts or package/schema context
Evidence: max 1 sentence.

Severity definitions:
- CRITICAL: proven event loss, duplicate irreversible side effects, provider retry storm, unbounded queue backlog, poison message loop, or critical consumer lag.
- WARNING: proven async processing risk that degrades under event spikes but does not immediately corrupt core state.
- INFO: useful context, healthy observations, or no event-driven surface found.

Compression rules:
- Report every distinct in-scope event finding you discovered. Drop non-event findings silently.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause; do not merge unrelated findings.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then 10x-spike impact.
- Each finding must preserve: file, pattern/evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

const eventAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

// --- Main Exported Function ---------------------------------------------------

export async function runEventDrivenAgent(
    input: EventDrivenAgentInput
): Promise<EventDrivenAgentOutput> {
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

    console.log(`[eventAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting Event-driven agent for ${repositoryId}`,
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

        console.log(`[eventAgent] Repo: ${repository.fullName} (${branch})`);

        const { middleware: toolBudgetMiddleware } = createToolBudgetMiddleware({
            agentLabel: "eventAgent",
            toolBudget: 15,
            searchBudget: 3,
            shared,
        });

        const agent = createAgent({
            model: gpt5Mini,
            tools: eventAgentTools,
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
                            `Analyze the repository ${repository.fullName} for event-driven scale risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **Queue Backlog** - Identify producers that can overwhelm consumers during a 10x event spike
2. **Consumer Lag** - Check worker/handler concurrency, processing time, timeouts, and lag visibility
3. **Event Duplication** - Find handlers that are not idempotent under retries or duplicate delivery
4. **Retry Strategy** - Verify explicit attempts, backoff, transient error handling, and retry safety
5. **Dead-Letter Handling** - Check DLQs, failed job stores, exhausted retry handlers, and alerting
6. **Throughput Balance** - Compare producer throughput with consumer capacity and state what fails first

**Analysis Approach:**
- Start with package.json and file tree; identify event libraries, webhook handlers, workers, queues, jobs, and cron tasks before tool calls
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest
- Decide yourself whether searchCode is needed; do not follow any preset search query
- If search is needed, use compact repository-specific searches and never search auth/payment terms
- If package.json and file tree show no event-driven surface, return INFO without tool calls

**Scope constraint:** Only report event-driven architecture risks: queue backlog, consumer lag, duplicate delivery, retry behavior, idempotency, DLQ/poison events, and event loss. Ignore unrelated issues silently.
**Excluded scope:** Never explore authentication or payment events. Skip auth, login, signup, session, clerk, nextauth, auth0, payment, checkout, billing, invoice, subscription, stripe, razorpay, refund, and dispute event paths. If those are the only event surfaces, return INFO for no non-auth/non-payment event-driven surface.
**Key question:** What happens if events spike 10x suddenly?

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
                            console.log(`\n[eventAgent] CHAIN ERROR: ${error.message}`);
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
            console.error(
                "[eventAgent] Error: Agent completed without returning any findings"
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
            `[eventAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`
        );
        console.log(`[eventAgent] Execution time: ${executionTimeMs}ms`);

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

        console.error(`[eventAgent] Chain Error: ${message}`);

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
