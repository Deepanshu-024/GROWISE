import { createAgent, createMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import { searchCodeTool, getFileContentTool, githubContextSchema } from "../analysis/tools/agent-tools";

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

export interface DbAgentInput {
    repositoryId: string;
    installationId: string;
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



// --- System Prompt -------------------------------------------------------------

const SYSTEM_PROMPT = `You are an elite database scalability analyst specializing in React/Next.js applications. Your mission is to analyze GitHub repositories and surface the database-layer issues that will cause real failures as the business scales - not theoretical edge cases, but the patterns that break under traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js confirmed)
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

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read schema files, ORM client config, high-priority API routes, server actions, DB utility files, and visible env examples
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files or validate a specific database pattern. Choose compact repository-specific searches. Use at most 3 searches total. **EARLY EXIT RULE: if 2 consecutive searchCode calls return 0 results, stop all further searchCode usage immediately and fall back to navigating the file tree with getFileContent.**

---

## ANALYSIS FRAMEWORK - DATABASE SCALE SPECIALIST

### NON-NEGOTIABLE SCOPE GATE - DATABASE ONLY

Only investigate and report findings that directly affect database scalability, query latency, lock contention, connection pool exhaustion, index coverage, ORM query shape, transaction safety, DB CPU, or DB IOPS under growth.

Before reading a file, decide whether it is a database target. Use the injected package.json dependencies and repository file tree to discover which database libraries and patterns the project actually uses. A file is in scope when it imports, configures, or implements one of these:
-> ORM/database clients: Prisma, Drizzle, TypeORM, Sequelize, Mongoose, Supabase DB client, raw SQL clients, query builders
-> API routes/server actions that read or write growing tables/collections
-> schema/model definitions, migrations, indexes, relation definitions, or database config
-> high-traffic read paths: search, listing, feed, dashboard, profile, product/category browsing
-> high-value write paths: checkout, order creation, billing, subscription, inventory, account mutation, webhook persistence

Ignore and do not report non-database findings, even if they are real issues:
-> UI rendering issues, static pages, styling, client-only state
-> generic auth or payment correctness unless the evidence is specifically DB transaction/idempotency/storage related
-> realtime/event/AI/content delivery issues unless the database is the direct bottleneck

If a possible issue is adjacent, ask: "Would fixing this help the database handle 10x queries per second without degrading latency, exhausting connections, increasing lock waits, or saturating DB CPU/IOPS?" If no, discard it silently.

### PHASE 1 - Database Stack Understanding (No Tools)

Infer from package.json and file tree:
- orm: prisma | drizzle | typeorm | mongoose | raw SQL
- database: postgresql | mysql | mongodb | sqlite
- framework: Next.js App Router | Pages Router
- isServerless: true if Next.js (Vercel deploys = ephemeral functions)
- cacheLayer: redis | memcached | NONE (from ioredis, upstash, etc.)
- authLibs: clerk | next-auth | supabase-auth | custom
- paymentLibs: stripe | razorpay | paddle | NONE
- workloadShape: read-heavy | write-heavy | mixed | unknown
- likelyHotTables: users | sessions | products | orders | events | messages | posts | workspaces | unknown
- dbScaleSignals: indexes, pagination, batching, transactions, connection pooler, replicas, cache layer, queue-backed writes

These directly shape severity:
-> No cache layer = every DB bottleneck hits harder
-> isServerless + no connection pooler = pool exhaustion guaranteed at scale
-> paymentLibs present = financial flows must be transactional
-> authLibs = session/user queries fire on every authenticated request
-> read-heavy apps fail first through query latency and DB CPU/IOPS
-> write-heavy apps fail first through lock contention, slow transactions, and connection saturation

No database dependencies, schema/model files, ORM/client config, or database-looking route/action files = report INFO AND STOP WITHOUT USING TOOLS.

---

### PHASE 2 - Identify Investigation Targets

Build a target list from package.json and file tree first. Use the injected file tree as authoritative; do not spend tools trying to rebuild the tree.
Prefer files that own high-traffic reads, high-value writes, schema/indexes, or connection setup:

CRITICAL - financial and core write operations:
-> path contains: checkout, payment, order, purchase, confirm, verify-payment, create-order, razorpay, stripe, webhook

HIGH - core reads every user triggers constantly:
-> path contains: products, product, items, search, browse, categories, cart, user, profile, feed, home, dashboard, best-sellers, featured

MEDIUM - authenticated user actions triggered less frequently:
-> path contains: wishlist, reviews, address, coupon, settings, notifications, account

LOW - skip entirely:
-> path contains: export, report, seed, migrate, debug, test, dummy

Combine CRITICAL + top 3-4 HIGH items.
Skip MEDIUM and LOW unless they are the only items found.
Maximum 8 items total. Write the list explicitly before Phase 3.
Use searchCode only if injected context is not enough to choose target files. Pick your own compact query based on repository signals. Do not run one search per keyword.
Read highest-impact files first. Stop expanding when the failure mode is clear.

---

### PHASE 3 - Deep Database Analysis

For each item in your investigation list, use **getFileContent** to read the route handler or server action file. Read highest-impact files first. Stop expanding optional targets when the failure mode is clear.

**What to extract from each file:**

N+1 Queries - DB call inside a loop:
-> findMany/find followed by a .map() or for...of that makes another DB call
-> Example: fetching orders then fetching product details per order in a loop
-> At 1,000 concurrent users: 1,000 requests Ã— N items = N,000 DB queries simultaneously

Unbounded Queries - findMany with no take/limit/skip:
-> SELECT * with no pagination on tables that grow indefinitely
-> Products, orders, users tables all grow - unbounded reads will eventually table-scan

Missing Transactions - multiple writes without wrapping:
-> Payment flows that do: create order -> deduct inventory -> charge card -> update user
-> If step 3 fails, steps 1-2 already committed -> data corruption at scale

Deeply Nested Includes - 3+ levels of eager loading:
-> include: { order: { items: { product: { category: true } } } }
-> Generates enormous JOINs - fine at 100 rows, catastrophic at 100,000

Expensive Aggregates - count/groupBy on unindexed columns:
-> COUNT(*) or SUM() on large tables with no index on the WHERE column
-> Dashboard analytics queries are the most common offender

Lock Contention and Write Hotspots:
-> long transactions wrapping network calls or slow work
-> repeated updates to the same row/counter/status record
-> checkout/order/inventory writes without short, bounded transactional sections
-> bulk writes performed synchronously in request handlers
-> write amplification where one user action creates many DB writes

ORM Misuse:
-> unbounded .findMany(), .find(), scan, populate, or SELECT calls on growing data
-> select/include fetching entire rows or deep relations when only a few fields are needed
-> sequential awaits for independent queries that could be batched or joined safely
-> client-side filtering/sorting after fetching large result sets
-> missing take/limit/cursor pagination on user-facing lists

**For server action files specifically:**
-> Use **searchCode** only when import frequency changes severity or target selection
-> High import count = high traffic = higher severity for any issue found
-> Do not run one search per action; use one compact query for the shared export/import pattern

**Severity assignment per finding:**

CRITICAL route + N+1 = CRITICAL
CRITICAL route + unbounded query = CRITICAL
HIGH route + N+1 = CRITICAL
HIGH route + missing pagination = WARNING
HIGH route + missing transaction on writes = CRITICAL (if financial)
MEDIUM route + any issue = WARNING
Any route + nested includes 3+ levels = WARNING
Any high-write route + long transaction or shared-row update hotspot = CRITICAL if it blocks checkout/core writes, otherwise WARNING
Any route + unbounded ORM query on a growing table = WARNING; CRITICAL if route is core/high-traffic

If you have fewer than 3 CRITICAL findings and still have tool budget remaining, continue investigating additional files before synthesizing. Only stop early if the repository genuinely has no more database surface to investigate.
After finding 3 CRITICAL issues, stop expanding the investigation to new optional files. Run schema/index/connection checks only when they are in scope and the remaining tool budget allows it. Report every in-scope database finding already discovered. If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget, and never omit a discovered database finding just to hit a preferred finding count.

---

### PHASE 4 - Schema, Index & Connection Pool Checks

Run this phase only when database targets exist and the schema/client/config path is obvious from the injected file tree or discoverable with one compact search. Never exceed the tool budget to complete this phase.

Schema analysis:

Use **getFileContent** to read the schema file. If the schema path is not visible in the tree, use at most one compact search to locate it.

Correct file paths by ORM:
- Prisma -> prisma/schema.prisma (NOT src/lib/prisma.ts - that is the client)
- Drizzle -> db/schema.ts or src/db/schema.ts (NOT drizzle.config.ts)
- TypeORM -> *.entity.ts files (NOT the datasource config)
- Mongoose -> *.model.ts or *.schema.ts (NOT the connection file)

Cross-reference with Phase 3 findings:
-> For every findMany with a WHERE clause: is that column indexed?
-> For every foreign key relationship found: is the FK column indexed?
-> For every ORDER BY pattern found: is the sort column indexed?
-> For high-traffic tables (products, orders, users): are status/timestamp columns indexed?

Missing indexes on high-traffic filter columns are silent until the table hits ~100k rows, then queries degrade from milliseconds to seconds.

Connection pool analysis:

Use **searchCode** to find "PrismaClient" (or equivalent ORM client instantiation) only if the likely ORM client file is not obvious from the tree. Prefer reading visible lib/db/prisma files directly.

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

### PHASE 5 - Synthesis

Combine all findings and project scale ceilings:

Where it breaks:
-> Query latency: slow scans, missing indexes, N+1, deep joins, aggregates, or fetching too much data
-> Lock contention: long transactions, hot rows, repeated status/counter updates, write amplification
-> Connection pool exhaustion: per-request clients, serverless cold starts, missing pooler, too many concurrent DB calls

Scale analysis basis:
For each core DB flow, estimate the 10x QPS failure mode using:
-> read/write ratio: read-heavy, write-heavy, or mixed
-> query complexity: joins, nested includes, aggregations, scans, client-side filtering
-> index coverage: WHERE, JOIN/FK, ORDER BY, unique/idempotency, status/timestamp columns
-> DB CPU + IOPS pressure: number of queries per request, rows scanned/read/written, fan-out from N+1, write amplification
-> connection behavior: singleton/pooler, concurrent query count, serverless cold-start risk

For each CRITICAL finding, state: "This breaks at approximately X concurrent users because..."
Be specific. Vague scale estimates are not useful.

For every meaningful finding, answer: "Can this database handle 10x queries per second without degrading latency?"
State what fails first: query latency, lock contention, connection pool exhaustion, DB CPU, DB IOPS, or data inconsistency.

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, connection-pool recap, priority list, code snippets, or "if you want" follow-ups.
Do NOT call any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[DB-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact code pattern and why it fails.
Impact: max 1 sentence. Include what breaks at 10x QPS: query latency, lock contention, connection pool exhaustion, DB CPU/IOPS, or data inconsistency.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[DB-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[DB-3] Short title, max 10 words
File: path/to/file.ts or package/schema context
Evidence: max 1 sentence.
Use INFO only for useful context, healthy observations, or lower-confidence findings.

Severity definitions:
- CRITICAL: proven outage, data corruption, financial inconsistency, connection exhaustion, lock contention blocking core writes, or severe DB latency/CPU/IOPS overload on a core user path.
- WARNING: proven query-latency, index, ORM, transaction, or connection-pool risk that becomes painful with table/traffic growth but is not an immediate outage.
- INFO: context the orchestrator may optionally use; never include generic advice here.

Compression rules:
- Report every distinct in-scope database finding you discovered. Drop non-database findings silently.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause; do not merge unrelated findings.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then 10x QPS impact.
- Each finding must preserve: file, pattern/evidence, scale impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding; if there are many findings, shorten each field rather than omitting findings.
- Prefer one consolidated missing-index finding over separate index bullets.
- Prefer one checkout transaction finding unless sequential item writes are independently severe enough.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// --- Tools --------------------------------------------------------------------

const dbAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

// --- Main Exported Function ---------------------------------------------------

export async function runDatabaseAgent(
    input: DbAgentInput
): Promise<DbAgentOutput> {
    const { repositoryId, installationId, archetypeScore, onEvent } = input;
    const startTime = Date.now();


    let toolCallCount = 0;
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let lastToolName = "unknown";

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

        console.log(`[dbAgent] Repo: ${repository.fullName} (${branch})`);

        // -- Tool budget middleware (custom) ------------------------------
        // The built-in toolCallLimitMiddleware sends a vague "Tool call limit exceeded"
        // message that doesn't instruct the agent to produce its report.
        // This custom middleware sends explicit instructions to generate findings.
        const TOOL_BUDGET = 15;
        const SEARCH_BUDGET = 3;
        let _toolCalls = 0;
        let _searchCalls = 0;

        const toolBudgetMiddleware = createMiddleware({
            name: "ToolBudgetMiddleware",

            // --- Capture agent reasoning after every LLM call in the loop ---
            afterModel: (state: any) => {
                const lastMsg = state.messages?.[state.messages.length - 1];
                if (!lastMsg) return;

                // --- Extract reasoning from the AIMessage ---
                let reasoning = "";

                // 1. contentBlocks (LangChain standardized format)
                //    OpenAI: [{type:"reasoning", summary:[{type:"summary_text", text:"..."}]}, {type:"text", text:"..."}]
                //    Anthropic: [{type:"thinking", thinking:"..."}, {type:"text", text:"..."}]
                const blocks = lastMsg.contentBlocks ?? lastMsg.content_blocks;
                if (Array.isArray(blocks)) {
                    for (const block of blocks) {
                        if (block.type === "reasoning" && Array.isArray(block.summary)) {
                            // OpenAI reasoning format
                            const summaryTexts = block.summary
                                .filter((s: any) => s.type === "summary_text" && s.text)
                                .map((s: any) => s.text);
                            if (summaryTexts.length > 0) reasoning += summaryTexts.join(" ");
                        } else if (block.type === "thinking" && block.thinking) {
                            // Anthropic thinking format
                            reasoning += block.thinking;
                        } else if (block.type === "text" && block.text) {
                            // Plain text content alongside tool_calls
                            reasoning += block.text;
                        }
                    }
                }

                // 2. Fallback: message.content as string
                if (!reasoning && typeof lastMsg.content === "string" && lastMsg.content.trim()) {
                    reasoning = lastMsg.content.trim();
                }

                // 3. Fallback: message.content as array of parts
                if (!reasoning && Array.isArray(lastMsg.content)) {
                    const textParts = lastMsg.content
                        .filter((p: any) => (p.type === "text" && p.text) || (p.type === "reasoning"))
                        .map((p: any) => {
                            if (p.type === "reasoning" && Array.isArray(p.summary)) {
                                return p.summary.map((s: any) => s.text).filter(Boolean).join(" ");
                            }
                            return p.text ?? "";
                        });
                    if (textParts.length > 0) reasoning = textParts.join("\n").trim();
                }

                // --- Extract tool calls being made ---
                const toolCalls = lastMsg.tool_calls ?? [];
                const toolNames = toolCalls.map((tc: any) => tc.name ?? "?").join(", ");

                // --- Log reasoning ---
                if (reasoning) {
                    console.log(`\n💭 [Agent] Reasoning: ${reasoning.slice(0, 500)}${reasoning.length > 500 ? "..." : ""}`);
                    emit({
                        type: "agent_thought",
                        stepNumber: toolCallCount,
                        timestamp: new Date().toISOString(),
                        elapsedMs: Date.now() - startTime,
                        reasoning: reasoning.slice(0, 2000),
                        cumulativeTokens: {
                            inputTokens: cumulativeInputTokens,
                            outputTokens: cumulativeOutputTokens,
                            totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                        },
                    });
                }

                if (toolCalls.length > 0) {
                    console.log(`🤖 [Agent] Selecting tool(s): ${toolNames}`);
                    if (toolCalls[0]?.name) lastToolName = toolCalls[0].name;
                }

                // --- Extract token usage ---
                const usageMeta = lastMsg.usage_metadata;
                if (usageMeta) {
                    const inTok = usageMeta.input_tokens ?? 0;
                    const outTok = usageMeta.output_tokens ?? 0;
                    cumulativeInputTokens += inTok;
                    cumulativeOutputTokens += outTok;
                    console.log(`📊 [Agent] Tokens: +${inTok}in/+${outTok}out (cumulative: ${cumulativeInputTokens}in/${cumulativeOutputTokens}out)`);

                    emit({
                        type: "llm_end",
                        stepNumber: toolCallCount,
                        timestamp: new Date().toISOString(),
                        elapsedMs: Date.now() - startTime,
                        tokenUsage: { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok },
                        cumulativeTokens: {
                            inputTokens: cumulativeInputTokens,
                            outputTokens: cumulativeOutputTokens,
                            totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                        },
                    });
                }

                return; // no state mutation
            },

            // --- Enforce tool budgets ---
            wrapToolCall: async (request: any, handler: any) => {
                const toolName = request.toolCall?.name ?? "unknown";
                _toolCalls++;

                // Per-tool limit: searchCode
                if (toolName === "searchCode") {
                    _searchCalls++;
                    if (_searchCalls > SEARCH_BUDGET) {
                        console.log(`🚫 [Middleware] searchCode BLOCKED (${_searchCalls}/${SEARCH_BUDGET})`);
                        return new ToolMessage({
                            content: `searchCode budget exhausted (${SEARCH_BUDGET}/${SEARCH_BUDGET} used). Do NOT call searchCode again. Use getFileContent to navigate the file tree instead, or if you have enough evidence, generate your findings report now.`,
                            tool_call_id: request.toolCall?.id ?? "unknown",
                        });
                    }
                }

                // Global tool limit
                if (_toolCalls > TOOL_BUDGET) {
                    console.log(`🚫 [Middleware] TOOL BUDGET EXHAUSTED (${_toolCalls}/${TOOL_BUDGET}) — blocking ${toolName}`);
                    return new ToolMessage({
                        content: `TOOL BUDGET EXHAUSTED (${TOOL_BUDGET}/${TOOL_BUDGET} calls used). You MUST stop calling tools immediately. Generate your final findings report NOW using all evidence gathered so far. Output the compact findings digest as described in your system prompt. Do not attempt any more tool calls.`,
                        tool_call_id: request.toolCall?.id ?? "unknown",
                    });
                }

                // Within budget — execute normally
                console.log(`📋 [Middleware] Tool ${_toolCalls}/${TOOL_BUDGET}: ${toolName}`);
                return handler(request);
            },
        });

        // -- Create agent & invoke ----------------------------------------
        const agent = createAgent({
            model: gpt5Mini,
            tools: dbAgentTools,
            systemPrompt: SYSTEM_PROMPT,
            contextSchema: githubContextSchema,
            middleware: [toolBudgetMiddleware],
        });

        // NOTE: intermediateSteps and agentLog contain the installationId
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
1. **N+1 Detection** - Find DB calls inside loops on high-traffic routes and actions
2. **Unbounded Query Detection** - Find findMany/SELECT calls with no pagination on growing tables
3. **Transaction Safety** - Identify multi-write flows (especially financial) with no transaction wrapper
4. **Index Gap Analysis** - Cross-reference query patterns against schema to find missing indexes
5. **Connection Pool Risk** - Assess whether the connection strategy survives serverless cold starts at scale
6. **Lock Contention Risk** - Identify long transactions, hot-row updates, and write amplification on core writes
7. **10x QPS Capacity** - State whether query latency, lock contention, connection pool exhaustion, DB CPU, or DB IOPS breaks first

**Analysis Approach:**
- Start with the package.json and file tree provided above - identify API routes, schema files, and lib files immediately (Phase 1, no tools needed)
- Classify routes and actions by traffic priority before reading any files
- Use getFileContent(path) strategically on high-priority targets only
- Use searchCode(query) only when the file tree is not enough to choose a target or validate a high-impact pattern
- Read schema file once to cross-reference all query findings at once
- For each finding, evaluate read/write ratio, query complexity, index coverage, DB CPU/IOPS pressure, and connection behavior
- Tools already know the repo details - just pass the file path or search query

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest, never exceed this limit
- searchCode limit: use at most 3 searches total
- searchCode EARLY EXIT: if 2 consecutive searches return 0 results, stop using searchCode entirely and navigate the file tree with getFileContent instead
- Decide yourself whether searchCode is needed; do not follow a preset search query
- Use package.json and file tree before tools

**Constraint:** Minimize tool usage - leverage the file tree and package.json above first, then make targeted tool calls only for confirmed high-traffic files. If you are near the tool limit, stop using tools and synthesize from available evidence.
**Scope constraint:** Only report database scalability risks: query latency, lock contention, connection pool exhaustion, missing indexes, ORM misuse, N+1 queries, unbounded queries, transaction safety, DB CPU, and DB IOPS. Ignore unrelated issues silently.
**Key question:** Can this database handle 10x queries per second without degrading latency?
**Reporting constraint:** If you discover a distinct in-scope database finding, you must report it. Drop non-database findings silently. Do not drop database findings to satisfy a preferred count or budget; keep within budget by compressing wording and merging only genuinely overlapping duplicates.

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, installationId },
                recursionLimit: 50,
                callbacks: [
                    {
                        handleToolStart(tool: any, input: string) {
                            // Increment tool call counter (this is the only reliable callback that fires per tool call)
                            toolCallCount++;

                            // Resolve tool name — try multiple paths since LangChain serializes differently
                            const toolName = tool.name ?? tool.constructor.name;
                            lastToolName = toolName;

                            console.log(`\n🔧 [Step ${toolCallCount}/15] TOOL CALL: ${toolName}`);

                            emit({
                                type: "tool_start",
                                stepNumber: toolCallCount,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                toolName,
                                toolInput: input,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },

                        handleToolEnd(output: any) {
                            // Extract clean content from LangChain ToolMessage objects
                            let cleanOutput: string;
                            if (typeof output === "string") {
                                cleanOutput = output;
                            } else if (output?.content != null) {
                                // ToolMessage object — extract .content directly
                                cleanOutput = typeof output.content === "string"
                                    ? output.content
                                    : JSON.stringify(output.content);
                            } else if (output?.kwargs?.content != null) {
                                // Serialized ToolMessage — extract from .kwargs.content
                                cleanOutput = typeof output.kwargs.content === "string"
                                    ? output.kwargs.content
                                    : JSON.stringify(output.kwargs.content);
                            } else {
                                cleanOutput = JSON.stringify(output) ?? "";
                            }

                            // Detect middleware limit responses
                            const isMiddlewareBlock = cleanOutput.includes("Tool call limit")
                                || cleanOutput.includes("ToolCallLimitExceeded")
                                || cleanOutput.includes("tool call limit reached");

                            if (isMiddlewareBlock) {
                                console.log(`🚫 [Step ${toolCallCount}/15] MIDDLEWARE BLOCKED: ${lastToolName}`);
                            } else {
                                console.log(`📄 [Step ${toolCallCount}/15] TOOL RESPONSE: ${lastToolName} (${cleanOutput.length} chars)`);
                                console.log(`   Preview: ${cleanOutput.slice(0, 200)}${cleanOutput.length > 200 ? "..." : ""}`);
                            }

                            emit({
                                type: "tool_end",
                                stepNumber: toolCallCount,
                                timestamp: new Date().toISOString(),
                                elapsedMs: Date.now() - startTime,
                                toolName: lastToolName,
                                toolOutput: cleanOutput.length > 5000
                                    ? cleanOutput.slice(0, 5000) + "\n... [truncated]"
                                    : cleanOutput,
                                toolOutputLength: cleanOutput.length,
                                cumulativeTokens: {
                                    inputTokens: cumulativeInputTokens,
                                    outputTokens: cumulativeOutputTokens,
                                    totalTokens: cumulativeInputTokens + cumulativeOutputTokens,
                                },
                            });
                        },

                        handleLLMEnd(output: any) {
                            // Token extraction — kept as fallback for when afterModel doesn't fire
                            // (e.g., in nested chains or legacy compatibility)
                            const usage = output?.llmOutput?.tokenUsage
                                ?? output?.llmOutput?.usage
                                ?? null;
                            if (usage) {
                                const inTok = usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? 0;
                                const outTok = usage.completionTokens ?? usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? 0;
                                // Only add if afterModel didn't already count these
                                // (afterModel uses usage_metadata which is the same data)
                                // We skip to avoid double-counting
                            }
                        },

                        handleChainError(error: Error) {
                            console.log(`\n❌ [dbAgent] CHAIN ERROR: ${error.message}`);

                            emit({
                                type: "error",
                                stepNumber: toolCallCount,
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

        console.log(`\n✅ [dbAgent] Complete. ${totalToolCalls} tool calls, ${rawFindings.length} chars findings, ${executionTimeMs}ms`);
        console.log(`📊 [dbAgent] Final tokens: ${cumulativeInputTokens}in / ${cumulativeOutputTokens}out`);



        // Emit done event with final totals
        emit({
            type: "done",
            stepNumber: toolCallCount,
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



        emit({
            type: "done",
            stepNumber: toolCallCount,
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
