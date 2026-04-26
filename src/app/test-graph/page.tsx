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

interface GraphStats {
    nodes: number;
    edges: number;
    flows: number;
    nodesByKind: Record<string, number>;
    edgesByKind: Record<string, number>;
    languages?: string[];
}

interface NodeRow {
    id: string;
    kind: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    lineStart: number | null;
    lineEnd: number | null;
    language: string | null;
    parentName: string | null;
    params: string | null;
    returnType: string | null;
}

interface EdgeRow {
    id: string;
    kind: string;
    sourceQualified: string;
    targetQualified: string;
    filePath: string;
    line: number;
}

interface FlowRow {
    id: string;
    name: string;
    entryPointQn: string;
    depth: number;
    nodeCount: number;
    fileCount: number;
    criticality: number;
    pathJson: string[];
    filesJson: string[];
}

interface ChainStep {
    name: string;
    qualifiedName: string;
    file: string;
    depth: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">
            {children}
        </p>
    );
}

function Card({
    children,
    className = "",
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={`bg-gray-900 border border-white/10 rounded-xl p-5 ${className}`}
        >
            {children}
        </div>
    );
}

function KindBadge({ kind }: { kind: string }) {
    const colors: Record<string, string> = {
        File: "bg-blue-500/20 text-blue-400 border-blue-500/30",
        Class: "bg-violet-500/20 text-violet-400 border-violet-500/30",
        Function: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
        CALLS: "bg-orange-500/20 text-orange-400 border-orange-500/30",
        IMPORTS_FROM: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
        INHERITS: "bg-pink-500/20 text-pink-400 border-pink-500/30",
        CONTAINS: "bg-gray-500/20 text-gray-400 border-gray-500/30",
    };
    return (
        <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${
                colors[kind] ??
                "bg-gray-500/20 text-gray-400 border-gray-500/30"
            }`}
        >
            {kind}
        </span>
    );
}

function CriticalityBar({ value }: { value: number }) {
    const pct = Math.round(value * 100);
    const color =
        pct >= 70
            ? "bg-red-500"
            : pct >= 40
            ? "bg-orange-500"
            : pct >= 20
            ? "bg-amber-500"
            : "bg-emerald-500";
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                    className={`h-full ${color} rounded-full transition-all`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className="text-xs font-mono text-gray-400 w-10 text-right">
                {pct}%
            </span>
        </div>
    );
}

function Spinner() {
    return (
        <svg
            className="w-4 h-4 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
        >
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
    );
}

function basename(path: string) {
    return path.split("/").pop() ?? path;
}

// ─── Project Architecture Diagram ─────────────────────────────────────────────

interface FileGraphNode {
    path: string;
    functionCount: number;
    functions: string[];
    language: string | null;
}

interface FileGraphEdge {
    source: string;
    target: string;
    calls: number;
    imports: number;
}

interface FileGraphData {
    files: FileGraphNode[];
    fileEdges: FileGraphEdge[];
    totalFiles: number;
    totalFileEdges: number;
}

const DIR_COLORS: Record<string, string> = {
    "app": "#3b82f6",
    "components": "#8b5cf6",
    "lib": "#06b6d4",
    "hooks": "#ec4899",
    "contexts": "#f59e0b",
    "utils": "#14b8a6",
    "services": "#f97316",
    "api": "#ef4444",
    "styles": "#a855f7",
    "types": "#6366f1",
    "store": "#84cc16",
    "actions": "#22d3ee",
};

function getDirColor(dirLabel: string): string {
    const lower = dirLabel.toLowerCase();
    for (const [key, color] of Object.entries(DIR_COLORS)) {
        if (lower.includes(key)) return color;
    }
    // Hash fallback
    const palette = ["#3b82f6", "#8b5cf6", "#06b6d4", "#ec4899", "#14b8a6", "#f59e0b", "#ef4444", "#a855f7"];
    const hash = lower.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return palette[hash % palette.length];
}

function ProjectArchitectureDiagram({
    repositoryId,
}: {
    repositoryId: string;
}) {
    const [data, setData] = useState<FileGraphData | null>(null);
    const [loading, setLoading] = useState(true);
    const [hoveredFile, setHoveredFile] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);

    useEffect(() => {
        async function load() {
            setLoading(true);
            try {
                const res = await fetch(
                    `/api/agent/graph-test?repositoryId=${repositoryId}&view=file-graph`
                );
                const json = await res.json();
                setData(json);
            } catch {
                setData(null);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [repositoryId]);

    if (loading) {
        return (
            <Card className="text-center py-16">
                <div className="flex items-center justify-center gap-3 text-gray-400">
                    <Spinner /> Loading project architecture…
                </div>
            </Card>
        );
    }

    if (!data || data.files.length === 0) {
        return (
            <Card className="text-center py-16">
                <p className="text-gray-500">
                    No graph data found. Build the knowledge graph first.
                </p>
            </Card>
        );
    }

    // ── Group files by directory ──
    const dirGroups = new Map<string, FileGraphNode[]>();
    for (const file of data.files) {
        const parts = file.path.split("/");
        // Use first 2 meaningful parts for grouping
        let dirKey: string;
        if (parts.length <= 1) {
            dirKey = "root";
        } else if (parts[0] === "src" && parts.length > 2) {
            dirKey = `${parts[0]}/${parts[1]}`;
        } else {
            dirKey = parts[0];
        }
        if (!dirGroups.has(dirKey)) dirGroups.set(dirKey, []);
        dirGroups.get(dirKey)!.push(file);
    }

    // Sort groups by size descending, and files within by function count
    const sortedGroups = Array.from(dirGroups.entries())
        .sort((a, b) => b[1].length - a[1].length);
    for (const [, files] of sortedGroups) {
        files.sort((a, b) => b.functionCount - a.functionCount);
    }

    // ── Layout calculation ──
    const colWidth = 200;
    const nodeH = 32;
    const nodeGap = 6;
    const colGap = 60;
    const headerH = 36;
    const padTop = 60;
    const padX = 40;
    const padBot = 50;

    // Position each file
    const filePositions = new Map<string, { x: number; y: number; w: number; h: number; color: string; group: string }>();
    let colX = padX;
    let maxColHeight = 0;

    for (const [dirLabel, files] of sortedGroups) {
        const color = getDirColor(dirLabel);
        let yOff = padTop + headerH + 10;

        for (const file of files) {
            const h = nodeH;
            filePositions.set(file.path, {
                x: colX,
                y: yOff,
                w: colWidth,
                h: h,
                color,
                group: dirLabel,
            });
            yOff += h + nodeGap;
        }
        if (yOff > maxColHeight) maxColHeight = yOff;
        colX += colWidth + colGap;
    }

    const totalW = colX - colGap + padX;
    const totalH = maxColHeight + padBot;

    // ── Build connection sets for hover highlight ──
    const connectedTo = new Map<string, Set<string>>();
    for (const e of data.fileEdges) {
        if (!connectedTo.has(e.source)) connectedTo.set(e.source, new Set());
        if (!connectedTo.has(e.target)) connectedTo.set(e.target, new Set());
        connectedTo.get(e.source)!.add(e.target);
        connectedTo.get(e.target)!.add(e.source);
    }

    const activeFile = selectedFile ?? hoveredFile;
    const connectedFiles = activeFile ? connectedTo.get(activeFile) ?? new Set<string>() : new Set<string>();

    // ── File detail panel ──
    const detailFile = selectedFile
        ? data.files.find(f => f.path === selectedFile)
        : null;
    const detailEdgesOut = selectedFile
        ? data.fileEdges.filter(e => e.source === selectedFile)
        : [];
    const detailEdgesIn = selectedFile
        ? data.fileEdges.filter(e => e.target === selectedFile)
        : [];

    return (
        <div className="space-y-4">
            {/* Summary header */}
            <Card>
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-sm font-semibold text-gray-200">
                            Project Architecture
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">
                            {data.totalFiles} files · {data.totalFileEdges} connections · {sortedGroups.length} directories
                        </p>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] text-gray-500">
                        {sortedGroups.slice(0, 6).map(([dir]) => (
                            <div key={dir} className="flex items-center gap-1.5">
                                <div
                                    className="w-2.5 h-2.5 rounded-sm"
                                    style={{ backgroundColor: getDirColor(dir) }}
                                />
                                {dir}
                            </div>
                        ))}
                    </div>
                </div>
                {selectedFile && (
                    <button
                        className="mt-2 text-xs text-teal-400 hover:text-teal-300 transition-colors"
                        onClick={() => setSelectedFile(null)}
                    >
                        ← Clear selection
                    </button>
                )}
            </Card>

            {/* SVG Canvas */}
            <Card className="!p-0 overflow-x-auto">
                <div style={{ minHeight: 400 }}>
                    <svg
                        width={totalW}
                        height={totalH}
                        viewBox={`0 0 ${totalW} ${totalH}`}
                        className="select-none"
                    >
                        <defs>
                            <marker
                                id="arch-arrow"
                                viewBox="0 0 10 7"
                                refX="10"
                                refY="3.5"
                                markerWidth="6"
                                markerHeight="5"
                                orient="auto"
                            >
                                <polygon points="0 0, 10 3.5, 0 7" fill="#6b7280" fillOpacity={0.5} />
                            </marker>
                            <marker
                                id="arch-arrow-active"
                                viewBox="0 0 10 7"
                                refX="10"
                                refY="3.5"
                                markerWidth="7"
                                markerHeight="6"
                                orient="auto"
                            >
                                <polygon points="0 0, 10 3.5, 0 7" fill="#14b8a6" fillOpacity={0.9} />
                            </marker>
                            <filter id="arch-glow">
                                <feGaussianBlur stdDeviation="4" result="blur" />
                                <feMerge>
                                    <feMergeNode in="blur" />
                                    <feMergeNode in="SourceGraphic" />
                                </feMerge>
                            </filter>
                        </defs>

                        {/* Title */}
                        <text x={totalW / 2} y={28} textAnchor="middle" fill="#6b7280" fontFamily="monospace" fontSize={12}>
                            Project File Dependency Graph
                        </text>
                        <text x={totalW / 2} y={44} textAnchor="middle" fill="#4b5563" fontFamily="monospace" fontSize={10}>
                            Hover to highlight connections · Click to inspect
                        </text>

                        {/* Column headers */}
                        {(() => {
                            let cx = padX;
                            return sortedGroups.map(([dirLabel, files]) => {
                                const x = cx;
                                cx += colWidth + colGap;
                                const color = getDirColor(dirLabel);
                                return (
                                    <g key={`hdr-${dirLabel}`}>
                                        <rect
                                            x={x}
                                            y={padTop}
                                            width={colWidth}
                                            height={headerH}
                                            rx={8}
                                            fill={`${color}15`}
                                            stroke={`${color}30`}
                                            strokeWidth={1}
                                        />
                                        <text
                                            x={x + 10}
                                            y={padTop + 16}
                                            fill={color}
                                            fontSize={11}
                                            fontWeight={700}
                                            fontFamily="monospace"
                                        >
                                            {dirLabel}
                                        </text>
                                        <text
                                            x={x + colWidth - 10}
                                            y={padTop + 16}
                                            textAnchor="end"
                                            fill={`${color}80`}
                                            fontSize={9}
                                            fontFamily="monospace"
                                        >
                                            {files.length} files
                                        </text>
                                        {/* Column dotted guideline */}
                                        <line
                                            x1={x + colWidth / 2}
                                            y1={padTop + headerH}
                                            x2={x + colWidth / 2}
                                            y2={totalH - padBot}
                                            stroke={`${color}10`}
                                            strokeWidth={1}
                                            strokeDasharray="3 6"
                                        />
                                    </g>
                                );
                            });
                        })()}

                        {/* Edges (drawn behind nodes) */}
                        {data.fileEdges.map((edge, idx) => {
                            const src = filePositions.get(edge.source);
                            const tgt = filePositions.get(edge.target);
                            if (!src || !tgt) return null;

                            const isActive = activeFile === edge.source || activeFile === edge.target;
                            const isDimmed = activeFile && !isActive;

                            // Curved path from right side of source to left side of target
                            const x1 = src.x + src.w;
                            const y1 = src.y + src.h / 2;
                            const x2 = tgt.x;
                            const y2 = tgt.y + tgt.h / 2;

                            // If same column, route differently
                            const sameCol = src.group === tgt.group;
                            let pathD: string;
                            if (sameCol) {
                                // Same column — arc to the right
                                const arcX = src.x + src.w + 25;
                                pathD = `M ${x1} ${y1} C ${arcX} ${y1}, ${arcX} ${y2}, ${x1} ${y2}`;
                            } else if (x1 < x2) {
                                // Source is left of target
                                const cpx = (x1 + x2) / 2;
                                pathD = `M ${x1} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${x2} ${y2}`;
                            } else {
                                // Source is right of target — go from left side
                                const sx = src.x;
                                const tx = tgt.x + tgt.w;
                                const cpx = (sx + tx) / 2 - 40;
                                pathD = `M ${sx} ${y1} C ${cpx} ${y1}, ${cpx} ${y2}, ${tx} ${y2}`;
                            }

                            return (
                                <path
                                    key={`edge-${idx}`}
                                    d={pathD}
                                    fill="none"
                                    stroke={isActive ? "#14b8a6" : "#4b556320"}
                                    strokeWidth={isActive ? (edge.calls > 3 ? 2.5 : 1.8) : (edge.calls > 3 ? 1.2 : 0.7)}
                                    markerEnd={isActive ? "url(#arch-arrow-active)" : "url(#arch-arrow)"}
                                    opacity={isDimmed ? 0.06 : isActive ? 0.9 : 0.2}
                                    style={{ transition: "all 0.25s ease" }}
                                />
                            );
                        })}

                        {/* File Nodes */}
                        {data.files.map((file) => {
                            const pos = filePositions.get(file.path);
                            if (!pos) return null;

                            const isHovered = activeFile === file.path;
                            const isConnected = connectedFiles.has(file.path);
                            const isDimmed = activeFile && !isHovered && !isConnected;
                            const fname = basename(file.path);

                            // Function count badge width
                            const badgeW = file.functionCount > 0 ? (String(file.functionCount).length * 7 + 14) : 0;

                            return (
                                <g
                                    key={`file-${file.path}`}
                                    onMouseEnter={() => setHoveredFile(file.path)}
                                    onMouseLeave={() => setHoveredFile(null)}
                                    onClick={() => setSelectedFile(file.path === selectedFile ? null : file.path)}
                                    style={{ cursor: "pointer" }}
                                >
                                    {/* Glow on hover */}
                                    {isHovered && (
                                        <rect
                                            x={pos.x - 2}
                                            y={pos.y - 2}
                                            width={pos.w + 4}
                                            height={pos.h + 4}
                                            rx={10}
                                            fill="none"
                                            stroke={pos.color}
                                            strokeWidth={1.5}
                                            opacity={0.5}
                                            filter="url(#arch-glow)"
                                        />
                                    )}

                                    {/* Box */}
                                    <rect
                                        x={pos.x}
                                        y={pos.y}
                                        width={pos.w}
                                        height={pos.h}
                                        rx={8}
                                        fill={isHovered ? `${pos.color}18` : isConnected ? `${pos.color}0a` : "rgba(255,255,255,0.015)"}
                                        stroke={isHovered ? pos.color : isConnected ? `${pos.color}50` : "rgba(255,255,255,0.06)"}
                                        strokeWidth={isHovered ? 1.5 : 1}
                                        opacity={isDimmed ? 0.2 : 1}
                                        style={{ transition: "all 0.2s ease" }}
                                    />

                                    {/* Filename */}
                                    <text
                                        x={pos.x + 10}
                                        y={pos.y + pos.h / 2 + 4}
                                        fill={isHovered ? "#f3f4f6" : isDimmed ? "#4b5563" : "#d1d5db"}
                                        fontSize={10}
                                        fontFamily="monospace"
                                        fontWeight={isHovered ? 600 : 400}
                                        style={{ transition: "all 0.2s ease" }}
                                    >
                                        {fname.length > 22 ? fname.slice(0, 22) + "…" : fname}
                                    </text>

                                    {/* Function count badge */}
                                    {file.functionCount > 0 && (
                                        <>
                                            <rect
                                                x={pos.x + pos.w - badgeW - 6}
                                                y={pos.y + (pos.h - 18) / 2}
                                                width={badgeW}
                                                height={18}
                                                rx={9}
                                                fill={`${pos.color}20`}
                                                stroke={`${pos.color}30`}
                                                strokeWidth={0.5}
                                                opacity={isDimmed ? 0.2 : 1}
                                            />
                                            <text
                                                x={pos.x + pos.w - badgeW / 2 - 6}
                                                y={pos.y + pos.h / 2 + 4}
                                                textAnchor="middle"
                                                fill={pos.color}
                                                fontSize={9}
                                                fontWeight={700}
                                                fontFamily="monospace"
                                                opacity={isDimmed ? 0.2 : 1}
                                            >
                                                {file.functionCount}fn
                                            </text>
                                        </>
                                    )}
                                </g>
                            );
                        })}
                    </svg>
                </div>
            </Card>

            {/* Detail panel when a file is selected */}
            {detailFile && (
                <Card>
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <div
                                className="w-3 h-3 rounded-sm"
                                style={{ backgroundColor: filePositions.get(detailFile.path)?.color ?? "#6b7280" }}
                            />
                            <h3 className="text-sm font-semibold text-gray-200 font-mono">
                                {detailFile.path}
                            </h3>
                        </div>
                        <span className="text-xs text-gray-500">
                            {detailFile.functionCount} functions · {detailFile.language ?? "unknown"}
                        </span>
                    </div>

                    {detailFile.functions.length > 0 && (
                        <div className="mb-3">
                            <Label>Functions</Label>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                                {detailFile.functions.map(fn => (
                                    <span
                                        key={fn}
                                        className="px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-400 text-xs font-mono border border-emerald-500/20"
                                    >
                                        {fn}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-4">
                        {detailEdgesOut.length > 0 && (
                            <div>
                                <Label>Calls / Imports ({detailEdgesOut.length} files)</Label>
                                <div className="space-y-1 mt-1 max-h-40 overflow-y-auto">
                                    {detailEdgesOut.map((e, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs">
                                            <span className="text-teal-400">→</span>
                                            <span className="font-mono text-gray-300 truncate">
                                                {basename(e.target)}
                                            </span>
                                            {e.calls > 0 && (
                                                <span className="text-orange-400/70">{e.calls} calls</span>
                                            )}
                                            {e.imports > 0 && (
                                                <span className="text-cyan-400/70">{e.imports} imports</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {detailEdgesIn.length > 0 && (
                            <div>
                                <Label>Called / Imported by ({detailEdgesIn.length} files)</Label>
                                <div className="space-y-1 mt-1 max-h-40 overflow-y-auto">
                                    {detailEdgesIn.map((e, i) => (
                                        <div key={i} className="flex items-center gap-2 text-xs">
                                            <span className="text-pink-400">←</span>
                                            <span className="font-mono text-gray-300 truncate">
                                                {basename(e.source)}
                                            </span>
                                            {e.calls > 0 && (
                                                <span className="text-orange-400/70">{e.calls} calls</span>
                                            )}
                                            {e.imports > 0 && (
                                                <span className="text-cyan-400/70">{e.imports} imports</span>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </Card>
            )}
        </div>
    );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type TabKey = "stats" | "nodes" | "edges" | "flows" | "diagram" | "callchain";

export default function TestGraphPage() {
    // ── Repo selection ──
    const [repos, setRepos] = useState<RepoRecord[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [reposError, setReposError] = useState<string | null>(null);
    const [selectedRepoId, setSelectedRepoId] = useState<string>("");

    // ── Build state ──
    const [building, setBuilding] = useState(false);
    const [buildResult, setBuildResult] = useState<{
        success: boolean;
        executionTimeMs: number;
        stats: GraphStats;
    } | null>(null);
    const [buildError, setBuildError] = useState<string | null>(null);

    // ── View state ──
    const [activeTab, setActiveTab] = useState<TabKey>("stats");
    const [graphStats, setGraphStats] = useState<{
        graphStatus: string | null;
        graphBuiltAt: string | null;
        stats: GraphStats;
    } | null>(null);
    const [loadingStats, setLoadingStats] = useState(false);

    // ── Data explorers ──
    const [nodes, setNodes] = useState<NodeRow[]>([]);
    const [loadingNodes, setLoadingNodes] = useState(false);
    const [nodeKindFilter, setNodeKindFilter] = useState<string>("");
    const [nodeSearch, setNodeSearch] = useState<string>("");

    const [edges, setEdges] = useState<EdgeRow[]>([]);
    const [loadingEdges, setLoadingEdges] = useState(false);
    const [edgeKindFilter, setEdgeKindFilter] = useState<string>("");

    const [flows, setFlows] = useState<FlowRow[]>([]);
    const [loadingFlows, setLoadingFlows] = useState(false);
    const [expandedFlow, setExpandedFlow] = useState<string | null>(null);

    const [chainQuery, setChainQuery] = useState<string>("");
    const [chain, setChain] = useState<ChainStep[]>([]);
    const [chainEntry, setChainEntry] = useState<string>("");
    const [loadingChain, setLoadingChain] = useState(false);

    // ── Load repositories ──
    useEffect(() => {
        async function load() {
            try {
                const res = await fetch("/api/agent/repositories");
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? "Failed to load");
                setRepos(data.repositories ?? []);
            } catch (e) {
                setReposError(
                    e instanceof Error ? e.message : "Unknown error"
                );
            } finally {
                setLoadingRepos(false);
            }
        }
        load();
    }, []);

    const selectedRepo =
        repos.find((r) => r.id === selectedRepoId) ?? null;

    // ── Auto-load stats when repo changes ──
    useEffect(() => {
        if (!selectedRepoId) return;
        loadStats();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedRepoId]);

    // ── API helpers ──
    const loadStats = useCallback(async () => {
        if (!selectedRepoId) return;
        setLoadingStats(true);
        try {
            const res = await fetch(
                `/api/agent/graph-test?repositoryId=${selectedRepoId}&view=stats`
            );
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            setGraphStats(data);
        } catch {
            setGraphStats(null);
        } finally {
            setLoadingStats(false);
        }
    }, [selectedRepoId]);

    const buildGraph = useCallback(async () => {
        if (!selectedRepoId) return;
        setBuilding(true);
        setBuildError(null);
        setBuildResult(null);
        try {
            const res = await fetch("/api/agent/graph-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repositoryId: selectedRepoId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Build failed");
            setBuildResult(data);
            loadStats();
        } catch (e) {
            setBuildError(
                e instanceof Error ? e.message : "Unknown error"
            );
        } finally {
            setBuilding(false);
        }
    }, [selectedRepoId, loadStats]);

    const loadNodes = useCallback(async () => {
        if (!selectedRepoId) return;
        setLoadingNodes(true);
        try {
            const params = new URLSearchParams({
                repositoryId: selectedRepoId,
                view: "nodes",
                limit: "200",
            });
            if (nodeKindFilter) params.set("kind", nodeKindFilter);
            if (nodeSearch) params.set("search", nodeSearch);
            const res = await fetch(`/api/agent/graph-test?${params}`);
            const data = await res.json();
            setNodes(data.nodes ?? []);
        } catch {
            setNodes([]);
        } finally {
            setLoadingNodes(false);
        }
    }, [selectedRepoId, nodeKindFilter, nodeSearch]);

    const loadEdges = useCallback(async () => {
        if (!selectedRepoId) return;
        setLoadingEdges(true);
        try {
            const params = new URLSearchParams({
                repositoryId: selectedRepoId,
                view: "edges",
                limit: "200",
            });
            if (edgeKindFilter) params.set("kind", edgeKindFilter);
            const res = await fetch(`/api/agent/graph-test?${params}`);
            const data = await res.json();
            setEdges(data.edges ?? []);
        } catch {
            setEdges([]);
        } finally {
            setLoadingEdges(false);
        }
    }, [selectedRepoId, edgeKindFilter]);

    const loadFlows = useCallback(async () => {
        if (!selectedRepoId) return;
        setLoadingFlows(true);
        try {
            const params = new URLSearchParams({
                repositoryId: selectedRepoId,
                view: "flows",
                limit: "30",
            });
            const res = await fetch(`/api/agent/graph-test?${params}`);
            const data = await res.json();
            setFlows(data.flows ?? []);
        } catch {
            setFlows([]);
        } finally {
            setLoadingFlows(false);
        }
    }, [selectedRepoId]);

    const traceCallChain = useCallback(async () => {
        if (!selectedRepoId || !chainQuery.trim()) return;
        setLoadingChain(true);
        try {
            const params = new URLSearchParams({
                repositoryId: selectedRepoId,
                view: "callchain",
                function: chainQuery.trim(),
            });
            const res = await fetch(`/api/agent/graph-test?${params}`);
            const data = await res.json();
            setChain(data.chain ?? []);
            setChainEntry(data.entry ?? "");
        } catch {
            setChain([]);
        } finally {
            setLoadingChain(false);
        }
    }, [selectedRepoId, chainQuery]);

    // ── Auto-load tab data ──
    useEffect(() => {
        if (!selectedRepoId) return;
        if (activeTab === "nodes") loadNodes();
        if (activeTab === "edges") loadEdges();
        if (activeTab === "flows") loadFlows();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, selectedRepoId]);

    // ─── Render ───────────────────────────────────────────────────────────────

    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            {/* Header */}
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-base">
                        🧬
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">
                            Knowledge Graph Explorer
                        </h1>
                        <p className="text-xs text-gray-400">
                            Build, visualize, and query the code knowledge
                            graph for any repository
                        </p>
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
                        <span className="text-xs text-gray-400">
                            dev mode
                        </span>
                    </div>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
                {/* ── Config Panel ── */}
                <Card>
                    <h2 className="text-sm font-semibold text-gray-200 mb-4">
                        Repository Selection
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {/* Selector */}
                        <div>
                            <Label>Repository</Label>
                            {loadingRepos ? (
                                <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
                            ) : reposError ? (
                                <p className="text-red-400 text-sm">
                                    {reposError}
                                </p>
                            ) : (
                                <select
                                    id="repo-selector"
                                    className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                                    value={selectedRepoId}
                                    onChange={(e) =>
                                        setSelectedRepoId(e.target.value)
                                    }
                                >
                                    <option value="">
                                        — select a repository —
                                    </option>
                                    {repos.map((r) => (
                                        <option
                                            key={r.id}
                                            value={r.id}
                                        >
                                            {r.fullName}
                                            {r.framework
                                                ? ` (${r.framework})`
                                                : ""}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </div>

                        {/* Info */}
                        <div className="flex items-end">
                            <p className="text-xs text-gray-500">
                                Select a repository, then build the knowledge
                                graph. Once built, explore nodes, edges,
                                execution flows, and trace call chains.
                            </p>
                        </div>
                    </div>

                    {/* Selected repo info */}
                    {selectedRepo && (
                        <div className="mt-4 p-3 bg-gray-800/60 rounded-lg grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                            <div>
                                <p className="text-gray-500 mb-0.5">
                                    Internal ID
                                </p>
                                <p className="font-mono text-gray-300 truncate">
                                    {selectedRepo.id}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">
                                    Framework
                                </p>
                                <p className="text-gray-300">
                                    {selectedRepo.framework ?? "unknown"}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">
                                    Graph Status
                                </p>
                                <p
                                    className={
                                        graphStats?.graphStatus === "ready"
                                            ? "text-emerald-400"
                                            : graphStats?.graphStatus ===
                                              "building"
                                            ? "text-amber-400"
                                            : graphStats?.graphStatus ===
                                              "failed"
                                            ? "text-red-400"
                                            : "text-gray-500"
                                    }
                                >
                                    {graphStats?.graphStatus ?? "not built"}
                                </p>
                            </div>
                            <div>
                                <p className="text-gray-500 mb-0.5">
                                    Last Built
                                </p>
                                <p className="text-gray-300">
                                    {graphStats?.graphBuiltAt
                                        ? new Date(
                                              graphStats.graphBuiltAt
                                          ).toLocaleString()
                                        : "—"}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Build button */}
                    <div className="mt-5 flex items-center gap-4">
                        <button
                            id="build-graph-btn"
                            onClick={buildGraph}
                            disabled={!selectedRepoId || building}
                            className="flex items-center gap-2 px-5 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors shadow-lg shadow-teal-900/30"
                        >
                            {building ? (
                                <>
                                    <Spinner />
                                    Building Graph…
                                </>
                            ) : (
                                <>
                                    <span>⚡</span> Build Knowledge Graph
                                </>
                            )}
                        </button>
                        {building && (
                            <p className="text-xs text-gray-400 animate-pulse">
                                Parsing source files — this may take 30–60
                                seconds…
                            </p>
                        )}
                    </div>
                </Card>

                {/* ── Build Result ── */}
                {buildError && (
                    <Card className="border-red-500/30 bg-red-950/20">
                        <p className="text-sm font-semibold text-red-400 mb-1">
                            ⚠ Build Error
                        </p>
                        <pre className="text-xs text-red-300 whitespace-pre-wrap">
                            {buildError}
                        </pre>
                    </Card>
                )}

                {buildResult && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {[
                            {
                                label: "Status",
                                value: "✓ Built",
                                color: "text-emerald-400",
                            },
                            {
                                label: "Build Time",
                                value: `${(
                                    buildResult.executionTimeMs / 1000
                                ).toFixed(1)}s`,
                                color: "text-purple-400",
                            },
                            {
                                label: "Total Nodes",
                                value: buildResult.stats.nodes.toLocaleString(),
                                color: "text-teal-400",
                            },
                            {
                                label: "Total Edges",
                                value: buildResult.stats.edges.toLocaleString(),
                                color: "text-cyan-400",
                            },
                        ].map((s) => (
                            <Card key={s.label} className="!p-4">
                                <p className="text-xs text-gray-500">
                                    {s.label}
                                </p>
                                <p
                                    className={`text-xl font-bold mt-1 ${s.color}`}
                                >
                                    {s.value}
                                </p>
                            </Card>
                        ))}
                    </div>
                )}

                {/* ── Tabs ── */}
                {selectedRepoId &&
                    graphStats && (
                        <div>
                            <div className="flex gap-1 mb-4 overflow-x-auto">
                                {(
                                    [
                                        {
                                            key: "stats" as TabKey,
                                            label: "📊 Overview",
                                        },
                                        {
                                            key: "nodes" as TabKey,
                                            label: `🔵 Nodes (${graphStats.stats.nodes})`,
                                        },
                                        {
                                            key: "edges" as TabKey,
                                            label: `🔗 Edges (${graphStats.stats.edges})`,
                                        },
                                        {
                                            key: "flows" as TabKey,
                                            label: `🔥 Flows (${graphStats.stats.flows})`,
                                        },
                                        {
                                            key: "diagram" as TabKey,
                                            label: "🗺️ Flow Diagram",
                                        },
                                        {
                                            key: "callchain" as TabKey,
                                            label: "🔍 Call Chain",
                                        },
                                    ] as const
                                ).map((tab) => (
                                    <button
                                        key={tab.key}
                                        onClick={() =>
                                            setActiveTab(tab.key)
                                        }
                                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                                            activeTab === tab.key
                                                ? "bg-teal-600 text-white"
                                                : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                                        }`}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>

                            {/* ── Stats Tab ── */}
                            {activeTab === "stats" && (
                                <div className="space-y-4">
                                    {loadingStats ? (
                                        <Card className="text-center py-10">
                                            <Spinner />
                                        </Card>
                                    ) : (
                                        <>
                                            {/* Big numbers */}
                                            <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                                                {[
                                                    {
                                                        label: "Files",
                                                        value:
                                                            graphStats.stats
                                                                .nodesByKind[
                                                                "File"
                                                            ] ?? 0,
                                                        color: "text-blue-400",
                                                    },
                                                    {
                                                        label: "Classes",
                                                        value:
                                                            graphStats.stats
                                                                .nodesByKind[
                                                                "Class"
                                                            ] ?? 0,
                                                        color: "text-violet-400",
                                                    },
                                                    {
                                                        label: "Functions",
                                                        value:
                                                            graphStats.stats
                                                                .nodesByKind[
                                                                "Function"
                                                            ] ?? 0,
                                                        color: "text-emerald-400",
                                                    },
                                                    {
                                                        label: "CALLS",
                                                        value:
                                                            graphStats.stats
                                                                .edgesByKind[
                                                                "CALLS"
                                                            ] ?? 0,
                                                        color: "text-orange-400",
                                                    },
                                                    {
                                                        label: "IMPORTS",
                                                        value:
                                                            graphStats.stats
                                                                .edgesByKind[
                                                                "IMPORTS_FROM"
                                                            ] ?? 0,
                                                        color: "text-cyan-400",
                                                    },
                                                    {
                                                        label: "Flows",
                                                        value:
                                                            graphStats.stats
                                                                .flows,
                                                        color: "text-pink-400",
                                                    },
                                                ].map((s) => (
                                                    <div
                                                        key={s.label}
                                                        className="bg-gray-800/60 border border-white/5 rounded-lg p-3 text-center"
                                                    >
                                                        <p
                                                            className={`text-2xl font-bold ${s.color}`}
                                                        >
                                                            {s.value}
                                                        </p>
                                                        <p className="text-xs text-gray-500">
                                                            {s.label}
                                                        </p>
                                                    </div>
                                                ))}
                                            </div>

                                            {/* Languages */}
                                            {graphStats.stats.languages &&
                                                graphStats.stats.languages
                                                    .length > 0 && (
                                                    <Card>
                                                        <Label>
                                                            Languages Detected
                                                        </Label>
                                                        <div className="flex gap-2 mt-1">
                                                            {graphStats.stats.languages.map(
                                                                (l) => (
                                                                    <span
                                                                        key={l}
                                                                        className="px-3 py-1 rounded-full bg-gray-800 text-sm text-gray-300 border border-white/10"
                                                                    >
                                                                        {l}
                                                                    </span>
                                                                )
                                                            )}
                                                        </div>
                                                    </Card>
                                                )}
                                        </>
                                    )}
                                </div>
                            )}

                            {/* ── Nodes Tab ── */}
                            {activeTab === "nodes" && (
                                <div className="space-y-4">
                                    {/* Filters */}
                                    <div className="flex gap-3 flex-wrap">
                                        <select
                                            className="bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                                            value={nodeKindFilter}
                                            onChange={(e) => {
                                                setNodeKindFilter(
                                                    e.target.value
                                                );
                                            }}
                                        >
                                            <option value="">All kinds</option>
                                            <option value="File">File</option>
                                            <option value="Class">
                                                Class
                                            </option>
                                            <option value="Function">
                                                Function
                                            </option>
                                        </select>
                                        <input
                                            type="text"
                                            placeholder="Search by name…"
                                            className="flex-1 min-w-[200px] bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                                            value={nodeSearch}
                                            onChange={(e) =>
                                                setNodeSearch(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                    loadNodes();
                                            }}
                                        />
                                        <button
                                            onClick={loadNodes}
                                            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-white/10 rounded-lg text-sm text-gray-200 transition-colors"
                                        >
                                            Search
                                        </button>
                                    </div>

                                    {/* Table */}
                                    <Card className="!p-0 overflow-x-auto">
                                        {loadingNodes ? (
                                            <div className="flex justify-center py-10">
                                                <Spinner />
                                            </div>
                                        ) : (
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-left text-xs text-gray-500 border-b border-white/5">
                                                        <th className="px-4 py-3">
                                                            Kind
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Name
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            File
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Line
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Params
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-white/5">
                                                    {nodes.map((n) => (
                                                        <tr
                                                            key={n.id}
                                                            className="hover:bg-white/[0.02]"
                                                        >
                                                            <td className="px-4 py-2.5">
                                                                <KindBadge
                                                                    kind={
                                                                        n.kind
                                                                    }
                                                                />
                                                            </td>
                                                            <td className="px-4 py-2.5 font-mono text-gray-200">
                                                                {n.name}
                                                                {n.parentName && (
                                                                    <span className="text-gray-500 text-xs ml-1">
                                                                        (
                                                                        {
                                                                            n.parentName
                                                                        }
                                                                        )
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-2.5 text-gray-400 text-xs font-mono truncate max-w-[300px]">
                                                                {basename(
                                                                    n.filePath
                                                                )}
                                                            </td>
                                                            <td className="px-4 py-2.5 text-gray-500 text-xs font-mono">
                                                                {n.lineStart ??
                                                                    "—"}
                                                            </td>
                                                            <td className="px-4 py-2.5 text-gray-500 text-xs font-mono truncate max-w-[200px]">
                                                                {n.params ??
                                                                    "—"}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                    {nodes.length === 0 && (
                                                        <tr>
                                                            <td
                                                                colSpan={5}
                                                                className="text-center text-gray-500 py-8"
                                                            >
                                                                No nodes found
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        )}
                                    </Card>
                                    <p className="text-xs text-gray-500 text-right">
                                        Showing {nodes.length} nodes (limit
                                        200)
                                    </p>
                                </div>
                            )}

                            {/* ── Edges Tab ── */}
                            {activeTab === "edges" && (
                                <div className="space-y-4">
                                    {/* Filter */}
                                    <div className="flex gap-3">
                                        <select
                                            className="bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                                            value={edgeKindFilter}
                                            onChange={(e) => {
                                                setEdgeKindFilter(
                                                    e.target.value
                                                );
                                            }}
                                        >
                                            <option value="">All kinds</option>
                                            <option value="CALLS">
                                                CALLS
                                            </option>
                                            <option value="IMPORTS_FROM">
                                                IMPORTS_FROM
                                            </option>
                                            <option value="INHERITS">
                                                INHERITS
                                            </option>
                                            <option value="CONTAINS">
                                                CONTAINS
                                            </option>
                                        </select>
                                        <button
                                            onClick={loadEdges}
                                            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-white/10 rounded-lg text-sm text-gray-200 transition-colors"
                                        >
                                            Refresh
                                        </button>
                                    </div>

                                    <Card className="!p-0 overflow-x-auto">
                                        {loadingEdges ? (
                                            <div className="flex justify-center py-10">
                                                <Spinner />
                                            </div>
                                        ) : (
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-left text-xs text-gray-500 border-b border-white/5">
                                                        <th className="px-4 py-3">
                                                            Kind
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Source
                                                        </th>
                                                        <th className="px-4 py-3 text-center">
                                                            →
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Target
                                                        </th>
                                                        <th className="px-4 py-3">
                                                            Line
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-white/5">
                                                    {edges.map((e) => (
                                                        <tr
                                                            key={e.id}
                                                            className="hover:bg-white/[0.02]"
                                                        >
                                                            <td className="px-4 py-2.5">
                                                                <KindBadge
                                                                    kind={
                                                                        e.kind
                                                                    }
                                                                />
                                                            </td>
                                                            <td className="px-4 py-2.5 font-mono text-xs text-gray-300 truncate max-w-[280px]">
                                                                {e.sourceQualified
                                                                    .split(
                                                                        "::"
                                                                    )
                                                                    .pop() ??
                                                                    e.sourceQualified}
                                                            </td>
                                                            <td className="px-4 py-2.5 text-center text-gray-600">
                                                                →
                                                            </td>
                                                            <td className="px-4 py-2.5 font-mono text-xs text-gray-300 truncate max-w-[280px]">
                                                                {e.targetQualified
                                                                    .split(
                                                                        "::"
                                                                    )
                                                                    .pop() ??
                                                                    e.targetQualified}
                                                            </td>
                                                            <td className="px-4 py-2.5 text-gray-500 text-xs font-mono">
                                                                {e.line}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                    {edges.length === 0 && (
                                                        <tr>
                                                            <td
                                                                colSpan={5}
                                                                className="text-center text-gray-500 py-8"
                                                            >
                                                                No edges found
                                                            </td>
                                                        </tr>
                                                    )}
                                                </tbody>
                                            </table>
                                        )}
                                    </Card>
                                    <p className="text-xs text-gray-500 text-right">
                                        Showing {edges.length} edges (limit
                                        200)
                                    </p>
                                </div>
                            )}

                            {/* ── Flows Tab ── */}
                            {activeTab === "flows" && (
                                <div className="space-y-3">
                                    {loadingFlows ? (
                                        <Card className="text-center py-10">
                                            <Spinner />
                                        </Card>
                                    ) : flows.length === 0 ? (
                                        <Card className="text-center py-10">
                                            <p className="text-gray-500">
                                                No flows traced yet. Build the
                                                graph first.
                                            </p>
                                        </Card>
                                    ) : (
                                        flows.map((flow) => (
                                            <div
                                                key={flow.id}
                                                className="bg-gray-900 border border-white/10 rounded-xl overflow-hidden"
                                            >
                                                <button
                                                    onClick={() =>
                                                        setExpandedFlow(
                                                            expandedFlow ===
                                                                flow.id
                                                                ? null
                                                                : flow.id
                                                        )
                                                    }
                                                    className="w-full flex items-center gap-4 px-5 py-4 text-left hover:bg-white/[0.02] transition-colors"
                                                >
                                                    <div className="flex-1 min-w-0">
                                                        <p className="text-sm font-semibold text-gray-200 truncate">
                                                            {flow.name}
                                                        </p>
                                                        <p className="text-xs text-gray-500 font-mono truncate mt-0.5">
                                                            {
                                                                flow.entryPointQn
                                                            }
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-4 shrink-0">
                                                        <div className="text-center">
                                                            <p className="text-xs text-gray-500">
                                                                Depth
                                                            </p>
                                                            <p className="text-sm font-bold text-gray-300">
                                                                {flow.depth}
                                                            </p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-xs text-gray-500">
                                                                Nodes
                                                            </p>
                                                            <p className="text-sm font-bold text-gray-300">
                                                                {
                                                                    flow.nodeCount
                                                                }
                                                            </p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="text-xs text-gray-500">
                                                                Files
                                                            </p>
                                                            <p className="text-sm font-bold text-gray-300">
                                                                {
                                                                    flow.fileCount
                                                                }
                                                            </p>
                                                        </div>
                                                        <div className="w-32">
                                                            <p className="text-xs text-gray-500 mb-0.5">
                                                                Criticality
                                                            </p>
                                                            <CriticalityBar
                                                                value={
                                                                    flow.criticality
                                                                }
                                                            />
                                                        </div>
                                                        <svg
                                                            className={`w-4 h-4 text-gray-500 transition-transform ${
                                                                expandedFlow ===
                                                                flow.id
                                                                    ? "rotate-180"
                                                                    : ""
                                                            }`}
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
                                                    </div>
                                                </button>
                                                {expandedFlow ===
                                                    flow.id && (
                                                    <div className="px-5 pb-4 border-t border-white/5 space-y-3">
                                                        <div className="mt-3">
                                                            <Label>
                                                                Call Path
                                                            </Label>
                                                            <div className="space-y-1 mt-1">
                                                                {(
                                                                    flow.pathJson as string[]
                                                                ).map(
                                                                    (
                                                                        qn,
                                                                        i
                                                                    ) => (
                                                                        <div
                                                                            key={
                                                                                i
                                                                            }
                                                                            className="flex items-center gap-2"
                                                                        >
                                                                            <span className="text-gray-600 text-xs font-mono w-6 text-right shrink-0">
                                                                                {i +
                                                                                    1}
                                                                                .
                                                                            </span>
                                                                            {i >
                                                                                0 && (
                                                                                <span className="text-gray-600 text-xs">
                                                                                    └─
                                                                                </span>
                                                                            )}
                                                                            <span className="text-xs font-mono text-gray-300 truncate">
                                                                                {qn
                                                                                    .split(
                                                                                        "::"
                                                                                    )
                                                                                    .pop() ??
                                                                                    qn}
                                                                            </span>
                                                                            <span className="text-[10px] text-gray-600 truncate">
                                                                                {basename(
                                                                                    qn.split(
                                                                                        "::"
                                                                                    )[0]
                                                                                )}
                                                                            </span>
                                                                        </div>
                                                                    )
                                                                )}
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <Label>
                                                                Files Touched
                                                            </Label>
                                                            <div className="flex flex-wrap gap-1.5 mt-1">
                                                                {(
                                                                    flow.filesJson as string[]
                                                                ).map(
                                                                    (f) => (
                                                                        <span
                                                                            key={
                                                                                f
                                                                            }
                                                                            className="px-2 py-0.5 rounded-md bg-gray-800 text-xs font-mono text-gray-400"
                                                                        >
                                                                            {basename(
                                                                                f
                                                                            )}
                                                                        </span>
                                                                    )
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))
                                    )}
                                </div>
                            )}

                            {/* ── Diagram Tab ── */}
                            {activeTab === "diagram" && (
                                <ProjectArchitectureDiagram repositoryId={selectedRepoId} />
                            )}

                            {/* ── Call Chain Tab ── */}
                            {activeTab === "callchain" && (
                                <div className="space-y-4">
                                    <Card>
                                        <Label>
                                            Trace Call Chain from Function
                                        </Label>
                                        <div className="flex gap-3 mt-1">
                                            <input
                                                type="text"
                                                placeholder="Enter function name (e.g. GET, createUser, handleSubmit)…"
                                                className="flex-1 bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/50"
                                                value={chainQuery}
                                                onChange={(e) =>
                                                    setChainQuery(
                                                        e.target.value
                                                    )
                                                }
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter")
                                                        traceCallChain();
                                                }}
                                            />
                                            <button
                                                onClick={traceCallChain}
                                                disabled={
                                                    loadingChain ||
                                                    !chainQuery.trim()
                                                }
                                                className="px-5 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold text-white transition-colors"
                                            >
                                                {loadingChain ? (
                                                    <Spinner />
                                                ) : (
                                                    "Trace"
                                                )}
                                            </button>
                                        </div>
                                    </Card>

                                    {chain.length > 0 && (
                                        <Card>
                                            <div className="flex items-center gap-2 mb-3">
                                                <Label>
                                                    Call Chain from
                                                </Label>
                                                <span className="text-xs font-mono text-teal-400">
                                                    {chainEntry
                                                        .split("::")
                                                        .pop() ??
                                                        chainEntry}
                                                </span>
                                                <span className="ml-auto text-xs text-gray-500">
                                                    {chain.length} steps
                                                </span>
                                            </div>

                                            <div className="space-y-1">
                                                {chain.map((step, i) => (
                                                    <div
                                                        key={i}
                                                        className="flex items-center gap-2"
                                                        style={{
                                                            paddingLeft: `${
                                                                step.depth *
                                                                20
                                                            }px`,
                                                        }}
                                                    >
                                                        <span
                                                            className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ${
                                                                step.depth ===
                                                                0
                                                                    ? "bg-teal-500/30 text-teal-300"
                                                                    : "bg-gray-800 text-gray-500"
                                                            }`}
                                                        >
                                                            {step.depth}
                                                        </span>
                                                        {step.depth > 0 && (
                                                            <span className="text-gray-600 text-xs">
                                                                →
                                                            </span>
                                                        )}
                                                        <span className="text-sm font-mono text-gray-200">
                                                            {step.name}
                                                        </span>
                                                        <span className="text-[10px] text-gray-600 font-mono truncate">
                                                            {basename(
                                                                step.file
                                                            )}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </Card>
                                    )}

                                    {chain.length === 0 &&
                                        !loadingChain &&
                                        chainQuery && (
                                            <Card className="text-center py-8">
                                                <p className="text-gray-500 text-sm">
                                                    No call chain found.
                                                    Try a different function
                                                    name.
                                                </p>
                                            </Card>
                                        )}
                                </div>
                            )}
                        </div>
                    )}
            </div>
        </div>
    );
}
