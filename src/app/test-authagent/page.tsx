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

interface AuthFinding {
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    category: string;
    title: string;
    description: string;
    affectedFiles: string[];
    scaleBreakpoint?: string;
    recommendation: string;
}

interface AuthScaleAnalysis {
    overallRisk: "critical" | "high" | "medium" | "low";
    estimatedBreakpoint: string;
    bottlenecks: string[];
}

interface AuthReport {
    repositoryId: string;
    authMode: string;
    authProvider: string;
    findings: AuthFinding[];
    scaleAnalysis: AuthScaleAnalysis;
    summary: string;
    completedPhases: number[];
    timedOut: boolean;
}

interface AgentOutput {
    report: AuthReport | null;
    executionTimeMs: number;
    error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityBadge(sev: string) {
    const base =
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold";
    if (sev === "critical")
        return `${base} bg-red-500/20 text-red-400 border border-red-500/30`;
    if (sev === "high")
        return `${base} bg-orange-500/20 text-orange-400 border border-orange-500/30`;
    if (sev === "medium")
        return `${base} bg-amber-500/20 text-amber-400 border border-amber-500/30`;
    return `${base} bg-blue-500/20 text-blue-400 border border-blue-500/30`;
}

function riskColor(risk: string) {
    if (risk === "critical") return "text-red-400";
    if (risk === "high") return "text-orange-400";
    if (risk === "medium") return "text-amber-400";
    return "text-emerald-400";
}

function riskBg(risk: string) {
    if (risk === "critical") return "bg-red-500/20 text-red-400";
    if (risk === "high") return "bg-orange-500/20 text-orange-400";
    if (risk === "medium") return "bg-amber-500/20 text-amber-400";
    return "bg-emerald-500/20 text-emerald-400";
}

function modeBadge(mode: string) {
    if (mode === "third-party") return "bg-violet-500/20 text-violet-400 border-violet-500/30";
    if (mode === "self-managed") return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
    return "bg-gray-500/20 text-gray-400 border-gray-500/30";
}

function providerIcon(provider: string) {
    const icons: Record<string, string> = {
        clerk: "🔐",
        nextauth: "🔑",
        auth0: "🛡️",
        supabase: "⚡",
        jwt: "🎟️",
        session: "📝",
        custom: "🔧",
        none: "❌",
    };
    return icons[provider] ?? "❓";
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

function PhaseIndicator({ phases, timedOut }: { phases: number[]; timedOut: boolean }) {
    const allPhases = [1, 2, 3, 4, 5, 6, 7];
    return (
        <div className="flex items-center gap-1.5">
            {allPhases.map((p) => {
                const completed = phases.includes(p);
                return (
                    <div
                        key={p}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${
                            completed
                                ? "bg-violet-500/30 text-violet-300 border border-violet-500/40"
                                : "bg-gray-800 text-gray-600 border border-white/5"
                        }`}
                        title={`Phase ${p}${completed ? " ✓" : ""}`}
                    >
                        {p}
                    </div>
                );
            })}
            {timedOut && (
                <span className="ml-2 text-xs text-amber-400 font-medium animate-pulse">
                    ⏱ partial
                </span>
            )}
        </div>
    );
}

function FindingCard({ finding }: { finding: AuthFinding }) {
    const [open, setOpen] = useState(false);
    return (
        <div className="bg-gray-800/40 border border-white/5 rounded-lg overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
            >
                <span className={severityBadge(finding.severity)}>
                    {finding.severity}
                </span>
                <span className="text-sm font-medium text-gray-200 flex-1 truncate">
                    {finding.title}
                </span>
                <span className="text-xs text-gray-500 shrink-0">
                    {finding.category}
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
                    <p className="text-sm text-gray-300">{finding.description}</p>
                    <div className="flex gap-4 flex-wrap">
                        {finding.scaleBreakpoint && (
                            <div>
                                <Label>Breaks at</Label>
                                <p className="text-sm text-orange-300">{finding.scaleBreakpoint}</p>
                            </div>
                        )}
                        <div className="flex-1 min-w-[200px]">
                            <Label>Recommendation</Label>
                            <p className="text-sm text-emerald-300">{finding.recommendation}</p>
                        </div>
                    </div>
                    {finding.affectedFiles.length > 0 && (
                        <div>
                            <Label>Affected Files</Label>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                {finding.affectedFiles.map((f) => (
                                    <span
                                        key={f}
                                        className="px-2 py-0.5 rounded-md bg-gray-700 text-xs font-mono text-gray-300"
                                    >
                                        {f}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function BottleneckList({ bottlenecks }: { bottlenecks: string[] }) {
    if (bottlenecks.length === 0) return null;
    return (
        <div>
            <Label>Bottlenecks (by severity)</Label>
            <ol className="space-y-1 mt-1">
                {bottlenecks.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                        <span className="text-gray-600 font-mono text-xs mt-0.5 shrink-0">
                            {i + 1}.
                        </span>
                        <span className="text-gray-300">{b}</span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

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
    const report = result?.report ?? null;

    const findingCounts = report
        ? {
              total: report.findings.length,
              critical: report.findings.filter((f) => f.severity === "critical").length,
              high: report.findings.filter((f) => f.severity === "high").length,
              medium: report.findings.filter((f) => f.severity === "medium").length,
              low: report.findings.filter((f) => f.severity === "low").length,
          }
        : null;

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
                                    value: result.error ? "Error" : report ? "Success" : "No report",
                                    color: result.error ? "text-red-400" : report ? "text-emerald-400" : "text-amber-400",
                                },
                                {
                                    label: "Auth Provider",
                                    value: report
                                        ? `${providerIcon(report.authProvider)} ${report.authProvider}`
                                        : "—",
                                    color: "text-violet-400",
                                },
                                {
                                    label: "Execution Time",
                                    value: `${(result.executionTimeMs / 1000).toFixed(1)}s`,
                                    color: "text-purple-400",
                                },
                                {
                                    label: "Phases Done",
                                    value: report ? `${report.completedPhases.length}/7` : "—",
                                    color: "text-cyan-400",
                                },
                            ].map((s) => (
                                <Card key={s.label} className="!p-4">
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
                                        {tab === "report"
                                            ? `📊 Report (${findingCounts?.total ?? 0} findings)`
                                            : "📋 Raw JSON"}
                                    </button>
                                ))}
                            </div>

                            {/* Report tab */}
                            {activeTab === "report" && report && (
                                <div className="space-y-5">
                                    {/* Auth identity bar */}
                                    <Card>
                                        <div className="flex flex-wrap items-center gap-3 mb-4">
                                            <h3 className="text-sm font-semibold text-gray-200">
                                                Auth Stack
                                            </h3>
                                            <span
                                                className={`text-xs font-bold px-2.5 py-1 rounded-full border ${modeBadge(report.authMode)}`}
                                            >
                                                {report.authMode}
                                            </span>
                                            <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-gray-800 text-gray-300 border border-white/10">
                                                {providerIcon(report.authProvider)} {report.authProvider}
                                            </span>
                                        </div>
                                        <p className="text-sm text-gray-300 leading-relaxed">
                                            {report.summary}
                                        </p>
                                    </Card>

                                    {/* Phases + Scale analysis */}
                                    <div className="grid sm:grid-cols-2 gap-4">
                                        {/* Phases completed */}
                                        <Card>
                                            <Label>Investigation Progress</Label>
                                            <div className="mt-2">
                                                <PhaseIndicator phases={report.completedPhases} timedOut={report.timedOut} />
                                            </div>
                                            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                                                <span>1: Stack</span>
                                                <span>2: Tree</span>
                                                <span>3: Routes</span>
                                                <span>4: Middleware</span>
                                                <span>5: Schema</span>
                                                <span>6: Patterns</span>
                                                <span>7: Report</span>
                                            </div>
                                        </Card>

                                        {/* Scale analysis */}
                                        <Card>
                                            <div className="flex items-center gap-2 mb-3">
                                                <Label>Scale Risk</Label>
                                                <span
                                                    className={`text-xs font-bold uppercase px-2 py-0.5 rounded-full ${riskBg(report.scaleAnalysis.overallRisk)}`}
                                                >
                                                    {report.scaleAnalysis.overallRisk}
                                                </span>
                                            </div>
                                            <div className="mb-3">
                                                <p className="text-xs text-gray-500">Estimated Breakpoint</p>
                                                <p className={`text-lg font-bold ${riskColor(report.scaleAnalysis.overallRisk)}`}>
                                                    {report.scaleAnalysis.estimatedBreakpoint}
                                                </p>
                                            </div>
                                            <BottleneckList bottlenecks={report.scaleAnalysis.bottlenecks} />
                                        </Card>
                                    </div>

                                    {/* Severity breakdown */}
                                    {findingCounts && findingCounts.total > 0 && (
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                            {[
                                                { label: "Critical", value: findingCounts.critical, color: "text-red-400" },
                                                { label: "High", value: findingCounts.high, color: "text-orange-400" },
                                                { label: "Medium", value: findingCounts.medium, color: "text-amber-400" },
                                                { label: "Low", value: findingCounts.low, color: "text-blue-400" },
                                            ].map((s) => (
                                                <div
                                                    key={s.label}
                                                    className="bg-gray-800/60 border border-white/5 rounded-lg p-3 text-center"
                                                >
                                                    <p className={`text-2xl font-bold ${s.color}`}>
                                                        {s.value}
                                                    </p>
                                                    <p className="text-xs text-gray-500">{s.label}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Findings */}
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
                                            Findings
                                        </h3>
                                        <div className="space-y-2">
                                            {report.findings.map((f, i) => (
                                                <FindingCard key={i} finding={f} />
                                            ))}
                                            {report.findings.length === 0 && (
                                                <p className="text-sm text-gray-500 text-center py-6">
                                                    No findings reported.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === "report" && !report && !result.error && (
                                <Card className="text-center py-10">
                                    <p className="text-gray-500">
                                        Agent completed but did not produce a final report.
                                    </p>
                                    <p className="text-xs text-gray-600 mt-1">
                                        Switch to Raw JSON to inspect the response.
                                    </p>
                                </Card>
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
