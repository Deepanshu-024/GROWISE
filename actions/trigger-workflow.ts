"use server";

import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { checkPackageAndFramework } from "./analysis/repository-analysis";
import { inngest } from "@/inngest/client";

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
 * Server action that runs the framework detection and delegates
 * the heavy analysis phases to an Inngest background worker.
 *
 * Returns the database UUID (`dbId`) so the client can navigate to /project/{dbId} instantly.
 */
export async function triggerWorkflow(
    repositoryId: string,
    repoFullName: string,
): Promise<TriggerWorkflowResult> {
    try {
        const { userId: clerkId } = await auth();
        if (!clerkId) {
            return {
                success: false,
                error: "Unauthorized",
            };
        }

        // Step 1: Framework analysis (Synchronous)
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

        // Trigger the Inngest background job for the remaining heavy analysis steps
        console.log(`[triggerWorkflow] 📡 Dispatching workflow/trigger background job to Inngest for repo ${repositoryId}`);
        await inngest.send({
            name: "workflow/trigger",
            data: {
                repositoryId,
                clerkId,
            },
        });

        return {
            success: true,
            dbId: dbRepo.id,
            framework: frameworkResult.framework || undefined,
        };
    } catch (error) {
        console.error("[triggerWorkflow] Pipeline error:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
