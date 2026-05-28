"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { generateInstallationToken } from "@/lib/github";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { isNextOrReactPrompt } from "../../prompts/frameworkPrompt";

const MAX_PROJECT_SIZE = 1000000; // 100MB in KB
const MAX_SEARCH_DEPTH = 3; // Maximum depth to search for package.json

/**
 * Recursively search for package.json in repository directories
 * Uses breadth-first search to find the shallowest package.json first
 */
async function findPackageJsonRecursively(
    repoFullName: string,
    authToken: string,
    currentPath: string = "",
    maxDepth: number = MAX_SEARCH_DEPTH
): Promise<{ packageJson: any; path: string; directoryContents: string[] } | null> {
    console.log(`[SERVER] 🔍 Searching for package.json at depth 0 (root)...`);

    // Use a queue for breadth-first search: [path, depth]
    const queue: Array<{ path: string; depth: number }> = [{ path: currentPath, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
        const { path, depth } = queue.shift()!;

        // Skip if already visited
        if (visited.has(path)) continue;
        visited.add(path);

        const displayPath = path || "root";
        console.log(`[SERVER] 📂 Checking directory: ${displayPath} (depth: ${depth})`);

        try {
            // Fetch directory contents
            const url = path
                ? `https://api.github.com/repos/${repoFullName}/contents/${path}`
                : `https://api.github.com/repos/${repoFullName}/contents`;

            const response = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${authToken}`,
                    Accept: "application/vnd.github.v3+json",
                    "User-Agent": "Lovable-Clone-App",
                },
            });

            if (!response.ok) {
                console.log(`[SERVER] ⚠️ Failed to fetch contents of ${displayPath}`);
                continue;
            }

            const contents = await response.json();

            // Check if package.json exists in current directory
            const packageJsonFile = contents.find(
                (item: any) => item.type === "file" && item.name === "package.json"
            );

            if (packageJsonFile) {
                console.log(`[SERVER] ✅ Found package.json at: ${displayPath}`);

                // Fetch and parse package.json
                const packageJsonResponse = await fetch(packageJsonFile.url, {
                    headers: {
                        Authorization: `Bearer ${authToken}`,
                        Accept: "application/vnd.github.v3+json",
                        "User-Agent": "Lovable-Clone-App",
                    },
                });

                if (packageJsonResponse.ok) {
                    const packageJsonData = await packageJsonResponse.json();

                    if (packageJsonData.content && packageJsonData.encoding === "base64") {
                        const decoded = Buffer.from(packageJsonData.content, "base64").toString("utf-8");
                        const packageJson = JSON.parse(decoded);
                        console.log(`[SERVER] ✅ Successfully parsed package.json from ${displayPath}`);
                        console.log(`[SERVER] Package name: ${packageJson.name || "N/A"}`);

                        // Fetch the FULL recursive file tree (not just this directory)
                        let fullTree: string[] = [];
                        try {
                            const treeUrl = `https://api.github.com/repos/${repoFullName}/git/trees/HEAD?recursive=1`;
                            const treeResponse = await fetch(treeUrl, {
                                headers: {
                                    Authorization: `Bearer ${authToken}`,
                                    Accept: "application/vnd.github.v3+json",
                                    "User-Agent": "Lovable-Clone-App",
                                },
                            });

                            if (treeResponse.ok) {
                                const treeData = await treeResponse.json();
                                // console.log("treeData", treeData);
                                // Only include blobs (files), not tree entries (directories)
                                fullTree = treeData.tree
                                    .filter((node: any) => node.type === "blob")
                                    .map((node: any) => node.path);
                                console.log(`[SERVER] 🌳 Full repo tree: ${fullTree.length} files`);
                            } else {
                                console.warn(`[SERVER] ⚠️ Tree API returned ${treeResponse.status}, falling back to directory listing`);
                                fullTree = contents.map((item: any) => item.name);
                            }
                        } catch (treeError) {
                            console.warn("[SERVER] ⚠️ Tree API failed, falling back to directory listing:", treeError);
                            fullTree = contents.map((item: any) => item.name);
                        }

                        return {
                            packageJson,
                            path: path || "root",
                            directoryContents: fullTree,
                        };
                    }
                }
            }

            // If not found and we haven't reached max depth, add subdirectories to queue
            if (depth < maxDepth) {
                const directories = contents.filter((item: any) => item.type === "dir");
                console.log(`[SERVER] 📁 Found ${directories.length} subdirectories in ${displayPath}`);

                // Sort directories alphabetically for consistent behavior
                directories.sort((a: any, b: any) => a.name.localeCompare(b.name));

                for (const dir of directories) {
                    const newPath = path ? `${path}/${dir.name}` : dir.name;
                    queue.push({ path: newPath, depth: depth + 1 });
                }
            }
        } catch (error) {
            console.error(`[SERVER] ❌ Error searching ${displayPath}:`, error);
            continue;
        }
    }

    console.log(`[SERVER] ❌ No package.json found after searching ${visited.size} directories`);
    return null;
}

