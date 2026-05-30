"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Github, Loader2, HardDrive, CheckCircle2, XCircle, Clock, Zap, FileText } from "lucide-react";
import { toast } from "sonner";
import { checkPackageAndFramework } from "../../actions/analysis/repository-analysis";
import { classifyBusinessContext } from "../../actions/analysis/business-classification";
import { checkRepositoryReportStatus, getRepositoryById } from "../../actions/github/repository-queries";
import { fetchAndStoreRepoSize } from "../../actions/analysis/repo-size";

interface Repository {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    description: string | null;
    url: string;
}

interface GitHubRepositorySelectorProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelectRepository: (repository: Repository) => void;
}

// ─── Pipeline Stage ───────────────────────────────────────────────────────────

type PipelineStage =
    | "select"            // Stage 1: pick a repo
    | "framework"         // Stage 2: framework analysis (auto)
    | "classification"    // Stage 3: business classification (auto)
    | "orchestration"     // Stage 4: agents running in parallel (auto)
    | "compiling"         // Stage 5: compiling final report (auto)
    | "complete";         // Stage 6: all done

// ─── Per-Agent Status ─────────────────────────────────────────────────────────

type AgentStatus = "pending" | "queued" | "running" | "completed" | "failed";

interface AgentState {
    archetype: string;
    status: AgentStatus;
    executionTimeMs?: number;
    totalToolCalls?: number;
    error?: string;
}

// ─── Status Chip Component ────────────────────────────────────────────────────

