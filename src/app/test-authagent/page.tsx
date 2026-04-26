"use client";

import { useEffect, useState, useCallback } from "react";

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

interface AgentOutput {
    report: {
        rawFindings: string | null;
        intermediateSteps: unknown[];
        totalToolCalls: number;
        executionTimeMs: number;
        error?: string;
    } | null;
    executionTimeMs: number;
    error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// (helper functions removed — structured AuthReport fields no longer exist)

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

// (FindingCard, PhaseIndicator, BottleneckList removed — agent now returns rawFindings plain text)

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TestAuthAgentPage() {
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);

    const [selectedRepoId, setSelectedRepoId] = useState<string>("");
    const [accessTokenOverride, setAccessTokenOverride] = useState<string>("");
    const [useTokenOverride, setUseTokenOverride] = useState(false);

    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AgentOutput | null>(null);
    const [activeTab, setActiveTab] = useState<"report" | "raw">("report");

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

    const selectedRepo = repos.find((r) => r.repositoryId === selectedRepoId) ?? null;

    // ── Run agent ──
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
        setActiveTab("report");

        try {
            const res = await fetch("/api/agent/auth-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repositoryId: selectedRepo.repositoryId,
                    ...(oauthToken ? { accessToken: oauthToken } : { installationId }),
                }),
            });
            const data = await res.json();
            setResult(data);
        } catch (e) {
            setResult({
                report: null,
                executionTimeMs: 0,
                error: e instanceof Error ? e.message : "Unknown error",
            });
        } finally {
            setRunning(false);
        }
    }, [selectedRepo, useTokenOverride, accessTokenOverride]);

    // ─── Derived values ───────────────────────────────────────────────────────
    const agentOutput = result?.report ?? null;
    const rawFindings = agentOutput?.rawFindings ?? null;
    const totalToolCalls = agentOutput?.totalToolCalls ?? 0;

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            {/* Header */}
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-base">
                        🔐
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">
                            Auth Agent Tester
                        </h1>
                        <p className="text-xs text-gray-400">
                            Select a repository and run the authentication analysis agent
                        </p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
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

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {/* Repository Selector */}
                        <div>
                            <Label>Repository</Label>
                            {loadingRepos ? (
                                <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
                            ) : reposError ? (
                                <p className="text-red-400 text-sm">{reposError}</p>
                            ) : (
                                <select
                                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
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

                        {/* Info placeholder */}
                        <div className="flex items-end">
                            <p className="text-xs text-gray-500">
                                The auth agent analyzes authentication implementations for scale
                                bottlenecks — missing indexes, unprotected routes, session storage
                                issues, and more.
                            </p>
                        </div>
                    </div>

                    {/* Selected repo info */}
                    {selectedRepo && (
                        <div className="mt-4 p-3 bg-gray-800/60 rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
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
                                <p className="text-gray-500 mb-0.5">Auth Method</p>
                                {selectedRepo.user.githubAccessToken ? (
                                    <p className="text-emerald-400">✓ OAuth token</p>
                                ) : selectedRepo.user.githubInstallationId ? (
                                    <p className="text-blue-400">⚡ Installation token</p>
                                ) : (
                                    <p className="text-red-400">✗ no auth</p>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Token override */}
                    <div className="mt-4">
                        <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                            <input
                                type="checkbox"
                                className="accent-violet-500"
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
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-violet-500/50"
                            />
                        )}
                    </div>

                    {/* Run button */}
                    <div className="mt-5 flex items-center gap-4">
                        <button
                            onClick={runAgent}
                            disabled={!selectedRepoId || running}
                            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-violet-900/30"
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
                                    <span>▶</span> Run Auth Agent
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

                {/* Results */}
                {result && (
                    <div className="space-y-4">
                        {/* Meta stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                                {
                                    label: "Status",
                                    value: result.error || agentOutput?.error ? "Error" : rawFindings ? "Success" : "No findings",
                                    color: result.error || agentOutput?.error ? "text-red-400" : rawFindings ? "text-emerald-400" : "text-amber-400",
                                },
                                {
                                    label: "Tool Calls",
                                    value: String(totalToolCalls),
                                    color: "text-violet-400",
                                },
                                {
                                    label: "Execution Time",
                                    value: `${(result.executionTimeMs / 1000).toFixed(1)}s`,
                                    color: "text-purple-400",
                                },
                                {
                                    label: "Findings",
                                    value: rawFindings ? `${rawFindings.split("\n").filter(l => l.startsWith("[")).length}` : "—",
                                    color: "text-cyan-400",
                                },
                            ].map((s) => (
                                <Card key={s.label} className="p-4!">
                                    <p className="text-xs text-gray-500">{s.label}</p>
                                    <p className={`text-xl font-bold mt-1 ${s.color}`}>{s.value}</p>
                                </Card>
                            ))}
                        </div>

                        {/* Error state */}
                        {result.error && (
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
                                {(["report", "raw"] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                                            activeTab === tab
                                                ? "bg-violet-600 text-white"
                                                : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                                        }`}
                                    >
                                        {tab === "report" ? "📊 Findings Digest" : "📋 Raw JSON"}
                                    </button>
                                ))}
                            </div>

                            {/* Findings digest tab */}
                            {activeTab === "report" && (
                                <div className="space-y-4">
                                    {agentOutput?.error && (
                                        <Card className="border-red-500/30 bg-red-950/20">
                                            <p className="text-sm font-semibold text-red-400 mb-1">⚠ Agent Error</p>
                                            <pre className="text-xs text-red-300 whitespace-pre-wrap">{agentOutput.error}</pre>
                                        </Card>
                                    )}
                                    {rawFindings ? (
                                        <Card>
                                            <h3 className="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider">
                                                Auth Findings Digest
                                            </h3>
                                            <pre className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-mono">
                                                {rawFindings}
                                            </pre>
                                        </Card>
                                    ) : !agentOutput?.error && (
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

                            {/* Raw JSON tab */}
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
