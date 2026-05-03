"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface RepoRecord {
    id: string;
    repositoryId: string;
    name: string;
    fullName: string;
    owner: string;
    defaultBranch: string | null;
    framework: string | null;
    isSupported: boolean;
    packageJson: Record<string, unknown> | null;
    user: {
        githubAccessToken: string | null;
        githubInstallationId: string | null;
        githubUsername: string | null;
        email: string;
    };
}

interface Message {
    role: string;
    name?: string;
    content?: string;
    tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}

interface AgentOutput {
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
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
    intermediateSteps?: Message[];
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

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={`bg-gray-900 border border-white/10 rounded-xl p-5 ${className}`}>
            {children}
        </div>
    );
}

function Label({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
            {children}
        </p>
    );
}

function LiveEventRow({ event }: { event: StreamEvent }) {
    const [open, setOpen] = useState(false);
    if (event.type === "llm_end" && (!event.tokenUsage || event.tokenUsage.totalTokens === 0)) return null;

    const colors: Record<string, string> = {
        agent_start: "border-sky-500/20 bg-sky-500/10 text-sky-300",
        tool_start: "border-blue-500/20 bg-blue-500/10 text-blue-300",
        tool_end: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
        llm_end: "border-purple-500/20 bg-purple-500/10 text-purple-300",
        agent_thought: "border-gray-500/20 bg-gray-500/10 text-gray-300",
        error: "border-red-500/20 bg-red-500/10 text-red-300",
        done: "border-sky-500/20 bg-sky-500/10 text-sky-300",
    };
    const hasExpandable = event.toolInput || event.toolOutput || event.reasoning || event.error;
    const className = colors[event.type] ?? "border-gray-500/20 bg-gray-500/10 text-gray-300";

    return (
        <div className={`border rounded-lg overflow-hidden text-xs ${className}`}>
            <button
                onClick={() => hasExpandable && setOpen((value) => !value)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left ${hasExpandable ? "hover:bg-white/5" : ""}`}
            >
                <span className="w-8 shrink-0 text-right font-mono text-gray-500">
                    {event.stepNumber > 0 ? `#${event.stepNumber}` : ""}
                </span>
                <span className="shrink-0 font-semibold">{event.type}</span>
                <span className="flex-1 truncate font-mono text-gray-200">
                    {event.toolName}
                    {event.reasoning ? ` ${event.reasoning.slice(0, 100)}` : ""}
                    {event.error ? ` ${event.error}` : ""}
                    {event.type === "tool_end" && event.toolOutputLength ? ` (${formatTokens(event.toolOutputLength)} chars)` : ""}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-gray-500">{formatMs(event.elapsedMs)}</span>
            </button>
            {open && (
                <div className="space-y-2 border-t border-white/5 p-3 text-gray-300">
                    {event.toolInput !== undefined && (
                        <pre className="max-h-48 overflow-auto rounded bg-black/40 p-2 whitespace-pre-wrap break-all">
                            {typeof event.toolInput === "string" ? event.toolInput : JSON.stringify(event.toolInput, null, 2)}
                        </pre>
                    )}
                    {event.toolOutput && (
                        <pre className="max-h-64 overflow-auto rounded bg-black/40 p-2 whitespace-pre-wrap break-all">
                            {event.toolOutput}
                        </pre>
                    )}
                    {event.reasoning && <p className="whitespace-pre-wrap">{event.reasoning}</p>}
                    {event.error && <pre className="whitespace-pre-wrap text-red-300">{event.error}</pre>}
                </div>
            )}
        </div>
    );
}

function ToolStepRow({ msg, index }: { msg: Message; index: number }) {
    const [open, setOpen] = useState(false);
    const toolName = msg.tool_calls?.[0]?.name ?? msg.name ?? "message";
    return (
        <div className="border border-white/5 rounded-lg overflow-hidden text-xs">
            <button
                onClick={() => setOpen((value) => !value)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-gray-800/50 hover:bg-gray-800 text-left"
            >
                <span className="text-gray-400">#{index + 1}</span>
                <span className="font-mono font-semibold text-gray-200 truncate flex-1">{toolName}</span>
                <span className="text-gray-500">{msg.role}</span>
            </button>
            {open && (
                <pre className="p-3 bg-black/40 overflow-auto max-h-64 text-gray-300 whitespace-pre-wrap break-all">
                    {JSON.stringify(msg, null, 2)}
                </pre>
            )}
        </div>
    );
}

export default function TestComputeHeavyAgentPage() {
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);
    const [selectedRepoId, setSelectedRepoId] = useState("");
    const [accessTokenOverride, setAccessTokenOverride] = useState("");
    const [useTokenOverride, setUseTokenOverride] = useState(false);
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AgentOutput | null>(null);
    const [activeTab, setActiveTab] = useState<"live" | "report" | "steps">("live");
    const [liveEvents, setLiveEvents] = useState<StreamEvent[]>([]);
    const [tokenTotals, setTokenTotals] = useState({ input: 0, output: 0 });
    const [elapsedMs, setElapsedMs] = useState(0);
    const [stepsCompleted, setStepsCompleted] = useState(0);
    const [autoScroll, setAutoScroll] = useState(true);
    const logEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch("/api/agent/repositories");
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? "Failed to load");
                setRepos(data.repositories ?? []);
            } catch (error) {
                setReposError(error instanceof Error ? error.message : "Unknown error");
            } finally {
                setLoadingRepos(false);
            }
        }
        load();
    }, []);

    useEffect(() => {
        if (autoScroll) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [autoScroll, liveEvents]);

    const selectedRepo = repos.find((repo) => repo.repositoryId === selectedRepoId) ?? null;

    const runAgent = useCallback(async () => {
        if (!selectedRepo) return;

        const oauthToken = useTokenOverride
            ? accessTokenOverride.trim()
            : selectedRepo.user.githubAccessToken ?? "";
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
            const res = await fetch("/api/agent/compute-heavy-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repositoryId: selectedRepo.repositoryId,
                    ...(oauthToken ? { accessToken: oauthToken } : { installationId }),
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
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith("data: ")) continue;

                    try {
                        const event: StreamEvent = JSON.parse(trimmed.slice(6));
                        if (event.type === "result") {
                            setResult({
                                rawFindings: event.rawFindings ?? null,
                                intermediateSteps: event.intermediateSteps ?? [],
                                totalToolCalls: event.totalToolCalls ?? 0,
                                executionTimeMs: event.executionTimeMs ?? 0,
                                error: event.error,
                            });
                            continue;
                        }

                        setLiveEvents((prev) => [...prev, event]);
                        if (event.cumulativeTokens) {
                            setTokenTotals({
                                input: event.cumulativeTokens.inputTokens,
                                output: event.cumulativeTokens.outputTokens,
                            });
                        }
                        if (event.elapsedMs) setElapsedMs(event.elapsedMs);
                        if (event.stepNumber > 0) setStepsCompleted(event.stepNumber);
                        if (event.type === "done" && (event.rawFindings || event.error)) {
                            setResult((prev) => prev ?? {
                                rawFindings: event.rawFindings ?? null,
                                intermediateSteps: [],
                                totalToolCalls: event.totalToolCalls ?? 0,
                                executionTimeMs: event.executionTimeMs ?? 0,
                                error: event.error,
                            });
                        }
                    } catch {
                        // skip malformed events
                    }
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            setResult({
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: message,
            });
            setLiveEvents((prev) => [...prev, {
                type: "error",
                stepNumber: -1,
                timestamp: new Date().toISOString(),
                elapsedMs: 0,
                error: message,
            }]);
        } finally {
            setRunning(false);
        }
    }, [accessTokenOverride, selectedRepo, useTokenOverride]);

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center text-xs font-bold text-sky-300">
                        CPU
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">Compute-heavy Agent Tester</h1>
                        <p className="text-xs text-gray-400">CPU saturation, memory pressure, queues, and algorithmic scaling</p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${running ? "bg-sky-400 animate-pulse" : "bg-gray-500"}`} />
                        <span className="text-xs text-gray-400">{running ? "live" : "dev mode"}</span>
                    </div>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
                <Card>
                    <h2 className="text-sm font-semibold text-gray-200 mb-4">Agent Configuration</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <Label>Repository</Label>
                            {loadingRepos ? (
                                <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
                            ) : reposError ? (
                                <p className="text-red-400 text-sm">{reposError}</p>
                            ) : (
                                <select
                                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
                                    value={selectedRepoId}
                                    onChange={(event) => setSelectedRepoId(event.target.value)}
                                >
                                    <option value="">Select a repository</option>
                                    {repos.map((repo) => (
                                        <option key={repo.repositoryId} value={repo.repositoryId}>
                                            {repo.fullName}{repo.framework ? ` (${repo.framework})` : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>
                        <div className="flex items-end">
                            <p className="text-xs text-gray-500">
                                This agent checks synchronous blocking code, missing worker queues, inefficient algorithms,
                                memory-heavy transforms, and what fails at 10x traffic or input size.
                            </p>
                        </div>
                    </div>

                    {selectedRepo && (
                        <div className="mt-4 p-3 bg-gray-800/60 rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div>
                                <p className="text-gray-500 mb-0.5">Repository ID</p>
                                <p className="font-mono text-gray-300 truncate">{selectedRepo.repositoryId}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Default Branch</p>
                                <p className="text-gray-300">{selectedRepo.defaultBranch ?? "unknown"}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Framework</p>
                                <p className="text-gray-300">{selectedRepo.framework ?? "unknown"}</p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">Auth Method</p>
                                {selectedRepo.user.githubAccessToken ? (
                                    <p className="text-emerald-400">OAuth token</p>
                                ) : selectedRepo.user.githubInstallationId ? (
                                    <p className="text-blue-400">Installation token</p>
                                ) : (
                                    <p className="text-red-400">No auth</p>
                                )}
                            </div>
                        </div>
                    )}

                    <div className="mt-4">
                        <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                            <input
                                type="checkbox"
                                className="accent-sky-500"
                                checked={useTokenOverride}
                                onChange={(event) => setUseTokenOverride(event.target.checked)}
                            />
                            <span className="text-sm text-gray-300">Override access token manually</span>
                        </label>
                        {useTokenOverride && (
                            <input
                                type="password"
                                placeholder="ghp_... or ghs_..."
                                value={accessTokenOverride}
                                onChange={(event) => setAccessTokenOverride(event.target.value)}
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500/50"
                            />
                        )}
                    </div>

                    <div className="mt-5 flex items-center gap-4">
                        <button
                            onClick={runAgent}
                            disabled={!selectedRepoId || running}
                            className="px-5 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-sky-900/30"
                        >
                            {running ? "Running Agent..." : "Run Compute Agent"}
                        </button>
                        {running && <p className="text-xs text-gray-400 animate-pulse">Agent is working; this may take 1-3 minutes.</p>}
                    </div>
                </Card>

                {(running || liveEvents.length > 0) && (
                    <div className="bg-gray-900/80 border border-white/10 rounded-xl px-5 py-3 flex items-center gap-6 text-xs">
                        <div className="flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${running ? "bg-sky-400 animate-pulse" : "bg-gray-500"}`} />
                            <span className={running ? "text-sky-400 font-semibold" : "text-gray-400 font-semibold"}>{running ? "LIVE" : "COMPLETE"}</span>
                        </div>
                        <div><span className="text-gray-500">Steps</span> <span className="font-mono text-blue-400">{stepsCompleted}</span></div>
                        <div><span className="text-gray-500">Elapsed</span> <span className="font-mono text-purple-400">{formatMs(elapsedMs)}</span></div>
                        <div><span className="text-gray-500">Input</span> <span className="font-mono text-amber-400">{formatTokens(tokenTotals.input)}</span></div>
                        <div><span className="text-gray-500">Output</span> <span className="font-mono text-amber-400">{formatTokens(tokenTotals.output)}</span></div>
                        <div className="ml-auto"><span className="text-gray-500">Events</span> <span className="font-mono text-gray-300">{liveEvents.length}</span></div>
                    </div>
                )}

                {(result || liveEvents.length > 0) && (
                    <div className="space-y-4">
                        {result && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                {[
                                    { label: "Status", value: result.error ? "Error" : result.rawFindings ? "Success" : "No findings", color: result.error ? "text-red-400" : result.rawFindings ? "text-emerald-400" : "text-amber-400" },
                                    { label: "Tool Calls", value: result.totalToolCalls, color: "text-blue-400" },
                                    { label: "Execution Time", value: `${(result.executionTimeMs / 1000).toFixed(1)}s`, color: "text-purple-400" },
                                ].map((stat) => (
                                    <Card key={stat.label} className="p-4!">
                                        <p className="text-xs text-gray-500">{stat.label}</p>
                                        <p className={`text-xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
                                    </Card>
                                ))}
                            </div>
                        )}

                        {result?.error && (
                            <Card className="border-red-500/30 bg-red-950/20">
                                <p className="text-sm font-semibold text-red-400 mb-1">Agent Error</p>
                                <pre className="text-xs text-red-300 whitespace-pre-wrap">{result.error}</pre>
                            </Card>
                        )}

                        <div>
                            <div className="flex gap-1 mb-4">
                                {(["live", "report", "steps"] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab ? "bg-sky-600 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/5"}`}
                                    >
                                        {tab === "live" ? `Live Logs (${liveEvents.length})` : tab === "report" ? `Findings${result?.rawFindings ? ` (${Math.round(result.rawFindings.length / 1000)}k chars)` : ""}` : `Tool Steps (${result?.intermediateSteps?.length ?? 0})`}
                                    </button>
                                ))}
                            </div>

                            {activeTab === "live" && (
                                <div className="space-y-1">
                                    <div className="flex items-center justify-between mb-2">
                                        <p className="text-xs text-gray-500">{liveEvents.length} events{running && " streaming"}</p>
                                        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none">
                                            <input type="checkbox" className="accent-sky-500" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />
                                            Auto-scroll
                                        </label>
                                    </div>
                                    <div className="space-y-1 max-h-[700px] overflow-y-auto rounded-lg">
                                        {liveEvents.map((event, index) => <LiveEventRow key={index} event={event} />)}
                                        {liveEvents.length === 0 && <Card className="text-center py-10"><p className="text-gray-500">No events yet.</p></Card>}
                                        <div ref={logEndRef} />
                                    </div>
                                </div>
                            )}

                            {activeTab === "report" && result?.rawFindings && (
                                <Card>
                                    <h3 className="text-sm font-semibold text-gray-200 mb-3">Agent Findings</h3>
                                    <pre className="text-sm text-gray-300 whitespace-pre-wrap leading-relaxed max-h-[800px] overflow-y-auto">{result.rawFindings}</pre>
                                </Card>
                            )}

                            {activeTab === "report" && !result?.rawFindings && !result?.error && (
                                <Card className="text-center py-10">
                                    <p className="text-gray-500">{running ? "Agent is running; findings will appear when complete." : "Agent completed but did not produce findings."}</p>
                                </Card>
                            )}

                            {activeTab === "steps" && (
                                <div className="space-y-1.5">
                                    {(result?.intermediateSteps ?? []).map((msg, index) => <ToolStepRow key={index} msg={msg} index={index} />)}
                                    {(result?.intermediateSteps ?? []).length === 0 && (
                                        <Card className="text-center py-10">
                                            <p className="text-gray-500">{running ? "Steps will appear after agent completes." : "No intermediate steps recorded."}</p>
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
