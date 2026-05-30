"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft,
    Shield,
    AlertTriangle,
    Info,
    Clock,
    Wrench,
    ChevronDown,
    ChevronRight,
    CheckCircle2,
    XCircle,
    FileCode2,
    Loader2,
    Zap,
    BarChart3,
    Bug,
    Github,
} from "lucide-react";
import { parseFindings, getArchetypeMeta, type ParsedFinding, type FindingSeverity } from "@/lib/findings-parser";
import { getRepositoryWithAgentReports } from "../../../../actions/github/repository-queries";

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface Repository {
    id: string;
    repositoryId: string;
    name: string;
    fullName: string;
    framework: string | null;
    archetypes: { name: string; score: number }[] | null;
    archClassificationConfidence: string | null;
    repoSizeKB: number | null;
    updatedAt: string;
}

interface AgentReport {
    id: string;
    archetype: string;
    rawFindings: string | null;
    totalToolCalls: number;
    executionTimeMs: number;
    status: string;
    error: string | null;
    updatedAt: string;
}

/* ─── Severity Styling ─────────────────────────────────────────────────────── */

const SEVERITY_CONFIG: Record<
    FindingSeverity,
    { icon: typeof Shield; bg: string; border: string; text: string; badge: string; label: string }
> = {
    critical: {
        icon: Shield,
        bg: "bg-red-500/5",
        border: "border-red-500/20",
        text: "text-red-400",
        badge: "bg-red-500/15 text-red-400 border-red-500/30",
        label: "CRITICAL",
    },
    warning: {
        icon: AlertTriangle,
        bg: "bg-amber-500/5",
        border: "border-amber-500/20",
        text: "text-amber-400",
        badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        label: "WARNING",
    },
    info: {
        icon: Info,
        bg: "bg-blue-500/5",
        border: "border-blue-500/20",
        text: "text-blue-400",
        badge: "bg-blue-500/15 text-blue-400 border-blue-500/30",
        label: "INFO",
    },
};

/* ─── Finding Card ─────────────────────────────────────────────────────────── */

