"use server";

import prisma from "@/lib/prisma";
import { getInstallationToken } from "@/lib/github";
import { gpt5Mini } from "@/lib/llm";
import { businessClassificationPrompt } from "../../prompts/bussinessClassification";
import { getFileContentTool, getRepoTreeTool, searchCodeTool } from "./tools/agent-tools";
import { createAgent } from "langchain";
import { z } from "zod";

// Zod schema for structured output - Engineering Archetype Classification
const BusinessClassificationSchema = z.object({
    archetypes: z.array(
        z.object({
            name: z.enum([
                "database-heavy",
                "compute-heavy",
                "ai-powered",
                "realtime",
                "event-driven",
                "financial-transactional",
                "auth-heavy",
                "content-heavy"
            ]),
            score: z.number().min(0).max(1),
        })
    ),
    confidence: z.enum(["high", "medium", "low"]),
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
    installationId: string | undefined,
    clerkId: string
): Promise<ClassificationResponse> {
    console.log("\n[SERVER] 🏢 Starting business classification analysis...");
    console.log(`[SERVER] Repository ID: ${repositoryId}`);
    console.log(`[SERVER] Installation ID provided: ${installationId || "No"}`);
    console.log(`[SERVER] Clerk ID provided: ${clerkId}`);

    try {
        if (!clerkId) {
            return { error: "Unauthorized" };
        }
        console.log(`[SERVER] ✅ User authenticated: ${clerkId}`);

        // Look up the internal user ID from the Clerk ID
        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: {
                id: true,
                githubInstallationId: true,
            },
        });

        if (!user) {
            console.log("[SERVER] ❌ User not found in database");
            return { error: "User not found." };
        }

        const dbUserId = user.id;

        // Fetch repository data from database
        console.log("[SERVER] 📊 Fetching repository data from database...");
        const repository = await prisma.repository.findUnique({
            where: {
                userId_repositoryId: {
                    userId: dbUserId,
                    repositoryId: repositoryId,
                }
            },
            select: {
                fullName: true,
                framework: true,
                packageJson: true,
                repoContent: true,
                defaultBranch: true,
                baseDirectory: true,
                isSupported: true,
                archetypes: true,
                archClassificationConfidence: true,
            },
        });

        if (!repository) {
            return { error: "Repository not found in database" };
        }

        if (!repository.isSupported || !repository.framework) {
            return { error: "Repository framework not analyzed yet. Please run framework analysis first." };
        }

        // Skip if classification already exists
        if (repository.archetypes && repository.archClassificationConfidence) {
            console.log("[SERVER] ✅ Classification already exists, skipping LLM call");
            return {
                classification: {
                    archetypes: repository.archetypes as BusinessClassificationResult["archetypes"],
                    confidence: repository.archClassificationConfidence as BusinessClassificationResult["confidence"],
                },
            };
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
        const { token } = await getInstallationToken(effectiveInstallationId);
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
        const agent = createAgent({
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
                    content: `Analyze the repository ${fullName} and classify its engineering niches. Return JSON only.`,
                },
            ],
        });

        console.log("[SERVER] 🤖 LLM Response received");
        console.log("[SERVER] Raw output:", result);

        // Track tool calls
        const toolCalls = result.messages?.filter((msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0) || [];
        const toolCallCount = toolCalls.length;
        console.log(`[SERVER] 🔧 Tool calls made: ${toolCallCount}`);

        if (toolCallCount > 0) {
            console.log("[SERVER] 🔧 Tool usage details:");
            result.messages?.forEach((msg: any, index: number) => {
                if (msg.tool_calls && msg.tool_calls.length > 0) {
                    msg.tool_calls.forEach((toolCall: any) => {
                        console.log(`  - ${toolCall.name || 'Unknown tool'}`);
                    });
                }
            });
        }

        // Get structured response from the agent
        const classificationData = result.structuredResponse as BusinessClassificationResult;

        if (!classificationData) {
            console.error("[SERVER] ❌ No structured response received from agent");
            return { error: "Failed to get structured response from agent. Please try again." };
        }

        console.log("[SERVER] ✅ Classification complete");
        console.log("[SERVER] Confidence:", classificationData.confidence);
        console.log("[SERVER] Archetypes:", classificationData.archetypes.map(a => `${a.name} (${a.score})`).join(", "));

        // Persist classification results to the repository record
        console.log("[SERVER] 💾 Saving classification results to database...");
        await prisma.repository.update({
            where: {
                userId_repositoryId: {
                    userId: dbUserId,
                    repositoryId: repositoryId,
                }
            },
            data: {
                archetypes: classificationData.archetypes,
                archClassificationConfidence: classificationData.confidence,
            },
        });
        console.log("[SERVER] ✅ Classification results saved to database");

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
