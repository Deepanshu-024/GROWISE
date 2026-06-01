/* eslint-disable @typescript-eslint/no-explicit-any */

import prisma from "@/lib/prisma";

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

export interface AgentSummary {
    archetype: string;
    status: "completed" | "failed";
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

export interface Archetype {
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
    userId?: string;
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
            userId: input.userId,
        }),
    "compute-heavy": (input) =>
        runComputeHeavyAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
    "ai-powered": (input) =>
        runAiPoweredAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
    "realtime": (input) =>
        runRealtimeAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
    "event-driven": (input) =>
        runEventDrivenAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
    "financial-transactional": (input) =>
        runTransactionAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
    "auth-heavy": (input) =>
        runAuthAgent(input.repositoryId, input.installationId, input.userId) as any,
    "content-heavy": (input) =>
        runContentHeavyAgent({
            repositoryId: input.repositoryId,
            installationId: input.installationId,
            userId: input.userId,
        }),
};

// ─── Orchestrator Helper Functions ──────────────────────────────────────────

export interface OrchestrationContext {
    repoDbId: string;
    repoGithubId: string;
    userId: string;
    installationId: string;
    archetypes: Archetype[];
}

export async function resolveOrchestrationContext(
    repositoryId: string,
    clerkId: string,
): Promise<OrchestrationContext> {
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

    const repo = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repositoryId }, { repositoryId }],
            userId: user.id,
        },
        select: {
            id: true,
            repositoryId: true,
            userId: true,
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

    const installationId = repo.user?.githubInstallationId;

    if (!installationId) {
        throw new Error("No GitHub installation ID available for this repository.");
    }

    const archetypes: Archetype[] = Array.isArray(repo.archetypes)
        ? (repo.archetypes as unknown as Archetype[])
        : [];

    if (archetypes.length === 0) {
        throw new Error("No archetypes found. Run business classification first.");
    }

    return {
        repoDbId: repo.id,
        repoGithubId: repo.repositoryId,
        userId: repo.userId,
        installationId,
        archetypes,
    };
}

export async function runSingleAgent(
    repoDbId: string,
    repoUserId: string,
    installationId: string,
    archName: string,
    archScore: number,
): Promise<AgentSummary> {
    const runner = ARCHETYPE_RUNNERS[archName];
    if (!runner) {
        const errorMsg = `No runner found for archetype "${archName}"`;
        console.warn(`[orchestrator] ${errorMsg}`);
        await prisma.agentReport.update({
            where: {
                repositoryId_archetype: {
                    repositoryId: repoDbId,
                    archetype: archName,
                },
            },
            data: { status: "failed", error: errorMsg },
        });
        return {
            archetype: archName,
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
                repositoryId: repoDbId,
                archetype: archName,
            },
        },
        data: { status: "running" },
    });

    try {
        const result = await runner({
            repositoryId: repoDbId,
            installationId,
            archetypeScore: archScore,
            userId: repoUserId,
        });

        // Update database with result
        await prisma.agentReport.update({
            where: {
                repositoryId_archetype: {
                    repositoryId: repoDbId,
                    archetype: archName,
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
            return {
                archetype: archName,
                status: "failed",
                totalToolCalls: result.totalToolCalls,
                executionTimeMs: result.executionTimeMs,
                error: result.error,
            };
        }

        return {
            archetype: archName,
            status: "completed",
            totalToolCalls: result.totalToolCalls,
            executionTimeMs: result.executionTimeMs,
        };
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[orchestrator] Agent "${archName}" threw:`, errorMsg);

        await prisma.agentReport.update({
            where: {
                repositoryId_archetype: {
                    repositoryId: repoDbId,
                    archetype: archName,
                },
            },
            data: {
                status: "failed",
                error: errorMsg,
            },
        });

        return {
            archetype: archName,
            status: "failed",
            totalToolCalls: 0,
            executionTimeMs: 0,
            error: errorMsg,
        };
    }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function orchestrateAgents(
    repositoryId: string,
    clerkId: string,
): Promise<OrchestrationResult> {
    const orchestrationStart = Date.now();

    const context = await resolveOrchestrationContext(repositoryId, clerkId);

    // ── Upsert pending rows ─────────────────────────────────────────────

    for (const arch of context.archetypes) {
        await prisma.agentReport.upsert({
            where: {
                repositoryId_archetype: {
                    repositoryId: context.repoDbId,
                    archetype: arch.name,
                },
            },
            create: {
                repositoryId: context.repoDbId,
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

    for (const arch of context.archetypes) {
        const summary = await runSingleAgent(
            context.repoDbId,
            context.userId,
            context.installationId,
            arch.name,
            arch.score,
        );
        summaries.push(summary);
    }

    const completed = summaries.filter((s) => s.status === "completed").length;
    const failed = summaries.filter((s) => s.status === "failed").length;

    // ── Compile final report ────────────────────────────────────────────

    let compiledReport: string | undefined;
    let reportCompileTimeMs: number | undefined;

    if (completed > 0) {
        try {
            const compilerResult = await runReportCompiler({
                repositoryId: context.repoDbId,
                userId: context.userId,
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
        totalAgents: context.archetypes.length,
        completedAgents: completed,
        failedAgents: failed,
        totalExecutionTimeMs: Date.now() - orchestrationStart,
        compiledReport,
        reportCompileTimeMs,
    };
}
