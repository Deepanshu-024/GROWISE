"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
    ArrowLeft, ArrowRight, Loader2, Github, Send, Bot, User, FileText,
    MessageSquare, XCircle, Zap, Database, Globe, Cpu, Shield,
    TrendingDown, Users, Scale, AlertTriangle, ChevronRight,
    Plus, ChevronDown, Check, ExternalLink, History,
} from "lucide-react";
import { Button } from "@/components/ui/button";

/* ─── Types ────────────────────────────────────────────────────────────────── */

interface Archetype { name: string; score: number }

interface Repository {
    id: string;
    fullName: string;
    framework: string | null;
    archetypes: Archetype[] | null;
    compiledReport: string | null;
    compiledReportAt: string | null;
    updatedAt: string;
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    mode?: string;
    referencedClusters?: string[];
    issueNumber?: number;
    issueUrl?: string;
}

interface Conversation {
    id: string;
    title: string | null;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
}

interface ParsedBirdsEye {
    bottleneckLabel: string;
    bottleneckExplanation: string;
    maturityStage: string;
    maturityJustification: string;
    losses: string[];
}

/* ─── XML Tag Helpers ──────────────────────────────────────────────────────── */

function extractTag(xml: string, tag: string): string {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
    const m = xml.match(re);
    return m ? m[1].trim() : "";
}

function extractAllTags(xml: string, tag: string): string[] {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
    const results: string[] = [];
    let m;
    while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
    return results;
}

function parseBirdsEye(report: string): ParsedBirdsEye | null {
    const bev = extractTag(report, "birds_eye_view");
    if (!bev) return null;
    const pb = extractTag(bev, "primary_bottleneck");
    const am = extractTag(bev, "architecture_maturity");
    const pl = extractTag(bev, "possible_losses");
    return {
        bottleneckLabel: extractTag(pb, "label"),
        bottleneckExplanation: extractTag(pb, "explanation"),
        maturityStage: extractTag(am, "stage"),
        maturityJustification: extractTag(am, "justification"),
        losses: extractAllTags(pl, "loss"),
    };
}

interface ParsedCluster {
    risk: number | null;
    severity: string;
    title: string;
    findingIds: string;
    description: string;
    rootMechanism: string;
    failureModes: string[];
    ignoreCost: string;
    mitigations: string[];
    files: { path: string; role: string }[];
}

function parseClusters(report: string): ParsedCluster[] {
    const clustersBlock = extractTag(report, "clusters");
    if (!clustersBlock) return [];
    const clusterXmls = extractAllTags(clustersBlock, "cluster");
    return clusterXmls.map((c) => {
        const riskStr = extractTag(c, "risk");
        const filesBlock = extractTag(c, "related_files");
        const fileXmls = extractAllTags(filesBlock, "file");
        const techBlock = extractTag(c, "technical_details");
        const failureModesBlock = extractTag(techBlock, "failure_modes");
        const mitigationsBlock = extractTag(techBlock, "mitigations");
        return {
            risk: riskStr ? parseInt(riskStr, 10) || null : null,
            severity: extractTag(c, "severity"),
            title: extractTag(c, "title"),
            findingIds: extractTag(c, "finding_ids"),
            description: extractTag(c, "description"),
            rootMechanism: extractTag(techBlock, "root_mechanism"),
            failureModes: extractAllTags(failureModesBlock, "point"),
            ignoreCost: extractTag(techBlock, "ignore_cost"),
            mitigations: extractAllTags(mitigationsBlock, "point"),
            files: fileXmls.map((f) => ({
                path: extractTag(f, "path"),
                role: extractTag(f, "role"),
            })),
        };
    });
}

interface RevenueRiskItem {
    clusterTitle: string;
    findingIds: string;
    consequence: string;
}

interface ParsedRevenueRisk {
    directRevenueLoss: RevenueRiskItem[];
    userChurnRisk: RevenueRiskItem[];
    complianceRisk: RevenueRiskItem[];
    verdict: string;
}

function parseRevenueRisk(report: string): ParsedRevenueRisk | null {
    const rra = extractTag(report, "revenue_risk_assessment");
    if (!rra) return null;
    const parseItems = (category: string): RevenueRiskItem[] => {
        const block = extractTag(rra, category);
        if (!block) return [];
        return extractAllTags(block, "item").map((item) => ({
            clusterTitle: extractTag(item, "cluster_title"),
            findingIds: extractTag(item, "finding_ids"),
            consequence: extractTag(item, "consequence"),
        }));
    };
    return {
        directRevenueLoss: parseItems("direct_revenue_loss"),
        userChurnRisk: parseItems("user_churn_risk"),
        complianceRisk: parseItems("compliance_risk"),
        verdict: extractTag(rra, "verdict"),
    };
}

