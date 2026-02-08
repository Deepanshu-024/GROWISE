"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { generateInstallationToken } from "@/lib/github";
import { gpt5Mini } from "@/lib/llm";
import { businessClassificationPrompt } from "../../prompts/bussinessClassification";
import { getFileContentTool, getRepoTreeTool, searchCodeTool } from "./tools/agent-tools";
import { createAgent } from "langchain";
import { z } from "zod";

// Zod schema for structured output
const BusinessClassificationSchema = z.object({
    businessType: z.object({
        primary: z.string(),
        secondary: z.array(z.string()),
        confidence: z.string(),
    }),
    audienceSize: z.string(),
    usagePattern: z.array(z.string()),
    constraints: z.object({
        latency: z.string(),
        consistency: z.string(),
        failureCost: z.string(),
        security: z.string(),
        compliance: z.string(),
        costSensitivity: z.string(),
    }),
    riskProfile: z.string(),
    scaleBreakpoints: z.object({
        "10k": z.string(),
        "100k": z.string(),
        "1M": z.string(),
    }),
    evidence: z.array(z.string()),
});

// TypeScript type inferred from Zod schema
type BusinessClassificationResult = z.infer<typeof BusinessClassificationSchema>;

interface ClassificationResponse {
    classification?: BusinessClassificationResult;
    error?: string;
}

/**
 * Analyzes a repository to classify its business context and engineering constraints
 * Uses LLM to analyze repository structure and dependencies
 */
export async function classifyBusinessContext(
    repositoryId: string,
    installationId?: string
): Promise<ClassificationResponse> {
    console.log("\n[SERVER] 🏢 Starting business classification analysis...");
    console.log(`[SERVER] Repository ID: ${repositoryId}`);
    console.log(`[SERVER] Installation ID provided: ${installationId || "No"}`);

    try {
        const { userId } = await auth();
        console.log(`[SERVER] ✅ User authenticated: ${userId}`);

        if (!userId) {
            return { error: "Unauthorized" };
        }

        // Fetch repository data from database
        console.log("[SERVER] 📊 Fetching repository data from database...");
        const repository = await prisma.repository.findUnique({
            where: { repositoryId: repositoryId },
            select: {
                fullName: true,
                framework: true,
                packageJson: true,
                repoContent: true,
                defaultBranch: true,
                baseDirectory: true,
                isSupported: true,
            },
        });

        if (!repository) {
            return { error: "Repository not found in database" };
        }

        if (!repository.isSupported || !repository.framework) {
            return { error: "Repository framework not analyzed yet. Please run framework analysis first." };
        }

        const { fullName, framework, packageJson, repoContent, defaultBranch } = repository;

        console.log(`[SERVER] Repository: ${fullName}`);
        console.log(`[SERVER] Framework: ${framework}`);
        console.log(`[SERVER] Default Branch: ${defaultBranch}`);

        // Get authentication token
        console.log("[SERVER] 🔑 Fetching GitHub authentication token...");
        let authToken: string;
        let effectiveInstallationId = installationId;

        // If installation ID not provided, fetch from database
        if (!effectiveInstallationId) {
            console.log("[SERVER] 📊 Fetching installation ID from database...");
            const user = await prisma.user.findUnique({
                where: { clerkId: userId },
                select: {
                    githubInstallationId: true,
                },
            });

            if (!user?.githubInstallationId) {
                console.log("[SERVER] ❌ No GitHub installation ID found in database");
                return {
                    error: "GitHub App not connected. Please connect your GitHub account.",
                };
            }

            effectiveInstallationId = user.githubInstallationId;
            console.log(`[SERVER] ✅ Found installation ID: ${effectiveInstallationId}`);
        }

        // Generate token from GitHub App installation
        console.log("[SERVER] 🎫 Generating installation token...");
        const { token } = await generateInstallationToken(effectiveInstallationId);
        authToken = token;
        console.log("[SERVER] ✅ Token generated successfully");

        // Parse repo owner and name from fullName
        const [owner, repo] = fullName.split("/");

        const repoAnalysisTools = [
            getRepoTreeTool,
            getFileContentTool,
            searchCodeTool
        ];

        console.log("[SERVER] 🤖 Starting LLM classification analysis...");

        // Format the prompt with repository context
        const formattedPrompt = businessClassificationPrompt
            .replace("{repoFullName}", fullName)
            .replace("{framework}", framework || "Unknown")
            .replace("{defaultBranch}", defaultBranch || "main")
            .replace("{packageJson}", JSON.stringify(packageJson, null, 2))
            .replace("{repoContent}", JSON.stringify(repoContent, null, 2))
            .replace(/{owner}/g, owner)
            .replace(/{repo}/g, repo)
            .replace(/{githubAccessToken}/g, authToken)
            .replace(/{defaultBranch}/g, defaultBranch || "main");

        // Create agent with structured output
        const agent = await createAgent({
            model: gpt5Mini,
            tools: repoAnalysisTools,
            systemPrompt: formattedPrompt,
            responseFormat: BusinessClassificationSchema,
        });

        console.log("[SERVER] 🤖 Invoking agent for repository analysis...");

        const result = await agent.invoke({
            messages: [
                {
                    role: "user",
                    content: `Analyze the repository ${fullName} and classify its business context and engineering constraints. Use the provided tools if needed to gather additional information.`,
                },
            ],
        });

        console.log("[SERVER] 🤖 LLM Response received");
        console.log("[SERVER] Raw output:", result);

        // Get structured response from the agent
        const classificationData = result.structuredResponse as BusinessClassificationResult;

        if (!classificationData) {
            console.error("[SERVER] ❌ No structured response received from agent");
            return { error: "Failed to get structured response from agent. Please try again." };
        }

        console.log("[SERVER] ✅ Classification complete");
        console.log("[SERVER] Business Type:", classificationData.businessType.primary);
        console.log("[SERVER] Audience Size:", classificationData.audienceSize);
        console.log("[SERVER] Risk Profile:", classificationData.riskProfile);

        return {
            classification: classificationData,
        };
    } catch (error) {
        console.error("\n[SERVER] ❌ ERROR in classifyBusinessContext:");
        console.error("[SERVER] Error details:", error);
        console.error("[SERVER] Stack trace:", error instanceof Error ? error.stack : "N/A");
        return {
            error: error instanceof Error ? error.message : "Unknown error occurred during classification",
        };
    }
}
