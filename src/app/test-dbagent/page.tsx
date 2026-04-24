"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Archetype {
    name: string;
    score: number;
}

interface RepoRecord {
    id: string;
    repositoryId: string;
    name: string;
    fullName: string;
    owner: string;
    defaultBranch: string | null;
    framework: string | null;
    archetypes: Archetype[] | null;
    isSupported: boolean;
    packageJson: Record<string, unknown> | null;
    user: {
        githubAccessToken: string | null;
        githubInstallationId: string | null;
        githubUsername: string | null;
        email: string;
    };
}

type AgentVariant = "legacy" | "graph";

interface ToolCall {
    name: string;
    args: Record<string, unknown>;
}

interface Message {
    role: string;
    name?: string;
    content?: string;
    tool_calls?: ToolCall[];
}

interface AgentOutput {
    variant?: AgentVariant;
    rawFindings: string | null;
    intermediateSteps: Message[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

interface StreamEvent {
    type: "tool_start" | "tool_end" | "llm_end" | "agent_thought" | "error" | "done" | "agent_start" | "result";
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
    report?: Record<string, unknown> | null;
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
    // result event fields
    variant?: AgentVariant;
    intermediateSteps?: Message[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getBestArchetypeScore(archetypes: Archetype[] | null): number {
    if (!archetypes || archetypes.length === 0) return 0.5;
    const db = archetypes.find((a) => a.name.toLowerCase().includes("database"));
    if (db) return db.score;
    return archetypes[0].score;
}

function severityBadge(sev: string) {
    const base =
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold";
    if (sev === "critical")
        return `${base} bg-red-500/20 text-red-400 border border-red-500/30`;
    if (sev === "warning")
        return `${base} bg-amber-500/20 text-amber-400 border border-amber-500/30`;
    return `${base} bg-blue-500/20 text-blue-400 border border-blue-500/30`;
}

function verdictColor(v: string) {
    if (v === "healthy") return "text-emerald-400";
    if (v === "degraded") return "text-amber-400";
    if (v === "critical") return "text-orange-400";
    return "text-red-500";
}

function verdictDot(v: string) {
    if (v === "healthy") return "bg-emerald-400";
    if (v === "degraded") return "bg-amber-400";
    if (v === "critical") return "bg-orange-400";
    return "bg-red-500";
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

function formatMs(ms: number): string {
    if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
    return `${(ms / 1_000).toFixed(1)}s`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
            {children}
        </p>
    );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-gray-900 border border-white/10 rounded-xl p-5 ${className}`}>
            {children}
        </div>
    );
}

function ScaleTierCard({
    tier,
    data,
}: {
    tier: string;
    data: { verdict: string; primaryIssues: string[] };
}) {
    return (
        <div className="bg-gray-800/60 border border-white/5 rounded-lg p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <span
                    className={`w-2 h-2 rounded-full ${verdictDot(data.verdict)} shrink-0`}
                />
                <span className="text-sm font-semibold text-gray-200">{tier}</span>
                <span className={`ml-auto text-xs font-bold uppercase ${verdictColor(data.verdict)}`}>
                    {data.verdict}
                </span>
            </div>
            {data.primaryIssues.length > 0 && (
                <ul className="pl-4 space-y-1">
                    {data.primaryIssues.map((issue, i) => (
                        <li key={i} className="text-xs text-gray-400 list-disc">
                            {issue}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function FindingCard({ finding }: { finding: Record<string, unknown> }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="bg-gray-800/40 border border-white/5 rounded-lg overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
            >
                <span className={severityBadge(finding.severity as string)}>
                    {finding.severity as string}
                </span>
                <span className="text-sm font-medium text-gray-200 flex-1 truncate">
                    {finding.title as string}
                </span>
                <span className="text-xs text-gray-500 shrink-0">
                    {finding.category as string}
                </span>
                <svg
                    className={`w-4 h-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                    />
                </svg>
            </button>
            {open && (
                <div className="px-4 pb-4 pt-2 border-t border-white/5 space-y-3">
                    <p className="text-sm text-gray-300">{finding.detail as string}</p>
                    <div className="flex gap-4 flex-wrap">
                        <div>
                            <Label>Breaks at</Label>
                            <p className="text-sm text-orange-300">{finding.breaksAt as string}</p>
                        </div>
                        <div>
                            <Label>Fix</Label>
                            <p className="text-sm text-emerald-300">{finding.fix as string}</p>
                        </div>
                    </div>
                    {Boolean(finding.evidence) && Object.keys(finding.evidence as object).length > 0 && (
                        <div>
                            <Label>Evidence</Label>
                            <pre className="text-xs bg-black/40 rounded p-3 overflow-auto max-h-40 text-gray-300">
                                {JSON.stringify(finding.evidence, null, 2)}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ToolStepRow({ msg, index }: { msg: Message; index: number }) {
    const [open, setOpen] = useState(false);
    const isToolCall = (msg.tool_calls?.length ?? 0) > 0;
    const isToolResult = msg.role === "tool";

    let icon = "💬";
    let label = "message";
    if (isToolCall) { icon = "🔧"; label = "tool call"; }
    if (isToolResult) { icon = "✅"; label = "tool result"; }

    const toolName = isToolCall
        ? msg.tool_calls![0].name
        : isToolResult
            ? (msg.name ?? "tool")
            : "";

    return (
        <div className="border border-white/5 rounded-lg overflow-hidden text-xs">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left"
            >
                <span className="shrink-0">{icon}</span>
                <span className="text-gray-400 shrink-0">#{index + 1}</span>
                <span className="font-mono font-semibold text-gray-200 truncate flex-1">
                    {toolName || label}
                </span>
                <span className="text-gray-500 shrink-0">{msg.role}</span>
                <svg
                    className={`w-3 h-3 text-gray-600 transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            {open && (
                <pre className="p-3 bg-black/40 overflow-auto max-h-64 text-gray-300 whitespace-pre-wrap break-all">
                    {JSON.stringify(msg, null, 2)}
                </pre>
            )}
        </div>
    );
}

// ─── Live Log Event Row ───────────────────────────────────────────────────────

const EVENT_CONFIG: Record<string, { icon: string; label: string; color: string; bg: string }> = {
    agent_start: { icon: "🚀", label: "Start", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
    tool_start: { icon: "🔧", label: "Tool Call", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20" },
    tool_end: { icon: "✅", label: "Tool Result", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
    llm_end: { icon: "🧠", label: "LLM", color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20" },
    agent_thought: { icon: "💭", label: "Thought", color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20" },
    error: { icon: "❌", label: "Error", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
    done: { icon: "🏁", label: "Done", color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
};

function LiveEventRow({ event }: { event: StreamEvent }) {
    const [open, setOpen] = useState(false);
    const config = EVENT_CONFIG[event.type] ?? { icon: "📋", label: event.type, color: "text-gray-400", bg: "bg-gray-500/10 border-gray-500/20" };

    // Don't render llm_end events with 0 tokens as separate rows (noise)
    if (event.type === "llm_end" && (!event.tokenUsage || event.tokenUsage.totalTokens === 0)) {
        return null;
    }

    const hasExpandable = event.toolInput || event.toolOutput || event.reasoning || event.error;

    return (
        <div className={`border rounded-lg overflow-hidden text-xs ${config.bg}`}>
            <button
                onClick={() => hasExpandable && setOpen((o) => !o)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${hasExpandable ? "hover:bg-white/5 cursor-pointer" : "cursor-default"}`}
            >
                {/* Icon */}
                <span className="shrink-0 text-sm">{config.icon}</span>

                {/* Step number */}
                <span className="text-gray-500 shrink-0 font-mono w-6 text-right">
                    {event.stepNumber > 0 ? `#${event.stepNumber}` : ""}
                </span>

                {/* Type badge */}
                <span className={`shrink-0 font-semibold ${config.color}`}>
                    {config.label}
                </span>

                {/* Tool name or summary */}
                <span className="font-mono text-gray-200 truncate flex-1">
                    {event.toolName && (
                        <span className="text-cyan-300">{event.toolName}</span>
                    )}
                    {event.type === "tool_end" && event.toolOutputLength !== undefined && (
                        <span className="text-gray-500 ml-2">
                            ({formatTokens(event.toolOutputLength)} chars)
                        </span>
                    )}
                    {event.type === "llm_end" && event.tokenUsage && (
                        <span className="text-purple-300 ml-1">
                            ↓{formatTokens(event.tokenUsage.inputTokens)} ↑{formatTokens(event.tokenUsage.outputTokens)}
                        </span>
                    )}
                    {event.reasoning && (
                        <span className="text-gray-400 ml-1 truncate">
                            {event.reasoning?.slice(0, 80)}…
                        </span>
                    )}
                    {!event.reasoning && event.type === "error" && (
                        <span className="text-red-300 ml-1 truncate">{event.error}</span>
                    )}
                </span>

                {/* Elapsed time */}
                <span className="text-gray-600 shrink-0 font-mono text-[10px]">
                    {formatMs(event.elapsedMs)}
                </span>

                {/* Cumulative tokens */}
                {event.cumulativeTokens && event.cumulativeTokens.totalTokens > 0 && (
                    <span className="text-gray-600 shrink-0 font-mono text-[10px] w-16 text-right">
                        Σ{formatTokens(event.cumulativeTokens.totalTokens)}
                    </span>
                )}

                {/* Expand arrow */}
                {hasExpandable && (
                    <svg
                        className={`w-3 h-3 text-gray-600 transition-transform shrink-0 ${open ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                )}
            </button>

            {/* Expandable content */}
            {open && (
                <div className="border-t border-white/5">
                    {/* Tool Input */}
                    {event.toolInput !== undefined && event.toolInput !== null && (
                        <div className="px-3 py-2">
                            <p className="text-[10px] font-bold uppercase text-blue-400 mb-1">Input</p>
                            <pre className="text-xs bg-black/40 rounded p-2.5 overflow-auto max-h-48 text-gray-300 whitespace-pre-wrap break-all">
                                {typeof event.toolInput === "string"
                                    ? event.toolInput
                                    : JSON.stringify(event.toolInput, null, 2)}
                            </pre>
                        </div>
                    )}

                    {/* Tool Output */}
                    {event.toolOutput && (
                        <div className="px-3 py-2">
                            <p className="text-[10px] font-bold uppercase text-green-400 mb-1">
                                Output
                                {event.toolOutputLength && (
                                    <span className="text-gray-500 font-normal ml-2">
                                        ({event.toolOutputLength.toLocaleString()} chars)
                                    </span>
                                )}
                            </p>
                            <pre className="text-xs bg-black/40 rounded p-2.5 overflow-auto max-h-64 text-gray-300 whitespace-pre-wrap break-all">
                                {event.toolOutput}
                            </pre>
                        </div>
                    )}

                    {/* Reasoning / Thought */}
                    {event.reasoning && (
                        <div className="px-3 py-2">
                            <p className="text-[10px] font-bold uppercase text-gray-400 mb-1">Reasoning</p>
                            <p className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">
                                {event.reasoning}
                            </p>
                        </div>
                    )}

                    {/* Error */}
                    {event.error && (
                        <div className="px-3 py-2">
                            <p className="text-[10px] font-bold uppercase text-red-400 mb-1">Error</p>
                            <pre className="text-xs text-red-300 whitespace-pre-wrap">{event.error}</pre>
                        </div>
                    )}

                    {/* Token usage detail */}
                    {event.tokenUsage && event.tokenUsage.totalTokens > 0 && (
                        <div className="px-3 py-2 flex gap-4">
                            <div>
                                <span className="text-[10px] text-gray-500">Input Tokens</span>
                                <p className="text-sm font-mono text-purple-300">{event.tokenUsage.inputTokens.toLocaleString()}</p>
                            </div>
                            <div>
                                <span className="text-[10px] text-gray-500">Output Tokens</span>
                                <p className="text-sm font-mono text-purple-300">{event.tokenUsage.outputTokens.toLocaleString()}</p>
                            </div>
                            <div>
                                <span className="text-[10px] text-gray-500">Total</span>
                                <p className="text-sm font-mono text-purple-200">{event.tokenUsage.totalTokens.toLocaleString()}</p>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TestDbAgentPage() {
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);

    const [selectedRepoId, setSelectedRepoId] = useState<string>("");
    const [agentVariant, setAgentVariant] = useState<AgentVariant>("legacy");
    const [archetypeScore, setArchetypeScore] = useState<number>(0.5);
    const [accessTokenOverride, setAccessTokenOverride] = useState<string>("");
    const [useTokenOverride, setUseTokenOverride] = useState(false);

    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AgentOutput | null>(null);
    const [activeTab, setActiveTab] = useState<"report" | "steps" | "live">("live");

    // Live streaming state
    const [liveEvents, setLiveEvents] = useState<StreamEvent[]>([]);
    const [tokenTotals, setTokenTotals] = useState({ input: 0, output: 0 });
    const [elapsedMs, setElapsedMs] = useState(0);
    const [stepsCompleted, setStepsCompleted] = useState(0);
    const logEndRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    // Auto-scroll live log
    useEffect(() => {
        if (autoScroll && logEndRef.current) {
            logEndRef.current.scrollIntoView({ behavior: "smooth" });
        }
    }, [liveEvents, autoScroll]);

    // ── Load repositories on mount ──
    useEffect(() => {
        async function load() {
            try {
                const res = await fetch("/api/agent/repositories");
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? "Failed to load");
                setRepos(data.repositories ?? []);
            } catch (e) {
                setReposError(e instanceof Error ? e.message : "Unknown error");
            } finally {
                setLoadingRepos(false);
            }
        }
        load();
    }, []);

    // ── Sync archetype score when repo changes ──
    const selectedRepo = repos.find((r) => r.repositoryId === selectedRepoId) ?? null;

    useEffect(() => {
        if (selectedRepo) {
            setArchetypeScore(getBestArchetypeScore(selectedRepo.archetypes));
        }
    }, [selectedRepo]);

    // ── Run agent with SSE streaming ──
    const runAgent = useCallback(async () => {
        if (!selectedRepo) return;

        const oauthToken = useTokenOverride
            ? accessTokenOverride.trim()
            : (selectedRepo.user.githubAccessToken ?? "");

        const installationId = selectedRepo.user.githubInstallationId;

        if (!oauthToken && !installationId) {
            alert("No access token or installation ID available. Enable the override and paste a token.");
            return;
        }

        setRunning(true);
        setResult(null);
        setLiveEvents([]);
        setTokenTotals({ input: 0, output: 0 });
        setElapsedMs(0);
        setStepsCompleted(0);
        setActiveTab("live");

        try {
            const res = await fetch("/api/agent/db-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repositoryId: selectedRepo.repositoryId,
                    ...(oauthToken ? { accessToken: oauthToken } : { installationId }),
                    archetypeScore,
                    agentVariant,
                }),
            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({ error: "Request failed" }));
                throw new Error(errBody.error ?? `HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Parse SSE events from buffer
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? ""; // keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;

                    const jsonStr = trimmed.slice(6);
                    try {
                        const event: StreamEvent = JSON.parse(jsonStr);

                        if (event.type === "result") {
                            // Final result with report + intermediateSteps
                            setResult({
                                variant: event.variant ?? agentVariant,
                                rawFindings: event.rawFindings ?? null,
                                intermediateSteps: event.intermediateSteps ?? [],
                                totalToolCalls: event.totalToolCalls ?? 0,
                                executionTimeMs: event.executionTimeMs ?? 0,
                                error: event.error,
                            });
                            continue;
                        }

                        // Accumulate live events
                        setLiveEvents(prev => [...prev, event]);

                        // Update running totals
                        if (event.cumulativeTokens) {
                            setTokenTotals({
                                input: event.cumulativeTokens.inputTokens,
                                output: event.cumulativeTokens.outputTokens,
                            });
                        }
                        if (event.elapsedMs) {
                            setElapsedMs(event.elapsedMs);
                        }
                        if (event.stepNumber > 0) {
                            setStepsCompleted(event.stepNumber);
                        }

                        // If this is a done event, also set result
                        if (event.type === "done") {
                            if (event.rawFindings || event.error) {
                                setResult(prev => prev ?? {
                                    rawFindings: event.rawFindings ?? null,
                                    intermediateSteps: [],
                                    totalToolCalls: event.totalToolCalls ?? 0,
                                    executionTimeMs: event.executionTimeMs ?? 0,
                                    error: event.error,
                                });
                            }
                        }
                    } catch {
                        // skip malformed events
                    }
                }
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : "Unknown error";
            setResult({
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: errorMsg,
            });
            setLiveEvents(prev => [...prev, {
                type: "error",
                stepNumber: -1,
                timestamp: new Date().toISOString(),
                elapsedMs: 0,
                error: errorMsg,
            }]);
        } finally {
            setRunning(false);
        }
    }, [selectedRepo, useTokenOverride, accessTokenOverride, archetypeScore, agentVariant]);

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            {/* Header */}
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-base">
                        🗄️
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">
                            DB Agent Tester
                        </h1>
                        <p className="text-xs text-gray-400">
                            Select a repository and run the database analysis agent
                        </p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-xs text-gray-400">dev mode</span>
                    </div>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
                {/* Config panel */}
                <Card>
                    <h2 className="text-sm font-semibold text-gray-200 mb-4">
                        Agent Configuration
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                        {/* Repository Selector */}
                        <div>
                            <Label>Repository</Label>
                            {loadingRepos ? (
                                <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
                            ) : reposError ? (
                                <p className="text-red-400 text-sm">{reposError}</p>
                            ) : (
                                <select
                                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                    value={selectedRepoId}
                                    onChange={(e) => setSelectedRepoId(e.target.value)}
                                >
                                    <option value="">— select a repository —</option>
                                    {repos.map((r) => (
                                        <option key={r.repositoryId} value={r.repositoryId}>
                                            {r.fullName}
                                            {r.framework ? ` (${r.framework})` : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>

                        {/* Agent Variant */}
                        <div>
                            <Label>Agent Variant</Label>
                            <select
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                                value={agentVariant}
                                onChange={(e) => setAgentVariant(e.target.value as AgentVariant)}
                            >
                                <option value="legacy">Legacy Agent</option>
                                <option value="graph">Knowledge Graph Agent</option>
                            </select>
                            <p className="text-xs text-gray-500 mt-1">
                                {agentVariant === "graph"
                                    ? "Graph-backed investigation with graph-first tools."
                                    : "Baseline agent using the pre-graph toolchain."}
                            </p>
                        </div>

                        {/* Archetype Score */}
                        <div>
                            <Label>
                                Archetype Score (DB-heaviness):{" "}
                                <span className="text-emerald-400 font-bold">
                                    {archetypeScore.toFixed(2)}
                                </span>
                            </Label>
                            <input
                                type="range"
                                min={0}
                                max={1}
                                step={0.01}
                                value={archetypeScore}
                                onChange={(e) => setArchetypeScore(parseFloat(e.target.value))}
                                className="w-full accent-emerald-500"
                            />
                            <div className="flex justify-between text-xs text-gray-500 mt-1">
                                <span>0 — not DB heavy</span>
                                <span>1 — very DB heavy</span>
                            </div>
                        </div>
                    </div>

                    {/* Selected repo info */}
                    {selectedRepo && (
                        <div className="mt-4 p-3 bg-gray-800/60 rounded-lg grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                            <div>
                                <p className="text-gray-500 mb-0.5">Repository ID</p>
                                <p className="font-mono text-gray-300 truncate">{selectedRepo.repositoryId}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Default Branch</p>
                                <p className="text-gray-300">{selectedRepo.defaultBranch ?? "—"}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Framework</p>
                                <p className="text-gray-300">{selectedRepo.framework ?? "unknown"}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Agent Variant</p>
                                <p className="text-gray-300">{agentVariant}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Auth Method</p>
                                {selectedRepo.user.githubAccessToken ? (
                                    <p className="text-emerald-400">✓ OAuth token</p>
                                ) : selectedRepo.user.githubInstallationId ? (
                                    <p className="text-blue-400">⚡ Installation token</p>
                                ) : (
                                    <p className="text-red-400">✗ no auth</p>
                                )}
                            </div>
                            {selectedRepo.archetypes && selectedRepo.archetypes.length > 0 && (
                                <div className="col-span-2 sm:col-span-5">
                                    <p className="text-gray-500 mb-1">Archetypes</p>
                                    <div className="flex flex-wrap gap-2">
                                        {selectedRepo.archetypes.map((a) => (
                                            <span
                                                key={a.name}
                                                className="px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/20"
                                            >
                                                {a.name} ({(a.score * 100).toFixed(0)}%)
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Token override */}
                    <div className="mt-4">
                        <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                            <input
                                type="checkbox"
                                className="accent-emerald-500"
                                checked={useTokenOverride}
                                onChange={(e) => setUseTokenOverride(e.target.checked)}
                            />
                            <span className="text-sm text-gray-300">
                                Override access token manually
                            </span>
                        </label>
                        {useTokenOverride && (
                            <input
                                type="password"
                                placeholder="ghp_…  or  ghs_…"
                                value={accessTokenOverride}
                                onChange={(e) => setAccessTokenOverride(e.target.value)}
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                            />
                        )}
                    </div>

                    {/* Run button */}
                    <div className="mt-5 flex items-center gap-4">
                        <button
                            onClick={runAgent}
                            disabled={!selectedRepoId || running}
                            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-emerald-900/30"
                        >
                            {running ? (
                                <>
                                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                        <circle
                                            className="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            strokeWidth="4"
                                        />
                                        <path
                                            className="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8v8z"
                                        />
                                    </svg>
                                    Running Agent…
                                </>
                            ) : (
                                <>
                                    <span>▶</span> Run DB Agent
                                </>
                            )}
                        </button>
                        {running && (
                            <p className="text-xs text-gray-400 animate-pulse">
                                Agent is working — this may take 1–3 minutes…
                            </p>
                        )}
                    </div>
                </Card>

                {/* Live status bar (shown while running or when events exist) */}
                {(running || liveEvents.length > 0) && (
                    <div className="bg-gray-900/80 border border-white/10 rounded-xl px-5 py-3 flex items-center gap-6 text-xs">
                        {running && (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                <span className="text-emerald-400 font-semibold">LIVE</span>
                            </div>
                        )}
                        {!running && liveEvents.length > 0 && (
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-gray-500" />
                                <span className="text-gray-400 font-semibold">COMPLETE</span>
                            </div>
                        )}
                        <div>
                            <span className="text-gray-500">Steps</span>
                            <span className="ml-1 font-mono text-blue-400">{stepsCompleted}</span>
                        </div>
                        <div>
                            <span className="text-gray-500">Elapsed</span>
                            <span className="ml-1 font-mono text-purple-400">{formatMs(elapsedMs)}</span>
                        </div>
                        <div>
                            <span className="text-gray-500">Input Tokens</span>
                            <span className="ml-1 font-mono text-amber-400">{formatTokens(tokenTotals.input)}</span>
                        </div>
                        <div>
                            <span className="text-gray-500">Output Tokens</span>
                            <span className="ml-1 font-mono text-amber-400">{formatTokens(tokenTotals.output)}</span>
                        </div>
                        <div>
                            <span className="text-gray-500">Total Tokens</span>
                            <span className="ml-1 font-mono font-bold text-amber-300">
                                {formatTokens(tokenTotals.input + tokenTotals.output)}
                            </span>
                        </div>
                        <div className="ml-auto">
                            <span className="text-gray-500">Events</span>
                            <span className="ml-1 font-mono text-gray-300">{liveEvents.length}</span>
                        </div>
                    </div>
                )}

                {/* Results */}
                {(result || liveEvents.length > 0) && (
                    <div className="space-y-4">
                        {/* Meta stats */}
                        {result && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {[
                                    {
                                        label: "Status",
                                        value: result.error ? "Error" : result.rawFindings ? "Success" : "No findings",
                                        color: result.error ? "text-red-400" : result.rawFindings ? "text-emerald-400" : "text-amber-400",
                                    },
                                    {
                                        label: "Tool Calls",
                                        value: result.totalToolCalls,
                                        color: "text-blue-400",
                                    },
                                    {
                                        label: "Execution Time",
                                        value: `${(result.executionTimeMs / 1000).toFixed(1)}s`,
                                        color: "text-purple-400",
                                    },
                                ].map((s) => (
                                    <Card key={s.label} className="p-4!">
                                        <p className="text-xs text-gray-500">{s.label}</p>
                                        <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                                    </Card>
                                ))}
                            </div>
                        )}

                        {/* Error state */}
                        {result?.error && (
                            <Card className="border-red-500/30 bg-red-950/20">
                                <p className="text-sm font-semibold text-red-400 mb-1">
                                    ⚠ Agent Error
                                </p>
                                <pre className="text-xs text-red-300 whitespace-pre-wrap">
                                    {result.error}
                                </pre>
                            </Card>
                        )}

                        {/* Tabs */}
                        <div>
                            <div className="flex gap-1 mb-4">
                                {(["live", "report", "steps"] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab
                                            ? "bg-emerald-600 text-white"
                                            : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                                            }`}
                                    >
                                        {tab === "live"
                                            ? `📡 Live Logs (${liveEvents.length})`
                                            : tab === "report"
                                                ? `📊 Findings${result?.rawFindings ? ` (${Math.round(result.rawFindings.length / 1000)}k chars)` : ""}`
                                                : `🔧 Tool Steps (${result?.intermediateSteps?.length ?? 0})`}
                                    </button>
                                ))}
                            </div>

                            {/* Live Logs tab */}
                            {activeTab === "live" && (
                                <div className="space-y-1">
                                    {/* Controls bar */}
                                    <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs text-gray-500">
                                            {liveEvents.length} events
                                            {running && " — streaming…"}
                                        </p>
                                        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                                            <input
                                                type="checkbox"
                                                className="accent-emerald-500"
                                                checked={autoScroll}
                                                onChange={(e) => setAutoScroll(e.target.checked)}
                                            />
                                            Auto-scroll
                                        </label>
                                    </div>

                                    {/* Event list */}
                                    <div className="space-y-1 max-h-[700px] overflow-y-auto rounded-lg" id="live-log-container">
                                        {liveEvents.map((ev, i) => (
                                            <LiveEventRow key={i} event={ev} />
                                        ))}
                                        {liveEvents.length === 0 && !running && (
                                            <Card className="text-center py-10">
                                                <p className="text-gray-500">
                                                    No events yet. Run the agent to see live logs.
                                                </p>
                                            </Card>
                                        )}
                                        {running && liveEvents.length === 0 && (
                                            <Card className="text-center py-10">
                                                <div className="flex items-center justify-center gap-2 text-gray-400">
                                                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                                    </svg>
                                                    Waiting for first event…
                                                </div>
                                            </Card>
                                        )}
                                        <div ref={logEndRef} />
                                    </div>

                                    {/* Token summary card */}
                                    {(tokenTotals.input > 0 || tokenTotals.output > 0) && (
                                        <Card className="mt-4">
                                            <h3 className="text-sm font-semibold text-gray-200 mb-3">Token Usage Summary</h3>
                                            <div className="grid grid-cols-3 gap-4">
                                                <div className="text-center">
                                                    <p className="text-2xl font-bold font-mono text-blue-400">
                                                        {tokenTotals.input.toLocaleString()}
                                                    </p>
                                                    <p className="text-xs text-gray-500 mt-1">Input Tokens</p>
                                                </div>
                                                <div className="text-center">
                                                    <p className="text-2xl font-bold font-mono text-purple-400">
                                                        {tokenTotals.output.toLocaleString()}
                                                    </p>
                                                    <p className="text-xs text-gray-500 mt-1">Output Tokens</p>
                                                </div>
                                                <div className="text-center">
                                                    <p className="text-2xl font-bold font-mono text-amber-400">
                                                        {(tokenTotals.input + tokenTotals.output).toLocaleString()}
                                                    </p>
                                                    <p className="text-xs text-gray-500 mt-1">Total Tokens</p>
                                                </div>
                                            </div>
                                            {/* Visual bar */}
                                            <div className="mt-3 h-3 bg-gray-800 rounded-full overflow-hidden flex">
                                                <div
                                                    className="bg-blue-500 transition-all duration-300"
                                                    style={{ width: `${tokenTotals.input / (tokenTotals.input + tokenTotals.output + 1) * 100}%` }}
                                                    title={`Input: ${tokenTotals.input.toLocaleString()}`}
                                                />
                                                <div
                                                    className="bg-purple-500 transition-all duration-300"
                                                    style={{ width: `${tokenTotals.output / (tokenTotals.input + tokenTotals.output + 1) * 100}%` }}
                                                    title={`Output: ${tokenTotals.output.toLocaleString()}`}
                                                />
                                            </div>
                                            <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                                                <span>← Input ({Math.round(tokenTotals.input / (tokenTotals.input + tokenTotals.output + 1) * 100)}%)</span>
                                                <span>Output ({Math.round(tokenTotals.output / (tokenTotals.input + tokenTotals.output + 1) * 100)}%) →</span>
                                            </div>
                                        </Card>
                                    )}
                                </div>
                            )}

                            {/* Report tab — shows raw findings */}
                            {activeTab === "report" && result?.rawFindings && (
                                <Card>
                                    <h3 className="text-sm font-semibold text-gray-200 mb-3">Agent Findings</h3>
                                    <pre className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed max-h-[800px] overflow-y-auto">
                                        {result.rawFindings}
                                    </pre>
                                </Card>
                            )}

                            {activeTab === "report" && !result?.rawFindings && !result?.error && (
                                <Card className="text-center py-10">
                                    <p className="text-gray-500">
                                        {running
                                            ? "Agent is running — findings will appear when complete."
                                            : "Agent completed but did not produce findings."}
                                    </p>
                                    <p className="text-xs text-gray-600 mt-1">
                                        Switch to Live Logs to inspect events.
                                    </p>
                                </Card>
                            )}

                            {/* Steps tab */}
                            {activeTab === "steps" && (
                                <div className="space-y-1.5">
                                    {(result?.intermediateSteps ?? []).map((msg, i) => (
                                        <ToolStepRow key={i} msg={msg} index={i} />
                                    ))}
                                    {(result?.intermediateSteps ?? []).length === 0 && (
                                        <Card className="text-center py-10">
                                            <p className="text-gray-500">
                                                {running
                                                    ? "Steps will appear after agent completes."
                                                    : "No intermediate steps recorded."}
                                            </p>
                                        </Card>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