/* ─── Bottleneck Icon Helper ───────────────────────────────────────────────── */

function BottleneckIcon({ label }: { label: string }) {
    const l = label.toLowerCase();
    if (l.includes("network")) return <Globe className="h-5 w-5" />;
    if (l.includes("database")) return <Database className="h-5 w-5" />;
    if (l.includes("api")) return <Globe className="h-5 w-5" />;
    if (l.includes("compute")) return <Cpu className="h-5 w-5" />;
    if (l.includes("auth")) return <Shield className="h-5 w-5" />;
    return <Zap className="h-5 w-5" />;
}

function LossIcon({ type }: { type: string }) {
    const t = type.toLowerCase();
    if (t.includes("revenue")) return <TrendingDown className="h-4 w-4" />;
    if (t.includes("churn")) return <Users className="h-4 w-4" />;
    if (t.includes("compliance")) return <Scale className="h-4 w-4" />;
    return <AlertTriangle className="h-4 w-4" />;
}

const MATURITY_COLORS: Record<string, { bg: string; text: string; border: string; glow: string }> = {
    "mvp-ready": { bg: "bg-amber-500/10", text: "text-amber-300", border: "border-amber-400/30", glow: "shadow-[0_0_12px_rgba(251,191,36,0.15)]" },
    "growth-ready": { bg: "bg-cyan-500/10", text: "text-cyan-300", border: "border-cyan-400/30", glow: "shadow-[0_0_12px_rgba(34,211,238,0.15)]" },
    "enterprise-ready": { bg: "bg-emerald-500/10", text: "text-emerald-300", border: "border-emerald-400/30", glow: "shadow-[0_0_12px_rgba(52,211,153,0.15)]" },
};

const SEVERITY_COLORS: Record<string, { bg: string; text: string; border: string; dot: string; glow: string }> = {
    critical: { bg: "bg-rose-500/10", text: "text-rose-400", border: "border-rose-500/30", dot: "bg-rose-400", glow: "shadow-[0_0_8px_rgba(251,113,133,0.4)]" },
    warning: { bg: "bg-amber-500/10", text: "text-amber-300", border: "border-amber-400/30", dot: "bg-amber-400", glow: "shadow-[0_0_8px_rgba(251,191,36,0.4)]" },
    info: { bg: "bg-cyan-500/10", text: "text-cyan-300", border: "border-cyan-400/30", dot: "bg-cyan-400", glow: "shadow-[0_0_8px_rgba(34,211,238,0.4)]" },
};

/* ─── Clusters View Component ──────────────────────────────────────────────── */

