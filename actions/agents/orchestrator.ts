/* eslint-disable @typescript-eslint/no-explicit-any */

import prisma from "@/lib/prisma";
import { getInstallationToken } from "@/lib/github";

// ─── Agent Runners ────────────────────────────────────────────────────────────

import { runDatabaseAgent } from "./db";
import { runAuthAgent } from "./auth";
import { runComputeHeavyAgent } from "./compute-heavy";
import { runAiPoweredAgent } from "./ai-powered";
import { runRealtimeAgent } from "./realtime";
import { runEventDrivenAgent } from "./event-driven";
import { runTransactionAgent } from "./transaction";
import { runContentHeavyAgent } from "./content-heavy";
import { runReportCompiler } from "./report-compiler";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorStreamEvent {
    type:
        | "orchestration_start"
        | "agent_queued"
        | "agent_running"
        | "agent_completed"
        | "agent_failed"
        | "report_compiling"
        | "report_compiled"
        | "report_failed"
        | "orchestration_complete";
    archetype?: string;
    timestamp: string;
    // agent_completed / agent_failed
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
    // orchestration_complete
    summary?: AgentSummary[];
    totalAgents?: number;
    completedAgents?: number;
    failedAgents?: number;
    totalExecutionTimeMs?: number;
    // report compilation
    compiledReport?: string;
    reportCompileTimeMs?: number;
}

