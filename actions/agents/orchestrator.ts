/* eslint-disable @typescript-eslint/no-explicit-any */

import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";

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

export interface OrchestrationResult {
    summaries: AgentSummary[];
    totalAgents: number;
    completedAgents: number;
    failedAgents: number;
    totalExecutionTimeMs: number;
    compiledReport?: string;
    reportCompileTimeMs?: number;
}

// ─── Runner Map ───────────────────────────────────────────────────────────────

type AgentRunner = (input: {
    repositoryId: string;
    installationId: string;
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
            installationId: input.installationId,
            archetypeScore: input.archetypeScore ?? 0.5,
        }),
    "compute-heavy": (input) =>
        runComputeHeavyAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
    "ai-powered": (input) =>
        runAiPoweredAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
    "realtime": (input) =>
        runRealtimeAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
    "event-driven": (input) =>
        runEventDrivenAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
    "financial-transactional": (input) =>
        runTransactionAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
    "auth-heavy": (input) =>
        runAuthAgent(input.repositoryId, input.installationId) as any,
    "content-heavy": (input) =>
        runContentHeavyAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
        }),
};

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function orchestrateAgents(
    repositoryId: string,
): Promise<OrchestrationResult> {
    const orchestrationStart = Date.now();

    // ── Authenticate user ───────────────────────────────────────────────

    const { userId: clerkId } = await auth();

    if (!clerkId) {
        throw new Error("Unauthorized. Please sign in.");
    }

    const user = await prisma.user.findUnique({
        where: { clerkId },
        select: { id: true },
    });

    if (!user) {
        throw new Error("User not found.");
    }

    // ── Resolve repository + verify ownership ───────────────────────────

    const repo = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repositoryId }, { repositoryId }],
            userId: user.id,
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
        throw new Error(`Repository "${repositoryId}" not found or you do not have access.`);
    }

    // Resolve installationId
    const installationId = repo.user?.githubInstallationId;

    if (!installationId) {
        throw new Error("No GitHub installation ID available for this repository.");
    }

    // ── Parse archetypes ────────────────────────────────────────────────

    const archetypes: Archetype[] = Array.isArray(repo.archetypes)
        ? (repo.archetypes as unknown as Archetype[])
        : [];

    if (archetypes.length === 0) {
        throw new Error("No archetypes found. Run business classification first.");
    }

    // ── Upsert pending rows ─────────────────────────────────────────────

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
    }

    // ── Dispatch all agents sequentially ────────────────────────────────

    const summaries: AgentSummary[] = [];

    for (const arch of archetypes) {
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
            summaries.push({
                archetype: arch.name,
                status: "failed",
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: errorMsg,
            });
            continue;
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

        try {
            const result = await runner({
                repositoryId: repo.repositoryId,
                installationId,
                archetypeScore: arch.score,
            });

            // Update database with result
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
                summaries.push({
                    archetype: arch.name,
                    status: "failed",
                    totalToolCalls: result.totalToolCalls,
                    executionTimeMs: result.executionTimeMs,
                    error: result.error,
                });
                continue;
            }

            summaries.push({
                archetype: arch.name,
                status: "completed",
                totalToolCalls: result.totalToolCalls,
                executionTimeMs: result.executionTimeMs,
            });
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

            summaries.push({
                archetype: arch.name,
                status: "failed",
                totalToolCalls: 0,
                executionTimeMs: 0,
                error: errorMsg,
            });
        }
    }

    const completed = summaries.filter((s) => s.status === "completed").length;
    const failed = summaries.filter((s) => s.status === "failed").length;

    // ── Compile final report ────────────────────────────────────────────

    let compiledReport: string | undefined;
    let reportCompileTimeMs: number | undefined;

    if (completed > 0) {
        try {
            const compilerResult = await runReportCompiler({
                repositoryId: repo.id,
            });

            if (compilerResult.compiledReport) {
                compiledReport = compilerResult.compiledReport;
                reportCompileTimeMs = compilerResult.executionTimeMs;
                console.log(
                    `[orchestrator] Report compiled in ${reportCompileTimeMs}ms ` +
                    `(${compiledReport.length} chars)`,
                );
            } else {
                console.error(
                    `[orchestrator] Report compiler returned empty result:`,
                    compilerResult.error,
                );
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : "Unknown compiler error";
            console.error(`[orchestrator] Report compiler threw:`, errorMsg);
        }
    }

    // ── Return final result ──────────────────────────────────────────────

    return {
        summaries,
        totalAgents: archetypes.length,
        completedAgents: completed,
        failedAgents: failed,
        totalExecutionTimeMs: Date.now() - orchestrationStart,
        compiledReport,
        reportCompileTimeMs,
    };
}