function ClustersView({ clusters }: { clusters: ParsedCluster[] }) {
    const [openIdx, setOpenIdx] = useState<number | null>(null);

    return (
        <div className="space-y-3">
            {clusters.map((cluster, i) => {
                const isOpen = openIdx === i;
                const sev = SEVERITY_COLORS[cluster.severity.toLowerCase()] || SEVERITY_COLORS.info;
                return (
                    <div key={i} className={`rounded-xl border ${isOpen ? sev.border : "border-white/6"} bg-white/3 backdrop-blur-sm overflow-hidden transition-all duration-300 ${isOpen ? sev.glow : "hover:border-white/12"}`}>
                        {/* Header — always visible */}
                        <button
                            onClick={() => setOpenIdx(isOpen ? null : i)}
                            className="w-full flex items-center gap-3 p-4 text-left hover:bg-white/4 transition-colors cursor-pointer"
                        >
                            {/* Severity dot */}
                            <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${sev.dot} ${sev.glow}`} />
                            {/* Title + finding IDs */}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold truncate">{cluster.title}</p>
                                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{cluster.findingIds}</p>
                            </div>
                            {/* Severity label */}
                            <span className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${sev.bg} ${sev.text}`}>
                                {cluster.severity}
                            </span>
                            {/* Chevron */}
                            <ChevronRight className={`shrink-0 h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        </button>

                        {/* Body — expanded */}
                        {isOpen && (
                            <div className="px-4 pb-4 space-y-3 border-t border-border/30 pt-3">
                                <div>
                                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Description</h4>
                                    <p className="text-sm leading-relaxed text-foreground/90">{cluster.description}</p>
                                </div>

                                {/* Root Mechanism */}
                                {cluster.rootMechanism && (
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Root Mechanism</h4>
                                        <p className="text-sm leading-relaxed text-foreground/80">{cluster.rootMechanism}</p>
                                    </div>
                                )}

                                {/* Failure Modes */}
                                {cluster.failureModes.length > 0 && (
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Failure Modes</h4>
                                        <ul className="space-y-1 pl-4">
                                            {cluster.failureModes.map((fm, fi) => (
                                                <li key={fi} className="text-sm leading-relaxed text-foreground/80 list-disc">{fm}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}

                                {/* Cost of Ignoring */}
                                {cluster.ignoreCost && (
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Cost of Ignoring</h4>
                                        <p className="text-sm leading-relaxed text-foreground/80">{cluster.ignoreCost}</p>
                                    </div>
                                )}

                                {/* Mitigations */}
                                {cluster.mitigations.length > 0 && (
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Mitigations</h4>
                                        <ul className="space-y-1 pl-4">
                                            {cluster.mitigations.map((m, mi) => (
                                                <li key={mi} className="text-sm leading-relaxed text-foreground/80 list-disc">{m}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {cluster.files.length > 0 && (
                                    <div>
                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Related Files</h4>
                                        <ul className="space-y-1">
                                            {cluster.files.map((f, fi) => (
                                                <li key={fi} className="flex items-start gap-2 text-xs">
                                                    <code className="shrink-0 px-1.5 py-0.5 rounded bg-muted text-foreground/80 font-mono">{f.path}</code>
                                                    <span className="text-muted-foreground">{f.role}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

/* ─── Revenue Risk View Component ──────────────────────────────────────────── */

const RISK_CATEGORIES: { key: keyof Omit<ParsedRevenueRisk, "verdict">; label: string; icon: React.ReactNode; color: string; borderColor: string }[] = [
    { key: "directRevenueLoss", label: "Direct Revenue Loss", icon: <TrendingDown className="h-4 w-4" />, color: "text-emerald-400", borderColor: "border-emerald-500/20" },
    { key: "userChurnRisk", label: "User Churn Risk", icon: <Users className="h-4 w-4" />, color: "text-amber-300", borderColor: "border-amber-400/20" },
    { key: "complianceRisk", label: "Compliance Risk", icon: <Scale className="h-4 w-4" />, color: "text-cyan-300", borderColor: "border-cyan-400/20" },
];

function RevenueRiskView({ revenueRisk }: { revenueRisk: ParsedRevenueRisk }) {
    return (
        <div className="space-y-6">
            {RISK_CATEGORIES.map((cat, catIdx) => {
                const items = revenueRisk[cat.key];
                if (items.length === 0) return null;
                return (
                    <div key={cat.key}>
                        {catIdx > 0 && <div className="border-t border-white/15 my-5" />}
                        <div className="space-y-3">
                            <div className={`flex items-center gap-2 ${cat.color}`}>
                                {cat.icon}
                                <h3 className="text-sm font-semibold uppercase tracking-wider">{cat.label}</h3>
                            </div>
                            <div className="space-y-2">
                                {items.map((item, i) => (
                                    <div key={i} className={`rounded-lg border ${cat.borderColor} bg-white/3 backdrop-blur-sm p-3.5 space-y-1.5`}>
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-sm font-semibold">{item.clusterTitle}</p>
                                            <span className="text-[10px] text-muted-foreground font-mono shrink-0 px-1.5 py-0.5 rounded bg-white/4">{item.findingIds}</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground leading-relaxed">{item.consequence}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                );
            })}

            {/* Divider before verdict */}
            {revenueRisk.verdict && <div className="border-t border-white/10 my-5" />}

            {/* Verdict */}
            {revenueRisk.verdict && (
                <div className="rounded-xl border border-fuchsia-500/20 bg-linear-to-r from-fuchsia-500/4 to-rose-500/4 backdrop-blur-sm p-5 space-y-2 shadow-[0_0_20px_rgba(217,70,239,0.06)]">
                    <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-fuchsia-400" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-fuchsia-300">Verdict</h3>
                    </div>
                    <p className="text-sm leading-relaxed text-foreground/90">{revenueRisk.verdict}</p>
                </div>
            )}
        </div>
    );
}

/* ─── Bird's-Eye View Component ────────────────────────────────────────────── */

function BirdsEyeView({
    birdsEye,
    archetypes,
    onViewClusters,
}: {
    birdsEye: ParsedBirdsEye;
    archetypes: Archetype[] | null;
    onViewClusters: () => void;
}) {
    const maturityKey = birdsEye.maturityStage.toLowerCase();
    const mc = MATURITY_COLORS[maturityKey] || MATURITY_COLORS["mvp-ready"];
    const sortedArchetypes = useMemo(
        () => (archetypes ?? []).filter((a) => a.score > 0).sort((a, b) => b.score - a.score),
        [archetypes],
    );

    return (
        <div className="space-y-8">
            {/* Title */}
            <div>
                <h2 className="text-2xl font-bold tracking-tight">Bird&apos;s-Eye View</h2>
                <p className="text-sm text-muted-foreground mt-1.5">
                    An overview of the project scale analysis.
                </p>
            </div>

            {/* Archetypes */}
            {sortedArchetypes.length > 0 && (
                <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Architecture</h3>
                    <div className="flex flex-wrap gap-2">
                        {sortedArchetypes.map((a) => (
                            <span
                                key={a.name}
                                className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium bg-cyan-500/10 text-cyan-300 border border-cyan-400/25 shadow-[0_0_8px_rgba(34,211,238,0.1)] hover:shadow-[0_0_14px_rgba(34,211,238,0.2)] transition-shadow"
                            >
                                {a.name}
                            </span>
                        ))}
                    </div>
                </div>
            )}

            {/* Cards + Right Arrow */}
            <div className="flex gap-4 items-stretch">
                {/* Cards — 3 columns */}
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {/* Primary Bottleneck */}
                    <div className="rounded-xl border border-white/10 bg-white/3 backdrop-blur-sm p-5 space-y-3 shadow-[0_0_16px_rgba(255,255,255,0.03)] hover:border-white/20 transition-all">
                        <div className="flex items-center gap-2 text-emerald-400">
                            <BottleneckIcon label={birdsEye.bottleneckLabel} />
                            <span className="text-xs font-semibold uppercase tracking-wider">Primary Bottleneck</span>
                        </div>
                        <p className="text-sm font-bold text-foreground">{birdsEye.bottleneckLabel}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{birdsEye.bottleneckExplanation}</p>
                    </div>

                    {/* Product Maturity */}
                    <div className="rounded-xl border border-white/10 bg-white/3 backdrop-blur-sm p-5 space-y-3 shadow-[0_0_16px_rgba(255,255,255,0.03)] hover:border-white/20 transition-all">
                        <div className={`flex items-center gap-2 ${mc.text}`}>
                            <Zap className="h-4 w-4" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Product Maturity</span>
                        </div>
                        <p className="text-sm font-bold text-foreground">{birdsEye.maturityStage}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed">{birdsEye.maturityJustification}</p>
                    </div>

                    {/* Risk Exposure */}
                    <div className="rounded-xl border border-white/10 bg-white/3 backdrop-blur-sm p-5 space-y-3 shadow-[0_0_16px_rgba(255,255,255,0.03)] hover:border-white/20 transition-all">
                        <div className="flex items-center gap-2 text-fuchsia-400">
                            <AlertTriangle className="h-4 w-4" />
                            <span className="text-xs font-semibold uppercase tracking-wider">Risk Exposure</span>
                        </div>
                        <div className="space-y-2">
                            {birdsEye.losses.map((loss, idx) => {
                                const severity = idx === 0 ? "High" : idx === 1 ? "Medium" : "Low";
                                const sevColor = severity === "High"
                                    ? "bg-rose-500/20 text-rose-400"
                                    : severity === "Medium"
                                        ? "bg-amber-500/20 text-amber-300"
                                        : "bg-cyan-500/20 text-cyan-300";
                                return (
                                    <div key={loss} className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            <LossIcon type={loss} />
                                            <span className="text-sm">{loss}</span>
                                        </div>
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${sevColor}`}>
                                            {severity}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Right-side CTA arrow with pulsing glow */}
                <button
                    onClick={onViewClusters}
                    className="shrink-0 self-center cursor-pointer hover:scale-110 transition-transform"
                    title="View Detailed Risk Clusters"
                >
                    <span className="text-3xl font-light text-violet-400 animate-pulse-glow">&gt;</span>
                </button>
            </div>
        </div>
    );
}

/* ─── Suggestion Chips ──────────────────────────────────────────────────────── */

const SUGGESTION_CHIPS = [
    "What are the top 3 risks?",
    "Which cluster should I fix first?",
    "Create an issue for the highest priority cluster",
    "Give me an implementation plan",
];

/* ─── Chat Panel ───────────────────────────────────────────────────────────── */

function ChatPanel({ repositoryId, clusterTitles }: { repositoryId: string; clusterTitles: string[] }) {
    // ── Conversation management ──
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
    const [loadingConversations, setLoadingConversations] = useState(true);

    // ── Chat state ──
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);

    // ── Cluster selector ──
    const [selectedClusters, setSelectedClusters] = useState<string[]>([]);
    const [clusterSelectorOpen, setClusterSelectorOpen] = useState(false);

    // ── Conversation list dropdown ──
    const [showConversationList, setShowConversationList] = useState(false);

    // ── Auto-scroll ──
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // ── Load conversations on mount ──
    const loadConversations = useCallback(async () => {
        try {
            setLoadingConversations(true);
            const res = await fetch(`/api/project/${repositoryId}/chat/history`);
            if (!res.ok) throw new Error("Failed to load conversations");
            const data = await res.json();
            const convos: Conversation[] = data.conversations ?? [];
            setConversations(convos);

            // If there are existing conversations and none is active, pick the latest
            if (convos.length > 0 && !activeConversationId) {
                setActiveConversationId(convos[0].id);
            }
        } catch (err) {
            console.error("[ChatPanel] Failed to load conversations:", err);
        } finally {
            setLoadingConversations(false);
        }
    }, [repositoryId, activeConversationId]);

    useEffect(() => {
        loadConversations();
    }, [loadConversations]);

    // ── Load messages when active conversation changes ──
    const loadConversationMessages = useCallback(async (convId: string) => {
        try {
            const res = await fetch(`/api/project/${repositoryId}/chat?conversationId=${convId}`);
            if (!res.ok) {
                console.error("[ChatPanel] Failed to load messages");
                setMessages([]);
                return;
            }
            const data = await res.json();
            const msgs: ChatMessage[] = (data.messages ?? []).map((m: any) => ({
                role: m.role,
                content: m.content,
                ...(m.mode ? { mode: m.mode } : {}),
                ...(m.referencedClusters ? { referencedClusters: m.referencedClusters } : {}),
                ...(m.issueNumber ? { issueNumber: m.issueNumber } : {}),
                ...(m.issueUrl ? { issueUrl: m.issueUrl } : {}),
            }));
            setMessages(msgs);
        } catch (err) {
            console.error("[ChatPanel] Error loading messages:", err);
            setMessages([]);
        }
    }, [repositoryId]);

    useEffect(() => {
        if (!activeConversationId) {
            setMessages([]);
            return;
        }
        loadConversationMessages(activeConversationId);
    }, [activeConversationId, loadConversationMessages]);

    // ── Create new conversation ──
    const createNewConversation = useCallback(async () => {
        try {
            const res = await fetch(`/api/project/${repositoryId}/chat/history`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            });
            if (!res.ok) throw new Error("Failed to create conversation");
            const data = await res.json();
            const newConvo: Conversation = {
                id: data.conversation.id,
                title: data.conversation.title,
                messageCount: 0,
                createdAt: data.conversation.createdAt,
                updatedAt: data.conversation.createdAt,
            };
            setConversations((prev) => [newConvo, ...prev]);
            setActiveConversationId(newConvo.id);
            setMessages([]);
            setSelectedClusters([]);
            return newConvo.id;
        } catch (err) {
            console.error("[ChatPanel] Failed to create conversation:", err);
            return null;
        }
    }, [repositoryId]);

    // ── Toggle cluster selection ──
    const toggleCluster = useCallback((title: string) => {
        setSelectedClusters((prev) =>
            prev.includes(title) ? prev.filter((c) => c !== title) : [...prev, title],
        );
    }, []);

    // ── Send message ──
    const sendMessage = useCallback(async (overrideText?: string) => {
        const text = (overrideText ?? input).trim();
        if (!text || loading) return;

        // Ensure we have an active conversation
        let convId = activeConversationId;
        if (!convId) {
            convId = await createNewConversation();
            if (!convId) return;
        }

        const userMsg: ChatMessage = {
            role: "user",
            content: text,
            ...(selectedClusters.length > 0 ? { referencedClusters: [...selectedClusters] } : {}),
        };
        setMessages((prev) => [...prev, userMsg]);
        setInput("");
        setLoading(true);

        try {
            const res = await fetch(`/api/project/${repositoryId}/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: text,
                    conversationId: convId,
                    ...(selectedClusters.length > 0 ? { referencedClusters: selectedClusters } : {}),
                }),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${res.status}`);
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("No response body");

            const decoder = new TextDecoder();
            let buffer = "";
            let assistantMsg: ChatMessage | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === "response") {
                            assistantMsg = {
                                role: "assistant",
                                content: event.content,
                                mode: event.mode,
                                ...(event.issueNumber ? { issueNumber: event.issueNumber } : {}),
                                ...(event.issueUrl ? { issueUrl: event.issueUrl } : {}),
                            };
                        } else if (event.type === "error") {
                            assistantMsg = {
                                role: "assistant",
                                content: `Error: ${event.error}`,
                            };
                        }
                    } catch { /* ignore malformed SSE */ }
                }
            }

            if (assistantMsg) {
                setMessages((prev) => [...prev, assistantMsg!]);
            }

            // Clear cluster selection after sending
            setSelectedClusters([]);
        } catch (err) {
            setMessages((prev) => [
                ...prev,
                {
                    role: "assistant",
                    content: `Sorry, I encountered an error: ${err instanceof Error ? err.message : "Unknown error"}`,
                },
            ]);
        } finally {
            setLoading(false);
        }
    }, [input, loading, activeConversationId, selectedClusters, repositoryId, createNewConversation]);

    return (
        <div className="flex flex-col h-full">
            {/* Chat header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/50 shrink-0">
                <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-emerald-400" />
                    <span className="text-sm font-semibold">ScaleBot</span>
                    {activeConversationId && (
                        <span className="text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                            {conversations.find((c) => c.id === activeConversationId)?.title || "New chat"}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {conversations.length > 0 && (
                        <button
                            onClick={() => setShowConversationList((prev) => !prev)}
                            className={`p-1.5 rounded-lg transition-colors ${
                                showConversationList
                                    ? "text-emerald-400 bg-emerald-500/10"
                                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                            }`}
                            title="Chat history"
                        >
                            <History className="h-4 w-4" />
                        </button>
                    )}
                    <button
                        onClick={createNewConversation}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                        title="New conversation"
                    >
                        <Plus className="h-4 w-4" />
                    </button>
                </div>
            </div>

            {/* Conversation list dropdown */}
            {showConversationList && (
                <div className="shrink-0 border-b border-border/50 bg-muted/20 max-h-[200px] overflow-y-auto">
                    {conversations.map((convo) => {
                        const isActive = convo.id === activeConversationId;
                        return (
                            <button
                                key={convo.id}
                                onClick={() => {
                                    setActiveConversationId(convo.id);
                                    setShowConversationList(false);
                                }}
                                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors cursor-pointer ${
                                    isActive
                                        ? "bg-emerald-500/8 border-l-2 border-emerald-400"
                                        : "hover:bg-muted/40 border-l-2 border-transparent"
                                }`}
                            >
                                <MessageSquare className={`shrink-0 h-3.5 w-3.5 ${isActive ? "text-emerald-400" : "text-muted-foreground"}`} />
                                <div className="flex-1 min-w-0">
                                    <p className={`text-xs font-medium truncate ${isActive ? "text-emerald-300" : "text-foreground/80"}`}>
                                        {convo.title || "New chat"}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground mt-0.5">
                                        {convo.messageCount} message{convo.messageCount !== 1 ? "s" : ""} · {new Date(convo.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                    </p>
                                </div>
                                {isActive && <Check className="shrink-0 h-3 w-3 text-emerald-400" />}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 min-h-0">
                {loadingConversations ? (
                    <div className="flex items-center justify-center h-full">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-4 opacity-70">
                        <MessageSquare className="h-10 w-10 text-muted-foreground" />
                        <div>
                            <p className="text-sm font-medium">Ask about the report</p>
                            <p className="text-xs text-muted-foreground mt-1">
                                Click a suggestion or type your own question.
                            </p>
                        </div>
                        {/* Suggestion chips */}
                        <div className="flex flex-wrap justify-center gap-2 max-w-[320px]">
                            {SUGGESTION_CHIPS.map((chip) => (
                                <button
                                    key={chip}
                                    onClick={() => sendMessage(chip)}
                                    className="text-[11px] px-3 py-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/5 text-emerald-300 hover:bg-emerald-500/15 hover:border-emerald-500/40 transition-all cursor-pointer"
                                >
                                    {chip}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <>
                        {messages.map((msg, i) => (
                            <div key={i} className={`flex gap-2.5 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                                {msg.role === "assistant" && (
                                    <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 h-fit">
                                        <Bot className="h-3.5 w-3.5 text-emerald-400" />
                                    </div>
                                )}
                                <div className="max-w-[85%] space-y-1.5">
                                    {/* Mode badge for assistant messages */}
                                    {msg.role === "assistant" && msg.mode && msg.mode !== "answer" && (
                                        <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
                                            msg.mode === "create_issue"
                                                ? "bg-violet-500/15 text-violet-300 border border-violet-500/25"
                                                : msg.mode === "build_plan"
                                                    ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/25"
                                                    : "bg-amber-500/15 text-amber-300 border border-amber-500/25"
                                        }`}>
                                            {msg.mode === "create_issue" ? "Issue Created" : msg.mode === "build_plan" ? "Implementation Plan" : "Clarification"}
                                        </span>
                                    )}
                                    {/* Referenced clusters badge for user messages */}
                                    {msg.role === "user" && msg.referencedClusters && msg.referencedClusters.length > 0 && (
                                        <div className="flex flex-wrap gap-1 justify-end">
                                            {msg.referencedClusters.map((c) => (
                                                <span key={c} className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
                                                    {c}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                    <div
                                        className={`rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${msg.role === "user"
                                            ? "bg-primary text-primary-foreground rounded-br-sm"
                                            : "bg-muted/60 border border-border/50 rounded-bl-sm"
                                        }`}
                                    >
                                        {msg.content}
                                    </div>
                                    {/* Issue link for create_issue mode */}
                                    {msg.role === "assistant" && msg.issueUrl && (
                                        <a
                                            href={msg.issueUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors mt-1"
                                        >
                                            <ExternalLink className="h-3 w-3" />
                                            View Issue #{msg.issueNumber} on GitHub
                                        </a>
                                    )}
                                </div>
                                {msg.role === "user" && (
                                    <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-primary/10 border border-primary/20 h-fit">
                                        <User className="h-3.5 w-3.5 text-primary" />
                                    </div>
                                )}
                            </div>
                        ))}
                    </>
                )}
                {loading && (
                    <div className="flex gap-2.5">
                        <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 h-fit">
                            <Bot className="h-3.5 w-3.5 text-emerald-400" />
                        </div>
                        <div className="bg-muted/60 border border-border/50 rounded-xl rounded-bl-sm px-4 py-3">
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                    </div>
                )}
                <div ref={bottomRef} />
            </div>

            {/* Cluster selector */}
            {clusterTitles.length > 0 && (
                <div className="shrink-0 border-t border-border/30">
                    <button
                        onClick={() => setClusterSelectorOpen((prev) => !prev)}
                        className="w-full flex items-center justify-between px-4 py-2 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                        <span className="font-medium">
                            {selectedClusters.length > 0
                                ? `${selectedClusters.length} cluster${selectedClusters.length > 1 ? "s" : ""} referenced`
                                : "Reference clusters (optional)"}
                        </span>
                        <ChevronDown className={`h-3 w-3 transition-transform ${clusterSelectorOpen ? "rotate-180" : ""}`} />
                    </button>
                    {clusterSelectorOpen && (
                        <div className="px-3 pb-2 space-y-1 max-h-[140px] overflow-y-auto">
                            {clusterTitles.map((title) => {
                                const isSelected = selectedClusters.includes(title);
                                return (
                                    <button
                                        key={title}
                                        onClick={() => toggleCluster(title)}
                                        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors cursor-pointer ${
                                            isSelected
                                                ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                                                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground border border-transparent"
                                        }`}
                                    >
                                        <div className={`shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                                            isSelected ? "bg-emerald-500/20 border-emerald-500/40" : "border-border/50"
                                        }`}>
                                            {isSelected && <Check className="h-2.5 w-2.5" />}
                                        </div>
                                        <span className="truncate">{title}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Input area */}
            <div className="shrink-0 border-t border-border/50 p-3">
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                        placeholder="Ask about the report..."
                        disabled={loading}
                        className="flex-1 bg-muted/40 border border-border/50 rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                    />
                    <Button
                        size="sm"
                        onClick={() => sendMessage()}
                        disabled={!input.trim() || loading}
                        className="h-9 w-9 p-0 shrink-0"
                    >
                        <Send className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

/* ─── Main Page ────────────────────────────────────────────────────────────── */

export default function ProjectPage() {
    const params = useParams();
    const router = useRouter();
    const id = params.id as string;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repository, setRepository] = useState<Repository | null>(null);
    const [view, setView] = useState<"overview" | "clusters" | "risks">("overview");

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const res = await fetch(`/api/reports/${id}`);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            const data = await res.json();
            setRepository(data.repository);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Unknown error");
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        if (id) fetchData();
    }, [id, fetchData]);

    const birdsEye = useMemo(
        () => (repository?.compiledReport ? parseBirdsEye(repository.compiledReport) : null),
        [repository?.compiledReport],
    );

    const revenueRisk = useMemo(
        () => (repository?.compiledReport ? parseRevenueRisk(repository.compiledReport) : null),
        [repository?.compiledReport],
    );

    /* Loading */
    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">Loading project...</p>
                </div>
            </div>
        );
    }

    /* Error */
    if (error || !repository) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="text-center space-y-4">
                    <XCircle className="h-12 w-12 text-red-400 mx-auto" />
                    <h2 className="text-xl font-semibold">Failed to load project</h2>
                    <p className="text-sm text-muted-foreground">{error}</p>
                    <button onClick={() => router.back()} className="text-sm text-muted-foreground hover:text-foreground underline">
                        Go back
                    </button>
                </div>
            </div>
        );
    }

    const hasReport = !!repository.compiledReport;

    return (
        <div className="h-screen flex flex-col bg-background overflow-hidden">
            {/* ── Header ──────────────────────────────────────────── */}
            <header className="shrink-0 bg-background/60 backdrop-blur-xl border-b border-white/6 z-50">
                <div className="max-w-[1920px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {view !== "overview" ? (
                            <button
                                onClick={() => setView(view === "risks" ? "clusters" : "overview")}
                                className="p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </button>
                        ) : (
                            <Link href="/" className="p-2 -ml-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                                <ArrowLeft className="h-4 w-4" />
                            </Link>
                        )}
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
                                {repository.compiledReportAt && (
                                    <span className="text-[10px] text-muted-foreground">
                                        Report compiled {new Date(repository.compiledReportAt).toLocaleDateString("en-US", {
                                            month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
                                        })}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link href={`/reports/${id}`}>
                            <Button variant="outline" size="sm" className="text-xs gap-1.5">
                                <FileText className="h-3.5 w-3.5" />
                                Raw Reports
                            </Button>
                        </Link>
                    </div>
                </div>
            </header>

            {/* ── Body ─────────────────────────────────────────────── */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
                {/* Left: Chat Panel */}
                {hasReport && (
                    <div className="w-[380px] shrink-0 border-r border-white/6 bg-white/2 backdrop-blur-sm flex flex-col min-h-0">
                        <ChatPanel repositoryId={id} clusterTitles={parseClusters(repository.compiledReport!).map((c) => c.title)} />
                    </div>
                )}

                {/* Right: Content */}
                <div className="flex-1 overflow-y-auto min-w-0">
                    {hasReport ? (
                        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-8">
                            {view === "overview" && birdsEye ? (
                                <BirdsEyeView
                                    birdsEye={birdsEye}
                                    archetypes={repository.archetypes}
                                    onViewClusters={() => setView("clusters")}
                                />
                            ) : view === "clusters" ? (
                                <>
                                    {/* Left arrow — fixed to left edge of report panel */}
                                    <button
                                        onClick={() => setView("overview")}
                                        className="fixed left-[420px] top-1/2 -translate-y-1/2 z-40 cursor-pointer hover:scale-110 transition-transform"
                                        title="Back to Overview"
                                    >
                                        <span className="text-3xl font-light text-violet-400 animate-pulse-glow">&lt;</span>
                                    </button>

                                    {/* Right arrow — fixed to right edge of report panel */}
                                    {revenueRisk && (
                                        <button
                                            onClick={() => setView("risks")}
                                            className="fixed right-10 top-1/2 -translate-y-1/2 z-40 cursor-pointer hover:scale-110 transition-transform"
                                            title="Revenue Risk Assessment"
                                        >
                                            <span className="text-3xl font-light text-violet-400 animate-pulse-glow">&gt;</span>
                                        </button>
                                    )}

                                    {/* Content */}
                                    <div className="space-y-6">
                                        {/* Header */}
                                        <div>
                                            <h2 className="text-2xl font-bold tracking-tight">Scale Issues</h2>
                                            <p className="text-sm text-muted-foreground mt-1">Identified bottlenecks grouped by business impact. Click to expand.</p>
                                        </div>

                                        {(() => {
                                            const allClusters = parseClusters(repository.compiledReport!);
                                            const top3 = allClusters.slice(0, 3);
                                            const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
                                            const rest = allClusters.slice(3).sort(
                                                (a, b) => (sevOrder[a.severity.toLowerCase()] ?? 3) - (sevOrder[b.severity.toLowerCase()] ?? 3)
                                            );
                                            return (
                                                <div className="space-y-3">
                                                    {/* Top 3 heading */}
                                                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top 3 Scale Issues</p>
                                                    <ClustersView clusters={top3} />

                                                    {rest.length > 0 && (
                                                        <>
                                                            {/* Thin divider */}
                                                            <div className="border-t border-white/15 my-4" />
                                                            <ClustersView clusters={rest} />
                                                        </>
                                                    )}
                                                </div>
                                            );
                                        })()}
                                    </div>
                                </>
                            ) : (
                                /* Revenue Risk Assessment view */
                                <>
                                    {/* Left arrow — fixed, back to Scale Issues */}
                                    <button
                                        onClick={() => setView("clusters")}
                                        className="fixed left-[420px] top-1/2 -translate-y-1/2 z-40 cursor-pointer hover:scale-110 transition-transform"
                                        title="Back to Scale Issues"
                                    >
                                        <span className="text-3xl font-light text-violet-400 animate-pulse-glow">&lt;</span>
                                    </button>

                                    <div className="space-y-5">
                                        <div>
                                            <h2 className="text-2xl font-bold tracking-tight">Revenue Risk Assessment</h2>
                                            <p className="text-sm text-muted-foreground mt-1">How scalability risks translate to business impact.</p>
                                        </div>
                                        {revenueRisk && <RevenueRiskView revenueRisk={revenueRisk} />}
                                    </div>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
                            <FileText className="h-16 w-16 text-muted-foreground/30" />
                            <div>
                                <h2 className="text-lg font-semibold">No Compiled Report Yet</h2>
                                <p className="text-sm text-muted-foreground mt-1 max-w-md">
                                    Run the analysis pipeline or compile the report from the dashboard to generate the founder-optimized scalability report.
                                </p>
                            </div>
                            <Link href="/">
                                <Button variant="outline">Go to Dashboard</Button>
                            </Link>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