function AgentChip({ agent }: { agent: AgentState }) {
    const statusConfig: Record<AgentStatus, { icon: typeof Loader2; color: string; label: string }> = {
        pending: { icon: Clock, color: "text-muted-foreground bg-muted", label: "Pending" },
        queued: { icon: Clock, color: "text-yellow-600 bg-yellow-500/10", label: "Queued" },
        running: { icon: Loader2, color: "text-blue-600 bg-blue-500/10", label: "Running" },
        completed: { icon: CheckCircle2, color: "text-green-600 bg-green-500/10", label: "Done" },
        failed: { icon: XCircle, color: "text-red-600 bg-red-500/10", label: "Failed" },
    };

    const cfg = statusConfig[agent.status];
    const Icon = cfg.icon;
    const isSpinning = agent.status === "running";

    return (
        <div
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.color}`}
            title={agent.error ?? cfg.label}
        >
            <Icon className={`h-3 w-3 ${isSpinning ? "animate-spin" : ""}`} />
            <span className="truncate max-w-[120px]">{agent.archetype}</span>
            {agent.executionTimeMs != null && agent.status === "completed" && (
                <span className="opacity-60">{(agent.executionTimeMs / 1000).toFixed(1)}s</span>
            )}
        </div>
    );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function GitHubRepositorySelector({ open, onOpenChange, onSelectRepository }: GitHubRepositorySelectorProps) {
    const router = useRouter();
    const [repositories, setRepositories] = useState<Repository[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedRepo, setSelectedRepo] = useState<string>("");
    const [analyzedRepoId, setAnalyzedRepoId] = useState<string | null>(null);
    const [repoSizeKB, setRepoSizeKB] = useState<number | null>(null);
    const [fetchingSize, setFetchingSize] = useState(false);

    // Pipeline state
    const [stage, setStage] = useState<PipelineStage>("select");
    const [agentStates, setAgentStates] = useState<AgentState[]>([]);
    const [orchestrationError, setOrchestrationError] = useState<string | null>(null);
    const [hasExistingReports, setHasExistingReports] = useState(false);
    const [hasCompiledReport, setHasCompiledReport] = useState(false);
    const [compilingReport, setCompilingReport] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (open) {
            fetchRepositories();
        }
    }, [open]);

    // Cleanup SSE on close
    useEffect(() => {
        if (!open) {
            abortRef.current?.abort();
            abortRef.current = null;
        }
    }, [open]);

    const fetchRepositories = async () => {
        try {
            setLoading(true);
            const response = await fetch("/api/github/repositories");

            if (!response.ok) {
                throw new Error("Failed to fetch repositories");
            }

            const data = await response.json();
            setRepositories(data.repositories);
        } catch (error) {
            console.error("Error fetching repositories:", error);
            toast.error("Failed to load repositories");
        } finally {
            setLoading(false);
        }
    };

    // Check if repository framework is already analyzed when selected
    const handleRepoChange = async (repoFullName: string) => {
        setSelectedRepo(repoFullName);
        setAnalyzedRepoId(null);
        setRepoSizeKB(null);
        setStage("select");
        setAgentStates([]);
        setOrchestrationError(null);
        setHasExistingReports(false);
        setHasCompiledReport(false);
        setCompilingReport(false);

        const repository = repositories.find((repo) => repo.fullName === repoFullName);
        if (!repository) return;

        try {
            // Check if this repository has already been analyzed
            const dbRepo = await getRepositoryById(repository.id.toString());

            if (dbRepo && dbRepo.isSupported && dbRepo.framework) {
                setAnalyzedRepoId(repository.id.toString());
                // Restore cached size if available
                if ((dbRepo as any).repoSizeKB) setRepoSizeKB((dbRepo as any).repoSizeKB);
                toast.success(
                    `Framework already detected: ${dbRepo.framework.toUpperCase()}`,
                    { description: "Ready to analyze" }
                );

                // Check if agent reports already exist for this repo
                try {
                    const status = await checkRepositoryReportStatus(repository.id.toString());
                    setHasExistingReports(status.hasReports);
                    setHasCompiledReport(status.hasCompiledReport);
                } catch {
                    // Non-critical — ignore
                }
            }
        } catch (error) {
            console.error("Error checking repository status:", error);
        }
    };

    // ─── Stage 2: Framework Analysis ──────────────────────────────────

    const runFrameworkAnalysis = useCallback(async (repository: Repository) => {
        setStage("framework");
        toast.info("Analyzing repository framework...");

        try {
            const result = await checkPackageAndFramework(
                repository.id.toString(),
                repository.fullName
            );

            console.log("=== Framework Analysis Result ===");
            console.log("Repository:", repository.fullName);
            console.log("Is Supported:", result.isSupported);
            console.log("Framework:", result.framework);
            console.log("================================");

            if (result.isSupported) {
                toast.success(
                    `Detected ${result.framework?.toUpperCase()} project`,
                    { description: `Branch: ${result.defaultBranch || "N/A"}` }
                );
                setAnalyzedRepoId(repository.id.toString());
                return true;
            } else {
                toast.error("Could not detect Next.js or React framework", {
                    description: result.error || "Repository may not be a supported framework",
                });
                setStage("select");
                setAnalyzedRepoId(null);
                return false;
            }
        } catch (error) {
            console.error("Error analyzing repository:", error);
            toast.error("Failed to analyze repository", {
                description: error instanceof Error ? error.message : "Unknown error",
            });
            setStage("select");
            setAnalyzedRepoId(null);
            return false;
        }
    }, []);

    // ─── Stage 3: Business Classification ─────────────────────────────

    const runClassification = useCallback(async (repoId: string) => {
        setStage("classification");
        toast.info("Classifying business context...");

        try {
            const result = await classifyBusinessContext(repoId);

            if (result.classification) {
                const top = result.classification.archetypes[0];
                toast.success(
                    `Top archetype: ${top.name} (${top.score})`,
                    {
                        description: `${result.classification.archetypes.length} archetype(s) detected`,
                    }
                );
                return true;
            } else {
                toast.error("Failed to classify business context", {
                    description: result.error || "Unknown error occurred",
                });
                setStage("select");
                return false;
            }
        } catch (error) {
            console.error("Error classifying business context:", error);
            toast.error("Failed to classify business context", {
                description: error instanceof Error ? error.message : "Unknown error",
            });
            setStage("select");
            return false;
        }
    }, []);

    // ─── Stage 4: Agent Orchestration via SSE ─────────────────────────

    const runOrchestration = useCallback(async (repoId: string) => {
        setStage("orchestration");
        setAgentStates([]);
        setOrchestrationError(null);
        toast.info("Dispatching analysis agents...");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch("/api/agent/orchestrate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repositoryId: repoId }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const reader = response.body?.getReader();
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
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        handleOrchestratorEvent(event);
                    } catch {
                        // ignore malformed events
                    }
                }
            }
        } catch (error) {
            if ((error as any)?.name === "AbortError") return;
            const msg = error instanceof Error ? error.message : "Unknown error";
            console.error("[orchestration] Error:", msg);
            setOrchestrationError(msg);
            toast.error("Agent orchestration failed", { description: msg });
            setStage("select");
        }
    }, []);

    const handleOrchestratorEvent = useCallback((event: any) => {
        switch (event.type) {
            case "orchestration_start":
                break;
            case "agent_queued":
                setAgentStates((prev) => [
                    ...prev.filter((a) => a.archetype !== event.archetype),
                    { archetype: event.archetype, status: "queued" },
                ]);
                break;
            case "agent_running":
                setAgentStates((prev) =>
                    prev.map((a) =>
                        a.archetype === event.archetype ? { ...a, status: "running" } : a
                    )
                );
                break;
            case "agent_completed":
                setAgentStates((prev) =>
                    prev.map((a) =>
                        a.archetype === event.archetype
                            ? {
                                ...a,
                                status: "completed",
                                totalToolCalls: event.totalToolCalls,
                                executionTimeMs: event.executionTimeMs,
                            }
                            : a
                    )
                );
                break;
            case "agent_failed":
                setAgentStates((prev) =>
                    prev.map((a) =>
                        a.archetype === event.archetype
                            ? {
                                ...a,
                                status: "failed",
                                error: event.error,
                                totalToolCalls: event.totalToolCalls,
                                executionTimeMs: event.executionTimeMs,
                            }
                            : a
                    )
                );
                break;
            case "report_compiling":
                setStage("compiling");
                setCompilingReport(true);
                break;
            case "report_compiled":
                setCompilingReport(false);
                setHasCompiledReport(true);
                toast.success("Final report compiled", {
                    description: `Report: ${((event.reportCompileTimeMs ?? 0) / 1000).toFixed(1)}s`,
                });
                break;
            case "report_failed":
                setCompilingReport(false);
                toast.error("Report compilation failed", { description: event.error });
                break;
            case "orchestration_complete": {
                if (event.error) {
                    setOrchestrationError(event.error);
                    toast.error("Orchestration failed", { description: event.error });
                    setStage("select");
                } else {
                    setStage("complete");
                    if (event.compiledReport) {
                        setHasCompiledReport(true);
                    }
                    toast.success(
                        `Analysis complete: ${event.completedAgents}/${event.totalAgents} agents succeeded`,
                        {
                            description: `Total time: ${((event.totalExecutionTimeMs ?? 0) / 1000).toFixed(1)}s`,
                        }
                    );
                }
                break;
            }
        }
    }, []);

    // ─── Full Pipeline Trigger ────────────────────────────────────────

    const handleAnalyze = async () => {
        const repository = repositories.find((repo) => repo.fullName === selectedRepo);
        if (!repository) return;

        onSelectRepository(repository);

        // Step 1: Framework analysis (skip if already analyzed)
        let repoId = analyzedRepoId;
        if (!repoId) {
            const success = await runFrameworkAnalysis(repository);
            if (!success) return;
            repoId = repository.id.toString();
            setAnalyzedRepoId(repoId);
        }

        // Step 2: Business classification
        const classified = await runClassification(repoId);
        if (!classified) return;

        // Step 3: Agent orchestration (includes report compilation)
        await runOrchestration(repoId);
    };

    const handleGetRepoSize = async () => {
        const repository = repositories.find((r) => r.fullName === selectedRepo);
        if (!repository) return;
        setFetchingSize(true);
        try {
            const result = await fetchAndStoreRepoSize(
                repository.id.toString(),
                repository.fullName,
            );
            if (result.sizeKB !== null) {
                setRepoSizeKB(result.sizeKB);
                const mb = (result.sizeKB / 1024).toFixed(1);
                toast.success(`Repo size: ${result.sizeKB.toLocaleString()} KB (${mb} MB)`, {
                    description: "Size stored to database",
                });
            } else {
                toast.error("Could not fetch repo size", { description: result.error });
            }
        } catch {
            toast.error("Failed to fetch repo size");
        } finally {
            setFetchingSize(false);
        }
    };

    // ─── Standalone Compile Trigger ─────────────────────────────────────

    const handleCompileReport = useCallback(async () => {
        if (!analyzedRepoId) return;
        setStage("compiling");
        setCompilingReport(true);
        toast.info("Compiling final report...");

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            const response = await fetch("/api/agent/compile-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ repositoryId: analyzedRepoId }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${response.status}`);
            }

            const reader = response.body?.getReader();
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
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const event = JSON.parse(line.slice(6));
                        if (event.type === "compiler_completed" || event.type === "result") {
                            setCompilingReport(false);
                            setHasCompiledReport(true);
                            setStage("complete");
                            toast.success("Final report compiled successfully", {
                                description: `Execution time: ${((event.executionTimeMs ?? 0) / 1000).toFixed(1)}s`,
                            });
                        } else if (event.type === "compiler_failed" || event.type === "error") {
                            setCompilingReport(false);
                            setStage("select");
                            toast.error("Report compilation failed", {
                                description: event.error ?? "Unknown error",
                            });
                        }
                    } catch {
                        // ignore malformed events
                    }
                }
            }
        } catch (error) {
            if ((error as any)?.name === "AbortError") return;
            const msg = error instanceof Error ? error.message : "Unknown error";
            console.error("[compile-report] Error:", msg);
            setCompilingReport(false);
            setStage("select");
            toast.error("Report compilation failed", { description: msg });
        }
    }, [analyzedRepoId]);

    // ─── Computed values ──────────────────────────────────────────────

    const isRunning = stage === "framework" || stage === "classification" || stage === "orchestration" || stage === "compiling";
    const completedCount = agentStates.filter((a) => a.status === "completed").length;
    const failedCount = agentStates.filter((a) => a.status === "failed").length;
    const totalAgents = agentStates.length;

    const stageLabel: Record<PipelineStage, string> = {
        select: "Select a repository to analyze",
        framework: "Analyzing framework...",
        classification: "Classifying business context...",
        orchestration: `Running ${totalAgents} agents in parallel...`,
        compiling: "Compiling final report...",
        complete: "Analysis complete",
    };

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!isRunning) onOpenChange(v); }}>
            <DialogContent className="sm:max-w-[520px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Github className="h-5 w-5" />
                        {stage === "complete" ? "Analysis Complete" : "Analyze Repository"}
                    </DialogTitle>
                    <DialogDescription>
                        {stageLabel[stage]}
                    </DialogDescription>
                </DialogHeader>

                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div className="space-y-4">
                        {/* Repository selector — always visible */}
                        <Select
                            value={selectedRepo}
                            onValueChange={handleRepoChange}
                            disabled={isRunning}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select a repository" />
                            </SelectTrigger>
                            <SelectContent>
                                {repositories.map((repo) => (
                                    <SelectItem key={repo.id} value={repo.fullName}>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{repo.name}</span>
                                            {repo.private && (
                                                <span className="text-xs text-muted-foreground">(Private)</span>
                                            )}
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        {/* Repo description & size */}
                        {selectedRepo && (
                            <div className="flex items-center justify-between">
                                <div className="text-sm text-muted-foreground">
                                    {repositories.find((r) => r.fullName === selectedRepo)?.description || "No description"}
                                </div>
                                {repoSizeKB !== null ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0 ml-2">
                                        <HardDrive className="h-3 w-3" />
                                        {repoSizeKB >= 1024
                                            ? `${(repoSizeKB / 1024).toFixed(1)} MB`
                                            : `${repoSizeKB.toLocaleString()} KB`}
                                    </span>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="shrink-0 ml-2 h-7 text-xs"
                                        onClick={handleGetRepoSize}
                                        disabled={fetchingSize || isRunning}
                                    >
                                        {fetchingSize ? (
                                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                        ) : (
                                            <HardDrive className="h-3 w-3 mr-1" />
                                        )}
                                        {fetchingSize ? "Fetching..." : "Get Size"}
                                    </Button>
                                )}
                            </div>
                        )}

                        {/* Pipeline progress indicator */}
                        {isRunning && (
                            <div className="space-y-3 pt-2 border-t">
                                {/* Stage progress bar */}
                                <div className="flex items-center gap-2">
                                    <div className="flex gap-1 flex-1">
                                        {(["framework", "classification", "orchestration", "compiling"] as PipelineStage[]).map((s) => {
                                            const stageOrder = ["framework", "classification", "orchestration", "compiling"];
                                            const currentIdx = stageOrder.indexOf(stage);
                                            const isActive = stageOrder.indexOf(s) === currentIdx;
                                            const isDone = stageOrder.indexOf(s) < currentIdx;
                                            return (
                                                <div
                                                    key={s}
                                                    className={`h-1.5 flex-1 rounded-full transition-colors ${isDone
                                                            ? "bg-green-500"
                                                            : isActive
                                                                ? "bg-blue-500 animate-pulse"
                                                                : "bg-muted"
                                                        }`}
                                                />
                                            );
                                        })}
                                    </div>
                                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                </div>

                                {/* Stage label */}
                                <p className="text-sm text-muted-foreground">
                                    {stage === "framework" && "Step 1/4 — Detecting framework..."}
                                    {stage === "classification" && "Step 2/4 — Classifying business context..."}
                                    {stage === "orchestration" && (
                                        <>Step 3/4 — {completedCount + failedCount}/{totalAgents} agents finished</>
                                    )}
                                    {stage === "compiling" && "Step 4/4 — Compiling final report..."}
                                </p>
                            </div>
                        )}

                        {/* Per-agent status chips (Stage 4) */}
                        {(stage === "orchestration" || stage === "compiling" || stage === "complete") && agentStates.length > 0 && (
                            <div className="space-y-2 pt-2 border-t">
                                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                                    <Zap className="h-3.5 w-3.5" />
                                    Agent Progress
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {agentStates.map((agent) => (
                                        <AgentChip key={agent.archetype} agent={agent} />
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Complete summary */}
                        {stage === "complete" && (
                            <div className="pt-2 border-t space-y-3">
                                <div className="flex items-center gap-2 text-sm">
                                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                                    <span className="font-medium">
                                        {completedCount} agent{completedCount !== 1 ? "s" : ""} completed
                                    </span>
                                    {failedCount > 0 && (
                                        <span className="text-red-600 text-xs">
                                            ({failedCount} failed)
                                        </span>
                                    )}
                                </div>
                                <Button
                                    className="w-full"
                                    onClick={() => {
                                        onOpenChange(false);
                                        router.push(`/reports/${analyzedRepoId}`);
                                    }}
                                >
                                    View Reports
                                </Button>
                            </div>
                        )}

                        {/* Action buttons */}
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={isRunning}
                            >
                                {stage === "complete" ? "Close" : "Cancel"}
                            </Button>
                            {stage === "select" && hasExistingReports && analyzedRepoId && (
                                <Button
                                    variant="secondary"
                                    onClick={() => {
                                        onOpenChange(false);
                                        router.push(`/reports/${analyzedRepoId}`);
                                    }}
                                >
                                    View Reports
                                </Button>
                            )}
                            {stage === "select" && hasExistingReports && !hasCompiledReport && analyzedRepoId && (
                                <Button
                                    variant="default"
                                    onClick={handleCompileReport}
                                    disabled={isRunning}
                                >
                                    <FileText className="h-4 w-4 mr-1" />
                                    Compile Report
                                </Button>
                            )}
                            {(stage === "select" || stage === "complete") && (
                                <Button
                                    onClick={handleAnalyze}
                                    disabled={!selectedRepo || isRunning}
                                >
                                    {stage === "complete" ? "Re-analyze" : hasExistingReports ? "Re-analyze" : analyzedRepoId ? "Run Analysis" : "Analyze"}
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