function FindingCard({ finding }: { finding: ParsedFinding }) {
    const cfg = SEVERITY_CONFIG[finding.severity];
    const Icon = cfg.icon;

    return (
        <div className={`rounded-lg border ${cfg.border} ${cfg.bg} p-4 transition-all hover:border-opacity-50`}>
            {/* Header */}
            <div className="flex items-start gap-3 mb-3">
                <div className={`mt-0.5 p-1.5 rounded-md ${cfg.badge} border`}>
                    <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-bold tracking-wider ${cfg.text}`}>
                            {finding.id}
                        </span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${cfg.badge}`}>
                            {cfg.label}
                        </span>
                    </div>
                    <h4 className="text-sm font-semibold text-foreground leading-snug">
                        {finding.title}
                    </h4>
                </div>
            </div>

            {/* File reference */}
            {finding.file && (
                <div className="flex items-center gap-2 mb-2.5 pl-10">
                    <FileCode2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <code className="text-xs text-muted-foreground font-mono bg-muted/50 px-2 py-0.5 rounded truncate">
                        {finding.file}
                    </code>
                </div>
            )}

            {/* Detail fields */}
            <div className="space-y-2 pl-10">
                {finding.evidence && (
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Evidence
                        </span>
                        <p className="text-xs text-foreground/80 leading-relaxed mt-0.5">
                            {finding.evidence}
                        </p>
                    </div>
                )}
                {finding.impact && (
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Impact
                        </span>
                        <p className="text-xs text-foreground/80 leading-relaxed mt-0.5">
                            {finding.impact}
                        </p>
                    </div>
                )}
                {finding.fix && (
                    <div>
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400/80">
                            Fix
                        </span>
                        <p className="text-xs text-green-300/80 leading-relaxed mt-0.5">
                            {finding.fix}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

/* ─── Agent Report Card ────────────────────────────────────────────────────── */

function AgentReportCard({ report }: { report: AgentReport }) {
    const [expanded, setExpanded] = useState(false);
    const meta = getArchetypeMeta(report.archetype);
    const parsed = parseFindings(report.rawFindings);
    const isCompleted = report.status === "completed";
    const isFailed = report.status === "failed";

    return (
        <div
            className={`
                rounded-xl border border-border/50 overflow-hidden
                bg-card/50 backdrop-blur-sm
                transition-all duration-300
                ${expanded ? "ring-1 ring-border/50" : "hover:border-border"}
            `}
        >
            {/* Card header — clickable */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-4 p-5 text-left transition-colors hover:bg-muted/30"
            >
                {/* Archetype icon */}
                <div className="text-2xl shrink-0">{meta.emoji}</div>

                {/* Agent info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className={`font-semibold ${meta.color}`}>{meta.label} Agent</h3>
                        {isCompleted && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                                <CheckCircle2 className="h-3 w-3" /> Completed
                            </span>
                        )}
                        {isFailed && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">
                                <XCircle className="h-3 w-3" /> Failed
                            </span>
                        )}
                    </div>

                    {/* Metrics row */}
                    <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                            <Wrench className="h-3 w-3" />
                            {report.totalToolCalls} tool calls
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {(report.executionTimeMs / 1000).toFixed(1)}s
                        </span>
                        {parsed.totalCount > 0 && (
                            <span className="inline-flex items-center gap-3">
                                {parsed.criticalCount > 0 && (
                                    <span className="text-red-400">{parsed.criticalCount} critical</span>
                                )}
                                {parsed.warningCount > 0 && (
                                    <span className="text-amber-400">{parsed.warningCount} warning</span>
                                )}
                                {parsed.infoCount > 0 && (
                                    <span className="text-blue-400">{parsed.infoCount} info</span>
                                )}
                            </span>
                        )}
                    </div>
                </div>

                {/* Expand chevron */}
                <div className="text-muted-foreground shrink-0">
                    {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                </div>
            </button>

            {/* Expanded content */}
            {expanded && (
                <div className="border-t border-border/30 p-5 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    {isFailed && report.error && (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                            <p className="text-xs text-red-400 font-mono">{report.error}</p>
                        </div>
                    )}
                    {parsed.findings.length > 0 ? (
                        parsed.findings.map((finding) => (
                            <FindingCard key={finding.id} finding={finding} />
                        ))
                    ) : (
                        <p className="text-sm text-muted-foreground text-center py-4">
                            {report.rawFindings ? "Could not parse structured findings from this report." : "No findings generated."}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

/* ─── Stat Card ────────────────────────────────────────────────────────────── */

function StatCard({
    icon: Icon,
    label,
    value,
    color = "text-foreground",
}: {
    icon: typeof Zap;
    label: string;
    value: string | number;
    color?: string;
}) {
    return (
        <div className="rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-muted/50">
                <Icon className={`h-5 w-5 ${color}`} />
            </div>
            <div>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className={`text-lg font-bold ${color}`}>{value}</p>
            </div>
        </div>
    );
}

/* ─── Main Page ────────────────────────────────────────────────────────────── */

export default function ReportsPage() {
    const params = useParams();
    const router = useRouter();
    const repositoryId = params.repositoryId as string;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repository, setRepository] = useState<Repository | null>(null);
    const [reports, setReports] = useState<AgentReport[]>([]);

    const fetchReports = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await getRepositoryWithAgentReports(repositoryId);
            setRepository(data.repository);
            setReports(data.reports);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    }, [repositoryId]);

    useEffect(() => {
        if (repositoryId) fetchReports();
    }, [repositoryId, fetchReports]);

    // Aggregate stats
    const allFindings = reports
        .filter((r) => r.status === "completed" && r.rawFindings)
        .map((r) => parseFindings(r.rawFindings));

    const totalCritical = allFindings.reduce((s, r) => s + r.criticalCount, 0);
    const totalWarning = allFindings.reduce((s, r) => s + r.warningCount, 0);
    const totalInfo = allFindings.reduce((s, r) => s + r.infoCount, 0);
    const totalFindings = totalCritical + totalWarning + totalInfo;
    const completedAgents = reports.filter((r) => r.status === "completed").length;
    const failedAgents = reports.filter((r) => r.status === "failed").length;
    const totalTime = reports.reduce((s, r) => s + r.executionTimeMs, 0);

    const overallRisk =
        totalCritical >= 3 ? "Critical" : totalCritical >= 1 ? "High" : totalWarning >= 3 ? "Medium" : "Low";
    const riskColor =
        overallRisk === "Critical"
            ? "text-red-400"
            : overallRisk === "High"
                ? "text-orange-400"
                : overallRisk === "Medium"
                    ? "text-amber-400"
                    : "text-green-400";

    /* ── Loading state ─────────────────────────────────────────────── */

    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Loading reports...</p>
                </div>
            </div>
        );
    }

    /* ── Error state ───────────────────────────────────────────────── */

    if (error || !repository) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="text-center space-y-4">
                    <XCircle className="h-12 w-12 text-red-400 mx-auto" />
                    <h2 className="text-xl font-semibold">Failed to load reports</h2>
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <button
                        onClick={() => router.back()}
                        className="text-sm text-muted-foreground hover:text-foreground transition-colors underline"
                    >
                        Go back
                    </button>
                </div>
            </div>
        );
    }

    /* ── Main render ───────────────────────────────────────────────── */

    return (
        <div className="min-h-screen bg-background">
            {/* ── Top bar ──────────────────────────────────────────── */}
            <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <Link
                            href="/"
                            className="p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                        >
                            <ArrowLeft className="h-4 w-4" />
                        </Link>
                        <div>
                            <h1 className="text-sm font-semibold flex items-center gap-2">
                                <Github className="h-4 w-4 text-muted-foreground" />
                                {repository.fullName}
                            </h1>
                            <div className="flex items-center gap-2 mt-0.5">
                                {repository.framework && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wider">
                                        {repository.framework}
                                    </span>
                                )}
                                <span className="text-[10px] text-muted-foreground">
                                    Analyzed {new Date(repository.updatedAt).toLocaleDateString("en-US", {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                        hour: "2-digit",
                                        minute: "2-digit",
                                    })}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </header>

            {/* ── Content ──────────────────────────────────────────── */}
            <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-8">
                {/* ── Summary stats ────────────────────────────────── */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatCard icon={Bug} label="Total Findings" value={totalFindings} color="text-foreground" />
                    <StatCard icon={Shield} label="Critical Issues" value={totalCritical} color="text-red-400" />
                    <StatCard icon={Zap} label="Agents Run" value={`${completedAgents}/${reports.length}`} color="text-blue-400" />
                    <StatCard icon={BarChart3} label="Risk Level" value={overallRisk} color={riskColor} />
                </div>

                {/* ── Severity breakdown banner ───────────────────── */}
                {totalFindings > 0 && (
                    <div className="rounded-xl border border-border/50 bg-card/50 backdrop-blur-sm p-4">
                        <div className="flex items-center gap-6">
                            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Findings Breakdown</span>
                            <div className="flex-1 flex items-center gap-1 h-3 rounded-full overflow-hidden bg-muted/30">
                                {totalCritical > 0 && (
                                    <div
                                        className="h-full bg-red-500 rounded-full transition-all"
                                        style={{ width: `${(totalCritical / totalFindings) * 100}%` }}
                                    />
                                )}
                                {totalWarning > 0 && (
                                    <div
                                        className="h-full bg-amber-500 rounded-full transition-all"
                                        style={{ width: `${(totalWarning / totalFindings) * 100}%` }}
                                    />
                                )}
                                {totalInfo > 0 && (
                                    <div
                                        className="h-full bg-blue-500 rounded-full transition-all"
                                        style={{ width: `${(totalInfo / totalFindings) * 100}%` }}
                                    />
                                )}
                            </div>
                            <div className="flex items-center gap-4 text-xs shrink-0">
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-red-500" /> {totalCritical} Critical
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-amber-500" /> {totalWarning} Warning
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-2 h-2 rounded-full bg-blue-500" /> {totalInfo} Info
                                </span>
                            </div>
                        </div>
                    </div>
                )}

                {/* ── Execution summary ───────────────────────────── */}
                <div className="flex items-center gap-6 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <Clock className="h-3.5 w-3.5" />
                        Total execution: {(totalTime / 1000).toFixed(1)}s
                    </span>
                    {failedAgents > 0 && (
                        <span className="inline-flex items-center gap-1.5 text-red-400">
                            <XCircle className="h-3.5 w-3.5" />
                            {failedAgents} agent{failedAgents > 1 ? "s" : ""} failed
                        </span>
                    )}
                </div>

                {/* ── Agent report cards ──────────────────────────── */}
                <div className="space-y-4">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <BarChart3 className="h-5 w-5 text-muted-foreground" />
                        Agent Reports
                    </h2>
                    {reports.length === 0 ? (
                        <div className="rounded-xl border border-border/50 bg-card/50 p-8 text-center">
                            <p className="text-muted-foreground">No agent reports found for this repository.</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {reports.map((report) => (
                                <AgentReportCard key={report.id} report={report} />
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
