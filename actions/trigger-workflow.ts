"use server";

import { checkPackageAndFramework } from "./analysis/repository-analysis";
import { classifyBusinessContext } from "./analysis/business-classification";
import { orchestrateAgents } from "./agents/orchestrator";

export interface TriggerWorkflowResult {
    success: boolean;
    error?: string;
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

        // Step 2: Business classification
        const classResult = await classifyBusinessContext(repositoryId);

        if (!classResult.classification) {
            return {
                success: false,
                error: classResult.error || "Classification failed",
            };
        }

        // Step 3: Agent orchestration + report compilation
        const orchestrationResult = await orchestrateAgents(repositoryId);

        return {
            success: true,
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
