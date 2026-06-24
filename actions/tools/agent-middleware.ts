/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared agent middleware factory.
 *
 * Creates a single middleware that:
 *   1. afterModel — captures agent reasoning (contentBlocks, content string/array) and token usage
 *   2. wrapToolCall — enforces global tool budget + per-tool searchCode limit with custom messages
 *
 * Usage:
 *   const { middleware, getToolCallCount } = createToolBudgetMiddleware({ ... });
 *   const agent = createAgent({ ..., middleware: [middleware] });
 */

import { createMiddleware } from "langchain";
import { ToolMessage } from "@langchain/core/messages";

// --- Types re-exported for convenience ---

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



// --- Tool name resolution helpers ---

export function normalizeToolName(name: unknown): string | null {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower === "dynamicstructuredtool" || lower === "structuredtool") return null;
    return trimmed;
}

export function resolveCallbackToolName(tool: any, fallback?: string): string {
    const idCandidate = Array.isArray(tool?.id) ? tool.id[tool.id.length - 1] : tool?.id;
    return (
        normalizeToolName(tool?.name) ??
        normalizeToolName(tool?.lc_kwargs?.name) ??
        normalizeToolName(idCandidate) ??
        normalizeToolName(fallback) ??
        "unknown"
    );
}

// --- Middleware factory ---

export interface ToolBudgetMiddlewareOptions {
    /** Agent label for log prefixing, e.g. "dbAgent" */
    agentLabel: string;
    /** Max total tool calls before blocking (default 15) */
    toolBudget?: number;
    /** Max searchCode calls before blocking (default 3) */
    searchBudget?: number;
    /** Mutable counters & refs shared with the caller */
    shared: {
        toolCallCount: number;
        cumulativeInputTokens: number;
        cumulativeOutputTokens: number;
        lastToolName: string;
        startTime: number;
        emit: (event: StreamEvent) => void;
    };
}

