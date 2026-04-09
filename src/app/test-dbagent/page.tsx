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
    report: Record<string, unknown> | null;
    intermediateSteps: Message[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
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
                    {finding.evidence && Object.keys(finding.evidence as object).length > 0 && (
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TestDbAgentPage() {
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);

    const [selectedRepoId, setSelectedRepoId] = useState<string>("");
    const [archetypeScore, setArchetypeScore] = useState<number>(0.5);
    const [accessTokenOverride, setAccessTokenOverride] = useState<string>("");
    const [useTokenOverride, setUseTokenOverride] = useState(false);

    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<AgentOutput | null>(null);
    const [activeTab, setActiveTab] = useState<"report" | "steps">("report");

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

    // ── Run agent ──
    const runAgent = useCallback(async () => {
        if (!selectedRepo) return;

        const oauthToken = useTokenOverride
            ? accessTokenOverride.trim()
            : (selectedRepo.user.githubAccessToken ?? "");

        const installationId = selectedRepo.user.githubInstallationId;

        // Need at least one auth source
        if (!oauthToken && !installationId) {
            alert("No access token or installation ID available. Enable the override and paste a token.");
            return;
        }

        setRunning(true);
        setResult(null);
        setActiveTab("report");

        try {
            const res = await fetch("/api/agent/db-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    repositoryId: selectedRepo.repositoryId,
                    ...(oauthToken ? { accessToken: oauthToken } : { installationId }),
                    archetypeScore,
                }),
            });
            const data = await res.json();
            setResult(data);
            if (data.report) {
                setActiveTab("report");
            } else {
                setActiveTab("steps");
            }
        } catch (e) {
            setResult({
                report: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: e instanceof Error ? e.message : "Unknown error",
            });
        } finally {
            setRunning(false);
        }
    }, [selectedRepo, useTokenOverride, accessTokenOverride, archetypeScore]);

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
                            {selectedRepo.archetypes && selectedRepo.archetypes.length > 0 && (
                                <div className="col-span-2 sm:col-span-4">
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

                {/* Results */}
                {result && (
                    <div className="space-y-4">
                        {/* Meta stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            {[
                                {
                                    label: "Status",
                                    value: result.error ? "Error" : result.report ? "Success" : "No report",
                                    color: result.error ? "text-red-400" : result.report ? "text-emerald-400" : "text-amber-400",
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
                                {
                                    label: "Confidence",
                                    value: result.report
                                        ? `${((result.report.confidence as number) * 100).toFixed(0)}%`
                                        : "—",
                                    color: "text-yellow-400",
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
                                {(["report", "steps"] as const).map((tab) => (
                                    <button
                                        key={tab}
                                        onClick={() => setActiveTab(tab)}
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab
                                            ? "bg-emerald-600 text-white"
                                            : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                                            }`}
                                    >
                                        {tab === "report"
                                            ? `📊 Report (${(result.report?.findings as unknown[])?.length ?? 0} findings)`
                                            : `🔧 Tool Steps (${result.intermediateSteps.length})`}
                                    </button>
                                ))}
                            </div>

                            {/* Report tab */}
                            {activeTab === "report" && result.report && (
                                <div className="space-y-5">
                                    {/* Summary strip */}
                                    <Card>
                                        <div className="flex items-center gap-3 mb-4">
                                            <h3 className="text-sm font-semibold text-gray-200 flex-1">
                                                Summary
                                            </h3>
                                            <span
                                                className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full ${(result.report.summary as Record<string, unknown>).overallRisk === "critical"
                                                    ? "bg-red-500/20 text-red-400"
                                                    : (result.report.summary as Record<string, unknown>).overallRisk === "warning"
                                                        ? "bg-amber-500/20 text-amber-400"
                                                        : "bg-emerald-500/20 text-emerald-400"
                                                    }`}
                                            >
                                                {String((result.report.summary as Record<string, unknown>).overallRisk)} risk
                                            </span>
                                        </div>
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                                            {[
                                                { label: "Total", value: (result.report.summary as Record<string, unknown>).totalFindings, color: "text-gray-200" },
                                                { label: "Critical", value: (result.report.summary as Record<string, unknown>).criticalCount, color: "text-red-400" },
                                                { label: "Warning", value: (result.report.summary as Record<string, unknown>).warningCount, color: "text-amber-400" },
                                                { label: "Info", value: (result.report.summary as Record<string, unknown>).infoCount, color: "text-blue-400" },
                                            ].map((s) => (
                                                <div key={s.label}>
                                                    <p className={`text-2xl font-bold ${s.color}`}>
                                                        {String(s.value)}
                                                    </p>
                                                    <p className="text-xs text-gray-500">{s.label}</p>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="mt-4 pt-4 border-t border-white/5 grid sm:grid-cols-2 gap-3 text-sm">
                                            <div>
                                                <Label>Top Concern</Label>
                                                <p className="text-gray-300">
                                                    {String((result.report.summary as Record<string, unknown>).topConcern)}
                                                </p>
                                            </div>
                                            <div>
                                                <Label>Estimated Scale Ceiling</Label>
                                                <p className="text-orange-300 font-semibold">
                                                    {String((result.report.summary as Record<string, unknown>).estimatedScaleCeiling)}
                                                </p>
                                            </div>
                                        </div>
                                    </Card>

                                    {/* Scale analysis */}
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
                                            Scale Analysis
                                        </h3>
                                        <div className="grid sm:grid-cols-3 gap-3">
                                            {Object.entries(result.report.scaleAnalysis as Record<string, { verdict: string; primaryIssues: string[] }>).map(
                                                ([tier, data]) => (
                                                    <ScaleTierCard key={tier} tier={tier} data={data} />
                                                )
                                            )}
                                        </div>
                                    </div>

                                    {/* Findings */}
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
                                            Findings
                                        </h3>
                                        <div className="space-y-2">
                                            {((result.report.findings as Record<string, unknown>[]) ?? []).map(
                                                (f, i) => (
                                                    <FindingCard key={i} finding={f} />
                                                )
                                            )}
                                            {((result.report.findings as unknown[]) ?? []).length === 0 && (
                                                <p className="text-sm text-gray-500 text-center py-6">
                                                    No findings reported.
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    {/* Tools used */}
                                    {(result.report.toolsUsed as string[])?.length > 0 && (
                                        <Card>
                                            <Label>Tools Used by Agent</Label>
                                            <div className="flex flex-wrap gap-2 mt-1">
                                                {(result.report.toolsUsed as string[]).map((t) => (
                                                    <span
                                                        key={t}
                                                        className="px-2 py-0.5 rounded-md bg-gray-700 text-xs font-mono text-gray-300"
                                                    >
                                                        {t}
                                                    </span>
                                                ))}
                                            </div>
                                        </Card>
                                    )}
                                </div>
                            )}

                            {activeTab === "report" && !result.report && !result.error && (
                                <Card className="text-center py-10">
                                    <p className="text-gray-500">
                                        Agent completed but did not produce a final report.
                                    </p>
                                    <p className="text-xs text-gray-600 mt-1">
                                        Switch to Tool Steps to inspect intermediate messages.
                                    </p>
                                </Card>
                            )}

                            {/* Steps tab */}
                            {activeTab === "steps" && (
                                <div className="space-y-1.5">
                                    {result.intermediateSteps.map((msg, i) => (
                                        <ToolStepRow key={i} msg={msg} index={i} />
                                    ))}
                                    {result.intermediateSteps.length === 0 && (
                                        <Card className="text-center py-10">
                                            <p className="text-gray-500">No intermediate steps recorded.</p>
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
