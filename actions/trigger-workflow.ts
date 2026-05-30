"use server";

import prisma from "@/lib/prisma";
import { checkPackageAndFramework } from "./analysis/repository-analysis";
import { classifyBusinessContext } from "./analysis/business-classification";
import { orchestrateAgents } from "./agents/orchestrator";

export interface TriggerWorkflowResult {
    success: boolean;
    error?: string;
    dbId?: string;
    framework?: string;
    totalAgents?: number;
    completedAgents?: number;
    failedAgents?: number;
    hasCompiledReport?: boolean;
}

/**
 * Server action that runs the full analysis pipeline:
 * 1. Framework detection
 * 2. Business classification
 * 3. Agent orchestration + report compilation
 *
 * Returns the database UUID (`dbId`) so the client can navigate to /project/{dbId}.
 */
export async function triggerWorkflow(
    repositoryId: string,
    repoFullName: string,
): Promise<TriggerWorkflowResult> {
    try {
        // Step 1: Framework analysis
        const frameworkResult = await checkPackageAndFramework(
            repositoryId,
            repoFullName,
        );

        if (!frameworkResult.isSupported) {
            return {
                success: false,
                error: frameworkResult.error || "Unsupported framework",
            };
        }

        // Resolve the database UUID for this repository
        const dbRepo = await prisma.repository.findUnique({
            where: { repositoryId },
            select: { id: true },
        });

        if (!dbRepo) {
            return {
                success: false,
                error: "Repository record not found after framework analysis.",
            };
        }

        // Step 2: Business classification
        const classResult = await classifyBusinessContext(repositoryId);

        if (!classResult.classification) {
            return {
                success: false,
                dbId: dbRepo.id,
                error: classResult.error || "Classification failed",
            };
        }

        // Step 3: Agent orchestration + report compilation
        const orchestrationResult = await orchestrateAgents(repositoryId);

        return {
            success: true,
            dbId: dbRepo.id,
            framework: frameworkResult.framework || undefined,
            totalAgents: orchestrationResult.totalAgents,
            completedAgents: orchestrationResult.completedAgents,
            failedAgents: orchestrationResult.failedAgents,
            hasCompiledReport: !!orchestrationResult.compiledReport,
        };
    } catch (error) {
        console.error("[triggerWorkflow] Pipeline error:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
