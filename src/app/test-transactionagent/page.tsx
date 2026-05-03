"use client";

import { useCallback, useEffect, useState } from "react";

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
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
    intermediateSteps?: Message[];
}

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

function countFindings(rawFindings: string | null): string {
    if (!rawFindings) return "-";
    return String(rawFindings.split("\n").filter((line) => line.startsWith("[")).length);
}

export default function TestTransactionAgentPage() {
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);

    const [selectedRepoId, setSelectedRepoId] = useState("");
    const [accessTokenOverride, setAccessTokenOverride] = useState("");
    const [useTokenOverride, setUseTokenOverride] = useState(false);

    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AgentOutput | null>(null);
    const [activeTab, setActiveTab] = useState<"report" | "raw">("report");

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
        setActiveTab("report");

        try {
            const res = await fetch("/api/agent/transaction-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repositoryId: selectedRepo.repositoryId,
                    ...(oauthToken ? { accessToken: oauthToken } : { installationId }),
                }),
            });

            if (!res.ok) {
                const errorBody = await res.json().catch(() => ({ error: "Request failed" }));
                throw new Error(errorBody.error ?? `HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            let latestDone: AgentOutput | null = null;

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

                        if (event.type === "done") {
                            latestDone = {
                                rawFindings: event.rawFindings ?? null,
                                intermediateSteps: [],
                                totalToolCalls: event.totalToolCalls ?? 0,
                                executionTimeMs: event.executionTimeMs ?? 0,
                                error: event.error,
                            };
                        }

                        if (event.type === "result") {
                            setResult({
                                rawFindings: event.rawFindings ?? null,
                                intermediateSteps: event.intermediateSteps ?? [],
                                totalToolCalls: event.totalToolCalls ?? 0,
                                executionTimeMs: event.executionTimeMs ?? 0,
                                error: event.error,
                            });
                        }
                    } catch {
                        // Ignore malformed SSE lines.
                    }
                }
            }

            setResult((current) => current ?? latestDone ?? {
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: "Agent completed without returning a result event.",
            });
        } catch (error) {
            setResult({
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: error instanceof Error ? error.message : "Unknown error",
            });
        } finally {
            setRunning(false);
        }
    }, [accessTokenOverride, selectedRepo, useTokenOverride]);

    const rawFindings = result?.rawFindings ?? null;

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-orange-500/20 border border-orange-500/30 flex items-center justify-center text-xs font-bold text-orange-300">
                        PAY
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">
                            Payment Agent Tester
                        </h1>
                        <p className="text-xs text-gray-400">
                            Select a repository and run the payment integration analysis agent
                        </p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${running ? "bg-orange-400 animate-pulse" : "bg-gray-500"}`} />
                        <span className="text-xs text-gray-400">{running ? "running" : "dev mode"}</span>
                    </div>
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
                <Card>
                    <h2 className="text-sm font-semibold text-gray-200 mb-4">
                        Agent Configuration
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <Label>Repository</Label>
                            {loadingRepos ? (
                                <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
                            ) : reposError ? (
                                <p className="text-red-400 text-sm">{reposError}</p>
                            ) : (
                                <select
                                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                                    value={selectedRepoId}
                                    onChange={(event) => setSelectedRepoId(event.target.value)}
                                >
                                    <option value="">Select a repository</option>
                                    {repos.map((repo) => (
                                        <option key={repo.repositoryId} value={repo.repositoryId}>
                                            {repo.fullName}
                                            {repo.framework ? ` (${repo.framework})` : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>

                        <div className="flex items-end">
                            <p className="text-xs text-gray-500">
                                The payment agent checks checkout flow integrity, webhook safety,
                                subscription lifecycle, payment database consistency, refunds,
                                disputes, and client-side payment security.
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
                                <p className="text-gray-300">{selectedRepo.defaultBranch ?? "-"}</p>
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
                                className="accent-orange-500"
                                checked={useTokenOverride}
                                onChange={(event) => setUseTokenOverride(event.target.checked)}
                            />
                            <span className="text-sm text-gray-300">
                                Override access token manually
                            </span>
                        </label>
                        {useTokenOverride && (
                            <input
                                type="password"
                                placeholder="ghp_... or ghs_..."
                                value={accessTokenOverride}
                                onChange={(event) => setAccessTokenOverride(event.target.value)}
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                            />
                        )}
                    </div>

                    <div className="mt-5 flex items-center gap-4">
                        <button
                            onClick={runAgent}
                            disabled={!selectedRepoId || running}
                            className="flex items-center gap-2 px-5 py-2.5 bg-orange-600 hover:bg-orange-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-orange-900/30"
                        >
                            {running ? "Running Agent..." : "Run Payment Agent"}
                        </button>
                        {running && (
                            <p className="text-xs text-gray-400 animate-pulse">
                                Agent is working. Findings will appear when complete.
                            </p>
                        )}
                    </div>
                </Card>

                {result && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                                {
                                    label: "Status",
                                    value: result.error ? "Error" : rawFindings ? "Success" : "No findings",
                                    color: result.error ? "text-red-400" : rawFindings ? "text-emerald-400" : "text-amber-400",
                                },
                                {
                                    label: "Tool Calls",
                                    value: String(result.totalToolCalls),
                                    color: "text-orange-400",
                                },
                                {
                                    label: "Execution Time",
                                    value: `${(result.executionTimeMs / 1000).toFixed(1)}s`,
                                    color: "text-purple-400",
                                },
                                {
                                    label: "Findings",
                                    value: countFindings(rawFindings),
                                    color: "text-cyan-400",
                                },
                            ].map((stat) => (
                                <Card key={stat.label} className="p-4!">
                                    <p className="text-xs text-gray-500">{stat.label}</p>
                                    <p className={`text-xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
                                </Card>
                            ))}
                        </div>

                        {result.error && (
                            <Card className="border-red-500/30 bg-red-950/20">
                                <p className="text-sm font-semibold text-red-400 mb-1">
                                    Agent Error
                                </p>
                                <pre className="text-xs text-red-300 whitespace-pre-wrap">
                                    {result.error}
                                </pre>
                            </Card>
                        )}

                        <div>
                            <div className="flex gap-1 mb-4">
                                {(["report", "raw"] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                            activeTab === tab
                                                ? "bg-orange-600 text-white"
                                                : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                                        }`}
                                    >
                                        {tab === "report" ? "Findings Digest" : "Raw JSON"}
                                    </button>
                                ))}
                            </div>

                            {activeTab === "report" && (
                                <div className="space-y-4">
                                    {rawFindings ? (
                                        <Card>
                                            <h3 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">
                                                Payment Findings Digest
                                            </h3>
                                            <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-mono">
                                                {rawFindings}
                                            </pre>
                                        </Card>
                                    ) : !result.error && (
                                        <Card className="text-center py-10">
                                            <p className="text-gray-500">
                                                Agent completed but did not produce any findings.
                                            </p>
                                            <p className="text-xs text-gray-600 mt-1">
                                                Switch to Raw JSON to inspect the full response.
                                            </p>
                                        </Card>
                                    )}
                                </div>
                            )}

                            {activeTab === "raw" && (
                                <Card>
                                    <pre className="text-xs text-gray-300 overflow-auto max-h-[600px] whitespace-pre-wrap break-all">
                                        {JSON.stringify(result, null, 2)}
                                    </pre>
                                </Card>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