export function createToolBudgetMiddleware(opts: ToolBudgetMiddlewareOptions) {
    const TOOL_BUDGET = opts.toolBudget ?? 15;
    const SEARCH_BUDGET = opts.searchBudget ?? 3;
    let _toolCalls = 0;
    let _searchCalls = 0;
    const s = opts.shared;

    const middleware = createMiddleware({
        name: "ToolBudgetMiddleware",

        // --- Capture agent reasoning after every LLM call in the loop ---
        afterModel: (state: any) => {
            const lastMsg = state.messages?.[state.messages.length - 1];
            if (!lastMsg) return;

            // --- Extract reasoning from the AIMessage ---
            let reasoning = "";

            // 1. contentBlocks (LangChain standardized format)
            const blocks = lastMsg.contentBlocks ?? lastMsg.content_blocks;
            if (Array.isArray(blocks)) {
                for (const block of blocks) {
                    if (block.type === "reasoning" && Array.isArray(block.summary)) {
                        const summaryTexts = block.summary
                            .filter((x: any) => x.type === "summary_text" && x.text)
                            .map((x: any) => x.text);
                        if (summaryTexts.length > 0) reasoning += summaryTexts.join(" ");
                    } else if (block.type === "thinking" && block.thinking) {
                        reasoning += block.thinking;
                    } else if (block.type === "text" && block.text) {
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
                    .filter((p: any) => (p.type === "text" && p.text) || p.type === "reasoning")
                    .map((p: any) => {
                        if (p.type === "reasoning" && Array.isArray(p.summary)) {
                            return p.summary.map((x: any) => x.text).filter(Boolean).join(" ");
                        }
                        return p.text ?? "";
                    });
                if (textParts.length > 0) reasoning = textParts.join("\n").trim();
            }

            // --- Tool calls ---
            const toolCalls = lastMsg.tool_calls ?? [];
            const toolNames = toolCalls.map((tc: any) => tc.name ?? "?").join(", ");

            // --- Log reasoning ---
            if (reasoning) {
                console.log(`\n💭 [${opts.agentLabel}] Reasoning: ${reasoning.slice(0, 500)}${reasoning.length > 500 ? "..." : ""}`);
                s.emit({
                    type: "agent_thought",
                    stepNumber: s.toolCallCount,
                    timestamp: new Date().toISOString(),
                    elapsedMs: Date.now() - s.startTime,
                    reasoning: reasoning.slice(0, 2000),
                    cumulativeTokens: {
                        inputTokens: s.cumulativeInputTokens,
                        outputTokens: s.cumulativeOutputTokens,
                        totalTokens: s.cumulativeInputTokens + s.cumulativeOutputTokens,
                    },
                });
            }

            if (toolCalls.length > 0) {
                console.log(`🤖 [${opts.agentLabel}] Selecting tool(s): ${toolNames}`);
                if (toolCalls[0]?.name) s.lastToolName = toolCalls[0].name;
            }

            // --- Token usage ---
            const usageMeta = lastMsg.usage_metadata;
            if (usageMeta) {
                const inTok = usageMeta.input_tokens ?? 0;
                const outTok = usageMeta.output_tokens ?? 0;
                s.cumulativeInputTokens += inTok;
                s.cumulativeOutputTokens += outTok;
                console.log(`📊 [${opts.agentLabel}] Tokens: +${inTok}in/+${outTok}out (cumulative: ${s.cumulativeInputTokens}in/${s.cumulativeOutputTokens}out)`);

                s.emit({
                    type: "llm_end",
                    stepNumber: s.toolCallCount,
                    timestamp: new Date().toISOString(),
                    elapsedMs: Date.now() - s.startTime,
                    tokenUsage: { inputTokens: inTok, outputTokens: outTok, totalTokens: inTok + outTok },
                    cumulativeTokens: {
                        inputTokens: s.cumulativeInputTokens,
                        outputTokens: s.cumulativeOutputTokens,
                        totalTokens: s.cumulativeInputTokens + s.cumulativeOutputTokens,
                    },
                });
            }

            return; // no state mutation
        },

        // --- Enforce tool budgets ---
        wrapToolCall: async (request: any, handler: any) => {
            const toolName = request.toolCall?.name ?? "unknown";
            _toolCalls++;

            // --- Per-tool limit: searchCode ---
            if (toolName === "searchCode") {
                _searchCalls++;

                // Hard block: over budget
                if (_searchCalls > SEARCH_BUDGET) {
                    const blockMsg = `searchCode budget exhausted (${SEARCH_BUDGET}/${SEARCH_BUDGET} used). Do NOT call searchCode again. Use getFileContent to navigate the file tree instead, or if you have enough evidence, generate your findings report now.`;
                    console.log(`🚫 [${opts.agentLabel}] searchCode BLOCKED (${_searchCalls}/${SEARCH_BUDGET})`);
                    console.log(`   📨 Middleware → Agent: "${blockMsg.slice(0, 120)}..."`);
                    return new ToolMessage({
                        content: blockMsg,
                        tool_call_id: request.toolCall?.id ?? "unknown",
                    });
                }

                // Proactive warning: last allowed searchCode call
                if (_searchCalls === SEARCH_BUDGET) {
                    console.log(`📋 [${opts.agentLabel}] Tool ${_toolCalls}/${TOOL_BUDGET}: ${toolName} (LAST searchCode — ${_searchCalls}/${SEARCH_BUDGET})`);
                    const result = await handler(request);
                    const originalContent = typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? "");
                    const warning = `\n\n⚠️ SEARCH BUDGET REACHED (${SEARCH_BUDGET}/${SEARCH_BUDGET} searchCode calls used). This was your LAST searchCode call. Do NOT call searchCode again — use getFileContent to read specific files instead. If you already have 3 or more CRITICAL findings, generate your final findings report NOW.`;
                    console.log(`   ⚠️ Appended search budget warning to response`);
                    return new ToolMessage({
                        content: originalContent + warning,
                        tool_call_id: result?.tool_call_id ?? request.toolCall?.id ?? "unknown",
                    });
                }
            }

            // --- Global tool limit ---
            // Hard block: over budget
            if (_toolCalls > TOOL_BUDGET) {
                const blockMsg = `TOOL BUDGET EXHAUSTED (${TOOL_BUDGET}/${TOOL_BUDGET} calls used). You MUST stop calling tools immediately. Generate your final findings report NOW using all evidence gathered so far. Output the compact findings digest as described in your system prompt. Do not attempt any more tool calls.`;
                console.log(`🚫 [${opts.agentLabel}] TOOL BUDGET EXHAUSTED (${_toolCalls}/${TOOL_BUDGET}) — blocking ${toolName}`);
                console.log(`   📨 Middleware → Agent: "${blockMsg.slice(0, 120)}..."`);
                return new ToolMessage({
                    content: blockMsg,
                    tool_call_id: request.toolCall?.id ?? "unknown",
                });
            }

            // Proactive warning: last allowed global tool call
            if (_toolCalls === TOOL_BUDGET) {
                console.log(`📋 [${opts.agentLabel}] Tool ${_toolCalls}/${TOOL_BUDGET}: ${toolName} (LAST tool call)`);
                const result = await handler(request);
                const originalContent = typeof result?.content === "string" ? result.content : JSON.stringify(result?.content ?? "");
                const warning = `\n\n⚠️ TOOL BUDGET REACHED (${TOOL_BUDGET}/${TOOL_BUDGET} total calls used). This was your LAST tool call. You MUST generate your final findings report NOW. Do not attempt any more tool calls. Output the compact findings digest from all evidence gathered so far.`;
                console.log(`   ⚠️ Appended global budget warning to response`);
                return new ToolMessage({
                    content: originalContent + warning,
                    tool_call_id: result?.tool_call_id ?? request.toolCall?.id ?? "unknown",
                });
            }

            // Within budget — execute normally
            console.log(`📋 [${opts.agentLabel}] Tool ${_toolCalls}/${TOOL_BUDGET}: ${toolName}`);
            return handler(request);
        },
    });

    return {
        middleware,
        getToolCallCount: () => _toolCalls,
        getSearchCallCount: () => _searchCalls,
    };
}
