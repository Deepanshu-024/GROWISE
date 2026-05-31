"use server";

import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { checkPackageAndFramework } from "./analysis/repository-analysis";
import { inngest } from "@/inngest/client";
import { getAnalysisUsage } from "./get-analysis-usage";

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

        // Get the internal user ID from database using Clerk ID
        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true },
        });

        if (!user) {
            return {
                success: false,
                error: "User not found in database.",
            };
        }

        const dbUserId = user.id;

        // Check if repository already exists for this user and what its compilation status is
        const existingRepo = await prisma.repository.findUnique({
            where: {
                userId_repositoryId: {
                    userId: dbUserId,
                    repositoryId: repositoryId,
                }
            },
            select: { id: true, compiledReport: true },
        });

        if (existingRepo && existingRepo.compiledReport === "COMPILING") {
            return {
                success: false,
                error: "Analysis is already in progress for this repository.",
            };
        }

        // If repository is new or has a null report (i.e. not yet counted as used),
        // check user limits before proceeding.
        if (!existingRepo || !existingRepo.compiledReport) {
            const usage = await getAnalysisUsage();
            if (usage.remaining <= 0) {
                return {
                    success: false,
                    error: "Generation limit reached (2/2 used). Pro plans are coming soon.",
                };
            }
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
            where: {
                userId_repositoryId: {
                    userId: dbUserId,
                    repositoryId: repositoryId,
                }
            },
            select: { id: true },
        });

        if (!dbRepo) {
            return {
                success: false,
                error: "Repository record not found after framework analysis.",
            };
        }

        // Set the status to COMPILING immediately to reserve the slot
        await prisma.repository.update({
            where: {
                userId_repositoryId: {
                    userId: dbUserId,
                    repositoryId: repositoryId,
                }
            },
            data: {
                compiledReport: "COMPILING",
                compiledReportAt: null,
            },
        });

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