interface AgentSummary {
    archetype: string;
    status: "completed" | "failed";
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

interface Archetype {
    name: string;
    score: number;
}

// ─── Runner Map ───────────────────────────────────────────────────────────────

type AgentRunner = (input: {
    repositoryId: string;
    accessToken: string;
    onEvent?: (event: any) => void;
    archetypeScore?: number;
}) => Promise<{
    rawFindings?: string | null;
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}>;

const ARCHETYPE_RUNNERS: Record<string, AgentRunner> = {
    "database-heavy": (input) =>
        runDatabaseAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            archetypeScore: input.archetypeScore ?? 0.5,
            onEvent: input.onEvent,
        }),
    "compute-heavy": (input) =>
        runComputeHeavyAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
    "ai-powered": (input) =>
        runAiPoweredAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
    "realtime": (input) =>
        runRealtimeAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
    "event-driven": (input) =>
        runEventDrivenAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
    "financial-transactional": (input) =>
        runTransactionAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
    "auth-heavy": (input) =>
        runAuthAgent(input.repositoryId, input.accessToken) as any,
    "content-heavy": (input) =>
        runContentHeavyAgent({
            repositoryId: input.repositoryId,
            accessToken: input.accessToken,
            onEvent: input.onEvent,
        }),
};

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function orchestrateAgents(
    repositoryId: string,
    onEvent: (event: OrchestratorStreamEvent) => void,
): Promise<void> {
    const orchestrationStart = Date.now();

    const emit = (event: OrchestratorStreamEvent) => {
        try {
            onEvent(event);
        } catch {
            /* ignore stream errors */
        }
    };

    // ── Resolve repository + access token ──────────────────────────────

    const repo = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repositoryId }, { repositoryId }],
        },
        select: {
            id: true,
            repositoryId: true,
            archetypes: true,
            user: {
                select: {
                    githubInstallationId: true,
                    githubAccessToken: true,
                },
            },
        },
    });

    if (!repo) {
        emit({
            type: "orchestration_complete",
            timestamp: new Date().toISOString(),
            error: `Repository "${repositoryId}" not found.`,
            totalAgents: 0,
            completedAgents: 0,
            failedAgents: 0,
            totalExecutionTimeMs: Date.now() - orchestrationStart,
            summary: [],
        });
        return;
    }

    // Resolve access token
    let accessToken = repo.user?.githubAccessToken ?? "";
    if (!accessToken && repo.user?.githubInstallationId) {
        try {
            const { token } = await getInstallationToken(
                repo.user.githubInstallationId,
            );
            accessToken = token;
        } catch (err) {
            console.error("[orchestrator] Failed to generate installation token:", err);
        }
    }

    if (!accessToken) {
        emit({
            type: "orchestration_complete",
            timestamp: new Date().toISOString(),
            error: "No GitHub access token available for this repository.",
            totalAgents: 0,
            completedAgents: 0,
            failedAgents: 0,
            totalExecutionTimeMs: Date.now() - orchestrationStart,
            summary: [],
        });
        return;
    }

    // ── Parse archetypes ────────────────────────────────────────────────

    const archetypes: Archetype[] = Array.isArray(repo.archetypes)
        ? (repo.archetypes as unknown as Archetype[])
        : [];

    if (archetypes.length === 0) {
        emit({
            type: "orchestration_complete",
            timestamp: new Date().toISOString(),
            error: "No archetypes found. Run business classification first.",
            totalAgents: 0,
            completedAgents: 0,
            failedAgents: 0,
            totalExecutionTimeMs: Date.now() - orchestrationStart,
            summary: [],
        });
        return;
    }

    // ── Emit start ──────────────────────────────────────────────────────

    emit({
        type: "orchestration_start",
        timestamp: new Date().toISOString(),
        totalAgents: archetypes.length,
    });

    // ── Upsert pending rows + emit queued ───────────────────────────────

    for (const arch of archetypes) {
        await prisma.agentReport.upsert({
            where: {
                repositoryId_archetype: {
                    repositoryId: repo.id,
                    archetype: arch.name,
                },
            },
            create: {
                repositoryId: repo.id,
                archetype: arch.name,
                status: "pending",
            },
            update: {
                status: "pending",
                rawFindings: null,
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: null,
            },
        });
        emit({
            type: "agent_queued",
            archetype: arch.name,
            timestamp: new Date().toISOString(),
        });
    }

    // ── Dispatch all agents in parallel ─────────────────────────────────

    const agentPromises = archetypes.map(async (arch): Promise<AgentSummary> => {
        const runner = ARCHETYPE_RUNNERS[arch.name];
        if (!runner) {
            const errorMsg = `No runner found for archetype "${arch.name}"`;
            console.warn(`[orchestrator] ${errorMsg}`);
            await prisma.agentReport.update({
                where: {
                    repositoryId_archetype: {
                        repositoryId: repo.id,
                        archetype: arch.name,
                    },
                },
                data: { status: "failed", error: errorMsg },
            });
            emit({
                type: "agent_failed",
                archetype: arch.name,
                timestamp: new Date().toISOString(),
                error: errorMsg,
                totalToolCalls: 0,
                executionTimeMs: 0,
            });
            return {
                archetype: arch.name,
                status: "failed",
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: errorMsg,
            };
        }

        // Mark running
        await prisma.agentReport.update({
            where: {
                repositoryId_archetype: {
                    repositoryId: repo.id,
                    archetype: arch.name,
                },
            },
            data: { status: "running" },
        });
        emit({
            type: "agent_running",
            archetype: arch.name,
            timestamp: new Date().toISOString(),
        });

        try {
            const result = await runner({
                repositoryId: repo.repositoryId,
                accessToken,
                archetypeScore: arch.score,
            });

            // Upsert completed
            await prisma.agentReport.update({
                where: {
                    repositoryId_archetype: {
                        repositoryId: repo.id,
                        archetype: arch.name,
                    },
                },
                data: {
                    status: result.error ? "failed" : "completed",
                    rawFindings: result.rawFindings ?? null,
                    totalToolCalls: result.totalToolCalls,
                    executionTimeMs: result.executionTimeMs,
                    error: result.error ?? null,
                },
            });

            if (result.error) {
                emit({
                    type: "agent_failed",
                    archetype: arch.name,
                    timestamp: new Date().toISOString(),
                    totalToolCalls: result.totalToolCalls,
                    executionTimeMs: result.executionTimeMs,
                    error: result.error,
                });
                return {
                    archetype: arch.name,
                    status: "failed",
                    totalToolCalls: result.totalToolCalls,
                    executionTimeMs: result.executionTimeMs,
                    error: result.error,
                };
            }

            emit({
                type: "agent_completed",
                archetype: arch.name,
                timestamp: new Date().toISOString(),
                totalToolCalls: result.totalToolCalls,
                executionTimeMs: result.executionTimeMs,
            });
            return {
                archetype: arch.name,
                status: "completed",
                totalToolCalls: result.totalToolCalls,
                executionTimeMs: result.executionTimeMs,
            };
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown error";
            console.error(`[orchestrator] Agent "${arch.name}" threw:`, errorMsg);

            await prisma.agentReport.update({
                where: {
                    repositoryId_archetype: {
                        repositoryId: repo.id,
                        archetype: arch.name,
                    },
                },
                data: {
                    status: "failed",
                    error: errorMsg,
                },
            });

            emit({
                type: "agent_failed",
                archetype: arch.name,
                timestamp: new Date().toISOString(),
                error: errorMsg,
                totalToolCalls: 0,
                executionTimeMs: 0,
            });

            return {
                archetype: arch.name,
                status: "failed",
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: errorMsg,
            };
        }
    });

    const results = await Promise.allSettled(agentPromises);
    const summaries: AgentSummary[] = results.map((r) =>
        r.status === "fulfilled"
            ? r.value
            : {
                archetype: "unknown",
                status: "failed" as const,
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: r.reason?.message ?? "Promise rejected",
            },
    );

    const completed = summaries.filter((s) => s.status === "completed").length;
    const failed = summaries.filter((s) => s.status === "failed").length;

    // ── Compile final report ────────────────────────────────────────────

    let compiledReport: string | undefined;
    let reportCompileTimeMs: number | undefined;

    if (completed > 0) {
        emit({
            type: "report_compiling",
            timestamp: new Date().toISOString(),
        });

        try {
            const compilerResult = await runReportCompiler({
                repositoryId: repo.id,
                onEvent: (event) => {
                    // Forward compiler reasoning as SSE
                    if (event.type === "compiler_thinking") {
                        emit({
                            type: "report_compiling",
                            timestamp: event.timestamp,
                        });
                    }
                },
            });

            if (compilerResult.compiledReport) {
                compiledReport = compilerResult.compiledReport;
                reportCompileTimeMs = compilerResult.executionTimeMs;
                emit({
                    type: "report_compiled",
                    timestamp: new Date().toISOString(),
                    compiledReport,
                    reportCompileTimeMs,
                });
                console.log(
                    `[orchestrator] Report compiled in ${reportCompileTimeMs}ms ` +
                    `(${compiledReport.length} chars)`,
                );
            } else {
                emit({
                    type: "report_failed",
                    timestamp: new Date().toISOString(),
                    error: compilerResult.error ?? "Report compiler returned empty result.",
                });
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown compiler error";
            console.error(`[orchestrator] Report compiler threw:`, errorMsg);
            emit({
                type: "report_failed",
                timestamp: new Date().toISOString(),
                error: errorMsg,
            });
        }
    }

    // ── Final orchestration complete ─────────────────────────────────────

    emit({
        type: "orchestration_complete",
        timestamp: new Date().toISOString(),
        summary: summaries,
        totalAgents: archetypes.length,
        completedAgents: completed,
        failedAgents: failed,
        totalExecutionTimeMs: Date.now() - orchestrationStart,
        compiledReport,
        reportCompileTimeMs,
    });
}
