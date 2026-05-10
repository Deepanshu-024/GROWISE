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
    // done event fields
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
}

export interface TransactionAgentInput {
    repositoryId: string;
    accessToken: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface TransactionAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

// --- Logging Types ------------------------------------------------------------

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

// ------------------------------------System Prompt -------------------------------------------------------------

const SYSTEM_PROMPT = `You are an elite payment integration analyst specializing in React/Next.js applications. Your mission is to analyze GitHub repositories and surface payment-related risks that will cause real revenue loss, failed charges, webhook data corruption, or subscription lifecycle bugs as the business scales - not theoretical edge cases, but the patterns that break under real production traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify payment targets before making tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read payment routes, checkout flows, webhook handlers, subscription logic, refund/dispute code, schema files, and provider config
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files. Choose compact repository-specific searches. Use at most 3 searches total. **EARLY EXIT RULE: if 2 consecutive searchCode calls return 0 results, stop all further searchCode usage immediately and fall back to navigating the file tree with getFileContent. Do not try alternative keywords or rephrased queries.**

---

## ANALYSIS FRAMEWORK - PAYMENT INTEGRATION SPECIALIST

---

### NON-NEGOTIABLE SCOPE GATE - PAYMENTS ONLY

Only investigate and report findings that directly affect payment processing, checkout flows, subscription lifecycle, webhook handling from payment providers, refund/dispute management, or financial data integrity.

Before reading a file, decide whether it is a payment target. A file is in scope only when it contains or directly configures one of these:
-> Payment provider SDK calls (Stripe, Razorpay, Paddle, PayPal, LemonSqueezy, etc.)
-> Checkout / purchase / order creation flows that involve money
-> Webhook handlers for payment events (invoice.paid, checkout.session.completed, payment_intent.succeeded, etc.)
-> Subscription create / update / cancel / trial-end logic
-> Refund, dispute, chargeback handling
-> Payment-related schema models (Order, Payment, Subscription, Invoice, Plan, Price)
-> Pricing page logic that drives payment decisions (plan selection, trial gating)

Ignore and do not report non-payment findings, even if they are real issues. Examples to exclude:
-> General database performance (N+1, missing indexes) unless on a payment-critical query path
-> Authentication / session handling (another agent handles this)
-> Generic API design, input validation, CORS, CSRF
-> Caching, connection pooling, deployment configuration
-> Non-payment schema design issues

If a possible issue is only adjacent to payments, ask: "Would fixing this prevent a failed charge, lost revenue, duplicate payment, broken subscription, or webhook data corruption?" If no, discard it silently. Do not include it as INFO.

---

### PHASE 1 - Payment Stack Understanding (No Tools)

**Step 1A - Identify the payment stack from package.json:**

Extract and note:
- paymentProvider: stripe | razorpay | paddle | paypal | lemonsqueezy | NONE
- paymentSDK: @stripe/stripe-js | stripe (server) | razorpay | @paddle/paddle-js | NONE
- orm: prisma | drizzle | typeorm | mongoose (for payment record storage)
- subscriptionModel: Does the app use recurring billing? (look for subscription, plan, price keywords)
- queueLibs: bull | bullmq | inngest | temporal (for async payment processing)

These directly shape severity:
-> No payment library at all = report as INFO (no payment integration found) and stop
-> Stripe present = focus on Stripe-specific patterns (Payment Intents, Checkout Sessions, webhooks, Customer Portal)
-> Razorpay present = focus on order creation + verification + webhook signature validation
-> Subscription libraries present = subscription lifecycle is CRITICAL scope

**Step 1B - Identify payment paths from file tree:**

Scan folder and file names for:
- CRITICAL: checkout, payment, stripe, razorpay, webhook, subscription, billing, invoice, pricing, plan, order (when financial)
- HIGH: cart, purchase, refund, dispute, coupon, discount, trial, upgrade, downgrade
- MEDIUM: customer portal, payment method management, receipt, tax
- LOW/SKIP: all non-payment APIs

Write down the classification before continuing.

---

### PHASE 2 - Identify Investigation Targets (Minimal Tools)

**Step 2A - Build investigation list from file tree:**

Combine CRITICAL + top 3-4 HIGH items.
Maximum 8 items total. Write the list explicitly before Phase 3.

**Step 2B - Search for payment patterns:**

Use **searchCode** only if the injected package.json and file tree are not enough to choose target files.
Choose your own compact search query based on what the repository appears to use.
Never run separate searches for each keyword.
If your first 2 searchCode calls both return 0 results, abandon searchCode entirely. Switch to reading files directly via getFileContent using paths from the file tree.

---

### PHASE 3 - Deep Payment Flow Analysis (Strategic Tool Calls)

For each item in your investigation list, use **getFileContent** to read the file.

**What to look for in each file:**

Checkout Flow Integrity:
-> Is the checkout creating a Stripe Checkout Session / Payment Intent correctly?
-> Is the success URL handling relying on client-side confirmation instead of webhook?
-> Are prices/amounts hardcoded on the client or validated server-side?
-> Example risk: User modifies price client-side and server trusts it
-> Severity: CRITICAL if price can be manipulated, WARNING if relying on success URL instead of webhook

Webhook Safety:
-> Is the webhook verifying the provider's signature (stripe.webhooks.constructEvent, razorpay.validateWebhookSignature)?
-> Is the webhook handler idempotent (checking if event was already processed)?
-> Does it handle all critical event types (payment_intent.succeeded, invoice.paid, customer.subscription.updated, etc.)?
-> Is the webhook endpoint properly handling errors (returning 200 even on partial processing to prevent retries)?
-> Severity: CRITICAL if no signature verification, CRITICAL if non-idempotent, WARNING if missing event types

Subscription Lifecycle:
-> Is subscription creation properly linked to Stripe/Razorpay subscription objects?
-> Are status transitions handled (active -> past_due -> canceled -> expired)?
-> Is there a webhook handler for subscription.updated, subscription.deleted, invoice.payment_failed?
-> Are feature gates checking subscription status from the database, not just the session?
-> Does the trial end properly trigger a charge or cancellation?
-> Severity: CRITICAL if subscription status can desync between provider and DB, WARNING if missing lifecycle events

Payment-Database Consistency:
-> After a successful payment, is the order/subscription record created atomically?
-> If DB write fails after payment succeeds, is there a recovery/reconciliation path?
-> Are payment records storing the provider's payment ID / intent ID for reconciliation?
-> Severity: CRITICAL if payment can succeed without DB record, WARNING if no reconciliation path

Refund & Dispute Handling:
-> Is refund logic calling the provider's refund API or just updating local status?
-> Are disputes/chargebacks handled via webhook?
-> Is the refund amount validated against the original payment?
-> Severity: WARNING if refunds only update local DB without calling provider API

Client-Side Security:
-> Are Stripe publishable keys properly used (not secret keys on client)?
-> Is payment amount/price validated server-side before creating a checkout session?
-> Are payment success/failure states handled properly in the UI?
-> Severity: CRITICAL if secret key is exposed client-side, WARNING if no server-side price validation

---

### PHASE 4 - Schema & Payment Model Analysis (Targeted Tool Calls)

Run this phase only when payment models exist AND the schema path is obvious from the injected file tree.

Use **getFileContent** to read the schema once only if it fits inside the 15-tool total budget.

Check:
- Is there a Payment / Order / Subscription model with a provider ID field (stripePaymentIntentId, stripeSubscriptionId)?
- Are webhook event IDs stored for idempotency (stripeEventId with unique constraint)?
- Are payment statuses using proper enums (pending, succeeded, failed, refunded)?
- Is there a link between User/Customer and their provider customer ID (stripeCustomerId)?
- Are subscription plans / prices stored or hardcoded?

Cross-reference with Phase 3:
-> If webhook handler has no idempotency check AND schema has no unique constraint on event ID = CRITICAL
-> If no provider customer ID stored but subscription features exist = WARNING
-> If payment model exists but has no provider payment ID field = WARNING

---

### PHASE 5 - Synthesis

After finding 3 CRITICAL issues, stop expanding the investigation to new optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, priority list, code snippets, or "if you want" follow-ups.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[PAY-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact payment pattern and why it causes revenue loss, data corruption, or security risk.
Impact: max 1 sentence. Include what breaks under production traffic.
Fix: max 1 sentence. State the concrete first fix.

[PAY-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact payment pattern and why it causes revenue loss, data corruption, or security risk.
Impact: max 1 sentence. Include what breaks under production traffic.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[PAY-3] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[PAY-4] Short title, max 10 words
File: path/to/file.ts or package/schema context
Evidence: max 1 sentence.
Use INFO only for useful context, healthy observations, or lower-confidence findings.

Severity definitions:
- CRITICAL: proven revenue loss, failed charges, duplicate payments, webhook data corruption, secret key exposure, subscription desync, or payment without DB record.
- WARNING: proven payment risk that becomes painful with traffic growth but is not an immediate revenue loss under normal load.
- INFO: context the orchestrator may optionally use; never include generic advice here.

Compression rules:
- Report every distinct in-scope payment finding you discovered. Drop non-payment findings silently, even when they are valid issues for another specialist agent.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause; do not merge unrelated findings.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then user impact.
- Each finding must preserve: file, pattern/evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding; if there are many findings, shorten each field rather than omitting findings.
- Prefer one consolidated finding over separate per-file bullets when the root cause is the same pattern.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// --- Tools --------------------------------------------------------------------

const payAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

// --- Main Exported Function ---------------------------------------------------

export async function runTransactionAgent(
    input: TransactionAgentInput
): Promise<TransactionAgentOutput> {
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

    console.log(`[payAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting Payment agent for ${repositoryId}`,
    });

    try {
        // -- Resolve repository metadata from DB --------------------------
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

        console.log(`[payAgent] Repo: ${repository.fullName} (${branch})`);

        // -- Create agent & invoke ----------------------------------------
        const agent = createAgent({
            model: gpt5Mini,
            tools: payAgentTools,
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
                            `Analyze the repository ${repository.fullName} for payment integration risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **Checkout Flow Integrity** - Verify checkout sessions / payment intents are created securely with server-side price validation
2. **Webhook Safety** - Check payment webhooks for signature verification, idempotency, and critical event coverage
3. **Subscription Lifecycle** - Analyze subscription create/update/cancel flows, status sync between provider and DB, trial handling
4. **Payment-DB Consistency** - Ensure successful payments always create corresponding DB records atomically
5. **Refund & Dispute Handling** - Verify refunds call provider API and disputes are handled via webhooks
6. **Client-Side Security** - Check for secret key exposure, client-side price manipulation, proper error states

**Analysis Approach:**
- Start with the package.json and file tree provided above - identify payment provider, checkout routes, webhook handlers, subscription logic (Phase 1, no tools needed)
- Classify payment paths by revenue impact before reading any files
- Use getFileContent(path) strategically on checkout flows, webhook handlers, and subscription logic
- Use searchCode(query) only when package.json and file tree are not enough to choose target files
- Read schema file once only when payment models exist and the schema path is obvious from the file tree
- Tools already know the repo details - just pass the file path or search query

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest, never exceed this limit
- Decide yourself whether searchCode is needed; do not follow a preset search query
- searchCode EARLY EXIT: if 2 consecutive searches return 0 results, stop using searchCode entirely and navigate the file tree with getFileContent instead
- Use package.json and file tree before tools
- If package.json and file tree show no payment surface, return INFO without tool calls

**Constraint:** Minimize tool usage - leverage the file tree and package.json above first, then make targeted tool calls only for confirmed payment-related files. If you are near the tool limit, stop using tools and synthesize from available evidence.
**Scope constraint:** Only investigate and report findings that directly affect payment processing, checkout flows, subscription lifecycle, webhook handling, or financial data integrity. Ignore non-payment findings silently; do not include them as INFO.
**Reporting constraint:** If you discover a distinct in-scope payment finding, you must report it. Do not drop findings to satisfy a preferred count or budget; keep within budget by compressing wording and merging only genuinely overlapping duplicates.

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers.`,
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
                            console.log("\n──────────────────────────────────────────");
                            console.log(`[Step ${stepCounter}] AGENT DECISION`);
                            console.log(`Tool: ${toolName}`);
                            console.log(`Reasoning: ${action.log}`);
                            console.log("──────────────────────────────────────────");
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
                            console.log(`\n[payAgent] CHAIN ERROR: ${error.message}`);

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

        // -- Extract findings from the agent's final AI message ----------
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
                "[payAgent] Error: Agent completed without returning any findings"
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
            `[payAgent] Complete. Findings length: ${rawFindings.length} chars, ${totalToolCalls} tool calls`
        );
        console.log(`[payAgent] Execution time: ${executionTimeMs}ms`);

        // Finalize log
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.finalReport = { rawFindings };

        // Write to JSON file
        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `pay-agent-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));

        console.log(`\n[payAgent] ──────────────────────────────────`);
        console.log(`[payAgent] Full log written to:`);
        console.log(`[payAgent] ${logPath}`);
        console.log(`[payAgent] Total steps: ${stepCounter}`);
        console.log(`[payAgent] ──────────────────────────────────`);

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

        console.error(`[payAgent] Error: ${message}`);

        // Write partial error log so you can see what happened before the crash
        agentLog.endTime = new Date().toISOString();
        agentLog.totalSteps = stepCounter;
        agentLog.error = message;

        const logDir = path.join(process.cwd(), "agent-logs");
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        const logFileName = `pay-agent-ERROR-${repositoryId}-${Date.now()}.json`;
        const logPath = path.join(logDir, logFileName);
        fs.writeFileSync(logPath, JSON.stringify(agentLog, null, 2));
        console.error(`[payAgent] Error log written to: ${logPath}`);

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