interface FrameworkAnalysisResult {
    isSupported: boolean;
    framework: "next" | "react" | "";
    error?: string;
    repoContent?: string[];
    packageJson?: any;
    defaultBranch?: string;
    baseDirectory?: string; // Path to directory containing package.json
    repoSizeKB?: number;    // GitHub-reported repo size in KB
}

export async function checkPackageAndFramework(
    repositoryId: string,
    repoFullName: string,
    installationId?: string
): Promise<FrameworkAnalysisResult> {
    console.log("\n[SERVER] 🔍 Starting framework analysis...");
    console.log(`[SERVER] Repository: ${repoFullName}`);
    console.log(`[SERVER] Repository ID: ${repositoryId}`);
    console.log(`[SERVER] Installation ID provided: ${installationId || "No"}`);

    try {
        const { userId: clerkId } = await auth();
        console.log(`[SERVER] ✅ User authenticated: ${clerkId}`);

        if (!clerkId) {
            return { isSupported: false, framework: "", error: "Unauthorized" };
        }

        if (!repositoryId || !repoFullName) {
            return {
                isSupported: false,
                framework: "",
                error: "Missing required repository information",
            };
        }

        // Check if we already have analysis results in the database
        console.log("[SERVER] 🔍 Checking for existing analysis in database...");
        const existingRepo = await prisma.repository.findUnique({
            where: { repositoryId: repositoryId },
            select: {
                framework: true,
                isSupported: true,
                packageJson: true,
                defaultBranch: true,
                baseDirectory: true,
                repoContent: true,
            },
        });

        if (existingRepo && existingRepo.framework) {
            console.log(`[SERVER] ✅ Found existing analysis with framework: ${existingRepo.framework}`);
            console.log("[SERVER] 🎯 Returning cached results from database");
            return {
                isSupported: existingRepo.isSupported,
                framework: existingRepo.framework as "next" | "react" | "",
                packageJson: existingRepo.packageJson,
                defaultBranch: existingRepo.defaultBranch || undefined,
                baseDirectory: existingRepo.baseDirectory || undefined,
                repoContent: existingRepo.repoContent as string[] | undefined,
                repoSizeKB: (existingRepo as any).repoSizeKB ?? undefined,
            };
        }

        console.log("[SERVER] ℹ️ No existing analysis found or framework not determined, proceeding with fresh analysis...");

        // Get authentication token
        console.log("[SERVER] 🔑 Fetching GitHub authentication token...");
        let authToken: string;
        let effectiveInstallationId = installationId;

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
            return {
                isSupported: false,
                framework: "",
                error: "User not found.",
            };
        }

        const dbUserId = user.id;

        // If installation ID not provided, fetch from database
        if (!effectiveInstallationId) {
            if (!user.githubInstallationId) {
                console.log("[SERVER] ❌ No GitHub installation ID found in database");
                return {
                    isSupported: false,
                    framework: "",
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

        // Get repository info to fetch default branch and size
        console.log("[SERVER] 📊 Fetching repository information...");
        let defaultBranch: string | null = null;
        let repoSizeKB: number | null = null;

        try {
            const repoInfoResponse = await fetch(
                `https://api.github.com/repos/${repoFullName}`,
                {
                    headers: {
                        Authorization: `Bearer ${authToken}`,
                        Accept: "application/vnd.github.v3+json",
                        "User-Agent": "Lovable-Clone-App",
                    },
                }
            );

            if (!repoInfoResponse.ok) {
                console.log("[SERVER] ❌ Failed to fetch repository information");
                return { isSupported: false, framework: "", error: "Failed to fetch repository information" };
            }

            const repoInfo = await repoInfoResponse.json();
            console.log(`[SERVER] Repository size: ${repoInfo.size} KB`);

            if (repoInfo.size > MAX_PROJECT_SIZE) {
                console.log(`[SERVER] ❌ Repository too large: ${repoInfo.size} KB > ${MAX_PROJECT_SIZE} KB`);
                return {
                    isSupported: false,
                    framework: "",
                    error: "Repository size is too large",
                };
            }

            defaultBranch = repoInfo.default_branch;
            repoSizeKB = repoInfo.size as number;
            console.log(`[SERVER] ✅ Default branch: ${defaultBranch}`);

            // Persist repoSizeKB immediately — before framework detection
            console.log(`[SERVER] 💾 Storing repo size (${repoSizeKB} KB) to database...`);
            const [earlyOwner, earlyRepoName] = repoFullName.split("/");
            await prisma.repository.upsert({
                where: { repositoryId: repositoryId },
                update: { repoSizeKB },
                create: {
                    repositoryId,
                    name: earlyRepoName,
                    fullName: repoFullName,
                    owner: earlyOwner,
                    repoSizeKB,
                    userId: dbUserId,
                },
            });
            console.log(`[SERVER] ✅ Repo size stored`);
        } catch (error) {
            console.error("[SERVER] ❌ Error fetching repository info:", error);
            return { isSupported: false, framework: "", error: "Failed to fetch repository information" };
        }

        // Get package.json using recursive search
        console.log("[SERVER] 📦 Searching for package.json recursively...");
        let packageJson: any = null;
        let baseDirectory: string = "root";
        let repoContent: string[] | null = null;

        try {
            const result = await findPackageJsonRecursively(repoFullName, authToken);

            if (result) {
                packageJson = result.packageJson;
                baseDirectory = result.path;
                repoContent = result.directoryContents;
                console.log(`[SERVER] ✅ package.json found at: ${baseDirectory}`);
                console.log(`[SERVER] 📁 Using directory contents from: ${baseDirectory}`);
                console.log("[SERVER] Dependencies:", Object.keys(packageJson.dependencies || {}).slice(0, 5).join(", "));
            } else {
                console.log("[SERVER] ❌ No package.json found in repository");
                return {
                    isSupported: false,
                    framework: "",
                    error: "No package.json found in repository (searched up to 3 levels deep)"
                };
            }
        } catch (error) {
            console.error("[SERVER] ❌ Error during recursive package.json search:", error);
            return {
                isSupported: false,
                framework: "",
                error: "Failed to search for package.json"
            };
        }

        // Check if the project is a react or next project using LangChain
        console.log("[SERVER] 🤖 Analyzing with LLM...");
        const template = isNextOrReactPrompt;
        const prompt = PromptTemplate.fromTemplate(template);
        const chain = prompt.pipe(gpt4oMini).pipe(new StringOutputParser());

        const result = await chain.invoke({
            repoContent: JSON.stringify(repoContent),
            packageJson: JSON.stringify(packageJson),
        });

        console.log("[SERVER] 🤖 LLM Response:", result);

        const resultObject = JSON.parse(result);
        console.log("\n[SERVER] 🎯 FINAL RESULT:");
        console.log(`[SERVER] Is Supported: ${resultObject.isSupported}`);
        console.log(`[SERVER] Framework: ${resultObject.framework || "NONE"}`);
        console.log(`[SERVER] Repo Content:`, repoContent);
        console.log(`[SERVER] Package.json name:`, packageJson?.name);

        // Save to database
        console.log("[SERVER] 💾 Saving analysis results to database...");
        try {
            const [owner, repoName] = repoFullName.split("/");

            const savedRepository = await prisma.repository.upsert({
                where: {
                    repositoryId: repositoryId,
                },
                update: {
                    name: repoName,
                    fullName: repoFullName,
                    owner: owner,
                    isSupported: resultObject.isSupported,
                    framework: resultObject.framework || null,
                    packageJson: packageJson || null,
                    defaultBranch: defaultBranch || null,
                    baseDirectory: baseDirectory,
                    repoContent: repoContent || null,
                    repoSizeKB: repoSizeKB ?? undefined,
                    updatedAt: new Date(),
                },
                create: {
                    repositoryId: repositoryId,
                    name: repoName,
                    fullName: repoFullName,
                    owner: owner,
                    isSupported: resultObject.isSupported,
                    framework: resultObject.framework || null,
                    packageJson: packageJson || null,
                    defaultBranch: defaultBranch || null,
                    baseDirectory: baseDirectory,
                    repoContent: repoContent || null,
                    repoSizeKB: repoSizeKB ?? undefined,
                    userId: dbUserId,
                },
            });

            console.log(`[SERVER] ✅ Repository saved to database with ID: ${savedRepository.id}`);
        } catch (dbError) {
            console.error("[SERVER] ❌ Error saving to database:", dbError);
            // Don't fail the entire operation if database save fails
        }

        console.log("[SERVER] ✅ Analysis complete\n");

        return {
            isSupported: resultObject.isSupported,
            framework: resultObject.framework,
            repoContent: repoContent || undefined,
            packageJson: packageJson,
            defaultBranch: defaultBranch || undefined,
            baseDirectory: baseDirectory,
            repoSizeKB: repoSizeKB ?? undefined,
        };
    } catch (error) {
        console.error("\n[SERVER] ❌ ERROR in checkPackageAndFramework:");
        console.error("[SERVER] Error details:", error);
        console.error("[SERVER] Stack trace:", error instanceof Error ? error.stack : "N/A");
        return {
            isSupported: false,
            framework: "",
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
}
