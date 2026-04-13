"use client";

import { useState, useEffect, useCallback } from "react";

// ─── Tool definitions (schema mirrors tools.ts) ───────────────────────────────

interface ToolParam {
    name: string;
    type: "string" | "number" | "boolean" | "enum";
    description: string;
    required: boolean;
    defaultValue?: string | number | boolean;
    enumValues?: string[];
}

interface ToolDef {
    name: string;
    description: string;
    params: ToolParam[];
    hint?: string; // suggested value for testing
}

const TOOL_DEFS: ToolDef[] = [
    {
        name: "get_graph_stats",
        description: "Get aggregate statistics about the code knowledge graph.",
        params: [],
        hint: "No args needed — good first test.",
    },
    {
        name: "get_db_heavy_functions",
        description: "Find functions that make the most database calls.",
        params: [],
        hint: "No args needed.",
    },
    {
        name: "get_critical_flows",
        description: "Get the most critical execution flows sorted by scale-risk score.",
        params: [
            { name: "limit", type: "number", description: "Max flows to return", required: false, defaultValue: 10 },
        ],
    },
    {
        name: "get_route_call_chain",
        description: "Trace the full call chain from an API route or function.",
        params: [
            { name: "routeName", type: "string", description: "Function name to trace", required: true },
        ],
        hint: "Try: GET, POST, handler, or any function name in the repo.",
    },
    {
        name: "get_function_callers",
        description: "Find all functions that call the given function.",
        params: [
            { name: "functionName", type: "string", description: "Function name to find callers for", required: true },
        ],
    },
    {
        name: "get_function_callees",
        description: "Find all functions called by the given function.",
        params: [
            { name: "functionName", type: "string", description: "Function name to find callees for", required: true },
        ],
    },
    {
        name: "get_file_summary",
        description: "Get all functions, classes, and imports in a file without reading it.",
        params: [
            { name: "filePath", type: "string", description: "Path to the file (e.g. src/app/api/agent/db-test/route.ts)", required: true },
        ],
    },
    {
        name: "query_graph",
        description: "Unified pattern query: callers_of, callees_of, imports_of, importers_of, children_of, inheritors_of, file_summary.",
        params: [
            {
                name: "pattern",
                type: "enum",
                description: "Query pattern",
                required: true,
                enumValues: ["callers_of", "callees_of", "imports_of", "importers_of", "children_of", "inheritors_of", "file_summary"],
            },
            { name: "target", type: "string", description: "Function name, qualified name, or file path", required: true },
            {
                name: "detailLevel",
                type: "enum",
                description: "standard or minimal",
                required: false,
                defaultValue: "standard",
                enumValues: ["standard", "minimal"],
            },
        ],
        hint: 'Try pattern=callers_of, target=any function name in the repo.',
    },
    {
        name: "list_flows",
        description: "List execution flows sorted by criticality.",
        params: [
            {
                name: "sortBy",
                type: "enum",
                description: "Sort field",
                required: false,
                defaultValue: "criticality",
                enumValues: ["criticality", "depth", "nodeCount"],
            },
            { name: "limit", type: "number", description: "Max flows", required: false, defaultValue: 20 },
            { name: "kind", type: "string", description: "Filter by node kind e.g. Function", required: false },
            {
                name: "detailLevel",
                type: "enum",
                description: "standard or minimal",
                required: false,
                defaultValue: "standard",
                enumValues: ["standard", "minimal"],
            },
        ],
    },
    {
        name: "get_flow",
        description: "Get full details of a single execution flow by ID or partial name.",
        params: [
            { name: "flowId", type: "string", description: "Exact flow ID (from list_flows)", required: false },
            { name: "flowName", type: "string", description: "Partial name to search for", required: false },
        ],
        hint: "Run list_flows first to get an ID or name to look up.",
    },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Repo {
    id: string;
    repositoryId: string;
    fullName: string;
    framework: string | null;
}

interface TestRun {
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    result: string | null;
    parsed: unknown;
    executionMs: number;
    error?: string;
    timestamp: string;
    status: "ok" | "error" | "running";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status: TestRun["status"]) {
    if (status === "running") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    if (status === "ok") return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
    return "bg-red-500/20 text-red-400 border-red-500/30";
}

function statusLabel(run: TestRun) {
    if (run.status === "running") return "⟳ Running";
    if (run.status === "ok") return `✓ OK  ${run.executionMs}ms`;
    return `✗ Error  ${run.executionMs}ms`;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ToolsTestPage() {
    const [repos, setRepos] = useState<Repo[]>([]);
    const [loadingRepos, setLoadingRepos] = useState(true);
    const [selectedRepoId, setSelectedRepoId] = useState("");
    const [selectedTool, setSelectedTool] = useState<ToolDef>(TOOL_DEFS[0]);
    const [paramValues, setParamValues] = useState<Record<string, string>>({});
    const [running, setRunning] = useState(false);
    const [runs, setRuns] = useState<TestRun[]>([]);
    const [expandedRun, setExpandedRun] = useState<string | null>(null);
    const [runAllProgress, setRunAllProgress] = useState<{ current: number; total: number } | null>(null);

    // Load repos
    useEffect(() => {
        fetch("/api/agent/repositories")
            .then((r) => r.json())
            .then((d) => setRepos(d.repositories ?? []))
            .finally(() => setLoadingRepos(false));
    }, []);

    // Reset params when tool changes
    useEffect(() => {
        const defaults: Record<string, string> = {};
        for (const p of selectedTool.params) {
            if (p.defaultValue !== undefined) {
                defaults[p.name] = String(p.defaultValue);
            }
        }
        setParamValues(defaults);
    }, [selectedTool]);

    // Build args from param values
    const buildArgs = useCallback((tool: ToolDef, values: Record<string, string>) => {
        const args: Record<string, unknown> = {};
        for (const p of tool.params) {
            const raw = values[p.name];
            if (raw === undefined || raw === "") {
                if (p.defaultValue !== undefined) {
                    args[p.name] = p.type === "number" ? Number(p.defaultValue) : p.defaultValue;
                }
                continue;
            }
            if (p.type === "number") {
                args[p.name] = Number(raw);
            } else if (p.type === "boolean") {
                args[p.name] = raw === "true";
            } else {
                args[p.name] = raw;
            }
        }
        return args;
    }, []);

    // Run a single tool
    const runTool = useCallback(async (tool: ToolDef, args: Record<string, unknown>): Promise<TestRun> => {
        const id = `${tool.name}-${Date.now()}`;
        const runRecord: TestRun = {
            id,
            toolName: tool.name,
            args,
            result: null,
            parsed: null,
            executionMs: 0,
            timestamp: new Date().toISOString(),
            status: "running",
        };

        setRuns((prev) => [runRecord, ...prev]);

        try {
            const res = await fetch("/api/agent/tools-test", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repositoryId: selectedRepoId, toolName: tool.name, args }),
            });
            const data = await res.json();

            const finalRun: TestRun = {
                ...runRecord,
                result: data.result,
                parsed: data.parsed,
                executionMs: data.executionMs ?? 0,
                error: data.error,
                status: data.error ? "error" : (() => {
                    // Also check if the parsed result itself has status: error
                    if (data.parsed && typeof data.parsed === "object" && (data.parsed as any).status === "error") {
                        return "error";
                    }
                    return "ok";
                })(),
            };
            setRuns((prev) => prev.map((r) => r.id === id ? finalRun : r));
            setExpandedRun(id);
            return finalRun;
        } catch (e) {
            const errRun: TestRun = {
                ...runRecord,
                executionMs: 0,
                error: e instanceof Error ? e.message : "Network error",
                status: "error",
            };
            setRuns((prev) => prev.map((r) => r.id === id ? errRun : r));
            return errRun;
        }
    }, [selectedRepoId]);

    // Run current tool
    const handleRun = useCallback(async () => {
        if (!selectedRepoId) return;
        setRunning(true);
        const args = buildArgs(selectedTool, paramValues);
        await runTool(selectedTool, args);
        setRunning(false);
    }, [selectedRepoId, selectedTool, paramValues, buildArgs, runTool]);

    // Run all tools with default args sequentially
    const handleRunAll = useCallback(async () => {
        if (!selectedRepoId) return;
        setRunAllProgress({ current: 0, total: TOOL_DEFS.length });
        for (let i = 0; i < TOOL_DEFS.length; i++) {
            const tool = TOOL_DEFS[i];
            const defaults: Record<string, string> = {};
            for (const p of tool.params) {
                if (p.defaultValue !== undefined) defaults[p.name] = String(p.defaultValue);
            }
            const args = buildArgs(tool, defaults);
            setRunAllProgress({ current: i + 1, total: TOOL_DEFS.length });
            await runTool(tool, args);
        }
        setRunAllProgress(null);
    }, [selectedRepoId, buildArgs, runTool]);

    // ─── Stats bar ────────────────────────────────────────────────────────────
    const okCount = runs.filter((r) => r.status === "ok").length;
    const errCount = runs.filter((r) => r.status === "error").length;

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div className="min-h-screen bg-gray-950 text-gray-100 font-sans">
            {/* Header */}
            <div className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-base">
                        🔬
                    </div>
                    <div>
                        <h1 className="text-base font-bold text-white leading-tight">Knowledge Graph — Tool Tester</h1>
                        <p className="text-xs text-gray-400">Invoke each graph tool directly and verify results before wiring to an agent</p>
                    </div>

                    {/* Stats pills */}
                    {runs.length > 0 && (
                        <div className="ml-auto flex items-center gap-2 text-xs">
                            <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold">
                                ✓ {okCount} passed
                            </span>
                            {errCount > 0 && (
                                <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 font-semibold">
                                    ✗ {errCount} failed
                                </span>
                            )}
                            <span className="text-gray-500">{runs.length} runs</span>
                        </div>
                    )}
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">

                {/* ── Left: Tool selector + runner ── */}
                <div className="space-y-4">

                    {/* Repo picker */}
                    <div className="bg-gray-900 border border-white/10 rounded-xl p-4">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Repository</p>
                        {loadingRepos ? (
                            <div className="h-9 bg-gray-800 rounded-lg animate-pulse" />
                        ) : (
                            <select
                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                value={selectedRepoId}
                                onChange={(e) => setSelectedRepoId(e.target.value)}
                            >
                                <option value="">— select a repository —</option>
                                {repos.map((r) => (
                                    <option key={r.id} value={r.id}>
                                        {r.fullName}{r.framework ? ` (${r.framework})` : ""}
                                    </option>
                                ))}
                            </select>
                        )}
                        {selectedRepoId && (
                            <p className="text-xs text-gray-500 mt-1.5 font-mono truncate">
                                ID: {selectedRepoId}
                            </p>
                        )}
                    </div>

                    {/* Tool selector */}
                    <div className="bg-gray-900 border border-white/10 rounded-xl p-4">
                        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Select Tool</p>
                        <div className="space-y-1">
                            {TOOL_DEFS.map((t) => {
                                const lastRun = [...runs].reverse().find((r) => r.toolName === t.name);
                                return (
                                    <button
                                        key={t.name}
                                        onClick={() => setSelectedTool(t)}
                                        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors
                      ${selectedTool.name === t.name
                                                ? "bg-indigo-600/20 border border-indigo-500/30 text-indigo-300"
                                                : "hover:bg-white/5 text-gray-300 border border-transparent"}`}
                                    >
                                        {/* Status dot */}
                                        <span className={`shrink-0 w-2 h-2 rounded-full ${lastRun
                                            ? lastRun.status === "ok" ? "bg-emerald-400"
                                                : lastRun.status === "error" ? "bg-red-400"
                                                    : "bg-blue-400 animate-pulse"
                                            : "bg-gray-700"
                                            }`} />
                                        <span className="font-mono text-xs flex-1 truncate">{t.name}</span>
                                        {lastRun && (
                                            <span className="text-[10px] text-gray-500 shrink-0">
                                                {lastRun.executionMs}ms
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Run all */}
                    <button
                        onClick={handleRunAll}
                        disabled={!selectedRepoId || !!runAllProgress}
                        className="w-full py-2.5 rounded-lg bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold transition-colors"
                    >
                        {runAllProgress
                            ? `Running ${runAllProgress.current}/${runAllProgress.total}…`
                            : "▶▶  Run All Tools"}
                    </button>
                    {runAllProgress && (
                        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-purple-500 transition-all duration-300"
                                style={{ width: `${(runAllProgress.current / runAllProgress.total) * 100}%` }}
                            />
                        </div>
                    )}
                </div>

                {/* ── Right: Args form + results ── */}
                <div className="space-y-4">

                    {/* Args form */}
                    <div className="bg-gray-900 border border-white/10 rounded-xl p-5">
                        <div className="flex items-start justify-between gap-4 mb-4">
                            <div>
                                <h2 className="text-sm font-bold text-white font-mono">{selectedTool.name}</h2>
                                <p className="text-xs text-gray-400 mt-0.5">{selectedTool.description}</p>
                                {selectedTool.hint && (
                                    <p className="text-xs text-indigo-400 mt-1">💡 {selectedTool.hint}</p>
                                )}
                            </div>
                            <button
                                onClick={handleRun}
                                disabled={!selectedRepoId || running}
                                className="shrink-0 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition-colors"
                            >
                                {running ? (
                                    <>
                                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                        </svg>
                                        Running…
                                    </>
                                ) : "▶  Run"}
                            </button>
                        </div>

                        {selectedTool.params.length === 0 ? (
                            <p className="text-xs text-gray-500 italic">This tool takes no arguments.</p>
                        ) : (
                            <div className="space-y-3">
                                {selectedTool.params.map((p) => (
                                    <div key={p.name}>
                                        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400 mb-1">
                                            <code className="text-indigo-300">{p.name}</code>
                                            {p.required && <span className="text-red-400">*</span>}
                                            <span className="text-gray-600">— {p.description}</span>
                                        </label>
                                        {p.type === "enum" ? (
                                            <select
                                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                                value={paramValues[p.name] ?? String(p.defaultValue ?? "")}
                                                onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                                            >
                                                {!p.required && <option value="">— optional —</option>}
                                                {p.enumValues!.map((v) => (
                                                    <option key={v} value={v}>{v}</option>
                                                ))}
                                            </select>
                                        ) : p.type === "boolean" ? (
                                            <select
                                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                                value={paramValues[p.name] ?? "false"}
                                                onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                                            >
                                                <option value="false">false</option>
                                                <option value="true">true</option>
                                            </select>
                                        ) : (
                                            <input
                                                type={p.type === "number" ? "number" : "text"}
                                                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                                placeholder={p.required ? `required` : `optional — default: ${p.defaultValue ?? "none"}`}
                                                value={paramValues[p.name] ?? ""}
                                                onChange={(e) => setParamValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                                            />
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Args preview */}
                        <div className="mt-4 pt-3 border-t border-white/5">
                            <p className="text-[10px] text-gray-600 font-semibold uppercase tracking-wider mb-1">Request Preview</p>
                            <pre className="text-xs text-gray-400 bg-black/30 rounded p-2.5 overflow-auto max-h-24">
                                {JSON.stringify(buildArgs(selectedTool, paramValues), null, 2)}
                            </pre>
                        </div>
                    </div>

                    {/* Results list */}
                    {runs.length > 0 && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider">
                                    Run History ({runs.length})
                                </p>
                                <button
                                    onClick={() => setRuns([])}
                                    className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                                >
                                    Clear
                                </button>
                            </div>

                            {runs.map((run) => (
                                <div key={run.id} className="bg-gray-900 border border-white/10 rounded-xl overflow-hidden">
                                    {/* Run header */}
                                    <button
                                        onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                                    >
                                        {/* Status badge */}
                                        <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold border ${statusBadge(run.status)}`}>
                                            {statusLabel(run)}
                                        </span>

                                        {/* Tool name */}
                                        <span className="font-mono text-sm text-gray-200 flex-1 truncate">
                                            {run.toolName}
                                        </span>

                                        {/* Args preview */}
                                        <span className="text-xs text-gray-500 truncate max-w-[200px] shrink-0">
                                            {JSON.stringify(run.args).slice(0, 60)}
                                            {JSON.stringify(run.args).length > 60 ? "…" : ""}
                                        </span>

                                        {/* Timestamp */}
                                        <span className="text-[10px] text-gray-600 shrink-0">
                                            {new Date(run.timestamp).toLocaleTimeString()}
                                        </span>

                                        {/* Expand arrow */}
                                        <svg
                                            className={`w-4 h-4 text-gray-600 transition-transform shrink-0 ${expandedRun === run.id ? "rotate-180" : ""}`}
                                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                                        >
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                        </svg>
                                    </button>

                                    {/* Expanded result */}
                                    {expandedRun === run.id && (
                                        <div className="border-t border-white/5">
                                            {/* Error */}
                                            {run.error && (
                                                <div className="px-4 py-3 bg-red-950/30">
                                                    <p className="text-xs font-bold text-red-400 uppercase mb-1">Error</p>
                                                    <pre className="text-xs text-red-300 whitespace-pre-wrap break-all">{run.error}</pre>
                                                </div>
                                            )}

                                            {/* Result status from parsed JSON */}
                                            {run.parsed && typeof run.parsed === "object" && (run.parsed as any).status === "error" && (
                                                <div className="px-4 py-3 bg-red-950/30">
                                                    <p className="text-xs font-bold text-red-400 uppercase mb-1">Tool Returned Error</p>
                                                    <pre className="text-xs text-red-300 whitespace-pre-wrap break-all">
                                                        {(run.parsed as any).error}
                                                    </pre>
                                                </div>
                                            )}

                                            {/* Summary line */}
                                            {run.parsed && typeof run.parsed === "object" && (run.parsed as any).summary && (
                                                <div className="px-4 py-2 bg-indigo-950/30 border-b border-white/5">
                                                    <p className="text-xs text-indigo-300 font-medium">{(run.parsed as any).summary}</p>
                                                </div>
                                            )}

                                            {/* Stats row */}
                                            {run.parsed && typeof run.parsed === "object" && (
                                                <StatsRow parsed={run.parsed as Record<string, unknown>} />
                                            )}

                                            {/* Full JSON output */}
                                            <div className="px-4 py-3">
                                                <div className="flex items-center justify-between mb-1">
                                                    <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                                                        Raw Output ({run.result?.length ?? 0} chars)
                                                    </p>
                                                </div>
                                                <pre className="text-xs bg-black/40 rounded p-3 overflow-auto max-h-[500px] text-gray-300 whitespace-pre-wrap break-all">
                                                    {run.result
                                                        ? JSON.stringify(JSON.parse(run.result), null, 2)
                                                        : "(no output)"}
                                                </pre>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {runs.length === 0 && (
                        <div className="bg-gray-900 border border-white/10 rounded-xl p-12 text-center">
                            <p className="text-gray-500">Select a tool and click <strong className="text-gray-300">Run</strong> to see results here.</p>
                            <p className="text-xs text-gray-600 mt-2">Or use <strong className="text-gray-400">Run All Tools</strong> to test everything at once.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ─── Stats Row component ───────────────────────────────────────────────────────

function StatsRow({ parsed }: { parsed: Record<string, unknown> }) {
    const items: { label: string; value: string; color: string }[] = [];

    if (typeof parsed.totalNodes === "number")
        items.push({ label: "Nodes", value: parsed.totalNodes.toLocaleString(), color: "text-blue-400" });
    if (typeof parsed.totalEdges === "number")
        items.push({ label: "Edges", value: parsed.totalEdges.toLocaleString(), color: "text-purple-400" });
    if (typeof parsed.totalFlows === "number")
        items.push({ label: "Flows", value: parsed.totalFlows.toLocaleString(), color: "text-indigo-400" });
    if (typeof parsed.total === "number")
        items.push({ label: "Total", value: parsed.total.toLocaleString(), color: "text-gray-300" });
    if (typeof (parsed as any).count === "number")
        items.push({ label: "Count", value: (parsed as any).count.toLocaleString(), color: "text-gray-300" });
    if (Array.isArray(parsed.flows))
        items.push({ label: "Flows", value: parsed.flows.length.toLocaleString(), color: "text-indigo-400" });
    if (Array.isArray((parsed as any).dbHeavyFunctions))
        items.push({ label: "Functions", value: (parsed as any).dbHeavyFunctions.length.toLocaleString(), color: "text-amber-400" });
    if (Array.isArray((parsed as any).callChain))
        items.push({ label: "Steps", value: (parsed as any).callChain.length.toLocaleString(), color: "text-cyan-400" });
    if (Array.isArray((parsed as any).callers))
        items.push({ label: "Callers", value: (parsed as any).callers.length.toLocaleString(), color: "text-green-400" });
    if (Array.isArray((parsed as any).callees))
        items.push({ label: "Callees", value: (parsed as any).callees.length.toLocaleString(), color: "text-green-400" });
    if (Array.isArray((parsed as any).results))
        items.push({ label: "Results", value: (parsed as any).results.length.toLocaleString(), color: "text-emerald-400" });

    if (items.length === 0) return null;

    return (
        <div className="px-4 py-2 flex flex-wrap gap-4 border-b border-white/5 bg-gray-800/30">
            {items.map((item) => (
                <div key={item.label} className="text-center">
                    <p className={`text-lg font-bold font-mono ${item.color}`}>{item.value}</p>
                    <p className="text-[10px] text-gray-500">{item.label}</p>
                </div>
            ))}
        </div>
    );
}
