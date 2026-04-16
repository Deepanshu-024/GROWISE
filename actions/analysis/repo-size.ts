"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { generateInstallationToken } from "@/lib/github";

export interface RepoSizeResult {
    sizeKB: number | null;
    error?: string;
}

/**
 * Fetches the repo size from GitHub and persists it to the Repository row.
 * Works for both new and existing repositories.
 */
export async function fetchAndStoreRepoSize(
    repositoryId: string,
    repoFullName: string,
): Promise<RepoSizeResult> {
    const { userId } = await auth();
    if (!userId) return { sizeKB: null, error: "Unauthorized" };

    try {
        // Get the user's installation ID
        const user = await prisma.user.findUnique({
            where: { clerkId: userId },
            select: { githubInstallationId: true },
        });

        if (!user?.githubInstallationId) {
            return { sizeKB: null, error: "GitHub App not connected" };
        }

        const { token } = await generateInstallationToken(user.githubInstallationId);

        const response = await fetch(`https://api.github.com/repos/${repoFullName}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json",
                "User-Agent": "Lovable-Clone-App",
            },
        });

        if (!response.ok) {
            return { sizeKB: null, error: "Failed to reach GitHub API" };
        }

        const repoInfo = await response.json();
        const sizeKB: number = repoInfo.size;

        // Upsert — works for both existing and new repository rows
        const [owner, name] = repoFullName.split("/");
        await prisma.repository.upsert({
            where: { repositoryId },
            update: { repoSizeKB: sizeKB },
            create: {
                repositoryId,
                name,
                fullName: repoFullName,
                owner,
                repoSizeKB: sizeKB,
                userId,
            },
        });

        return { sizeKB };
    } catch (err) {
        console.error("[fetchAndStoreRepoSize]", err);
        return {
            sizeKB: null,
            error: err instanceof Error ? err.message : "Unknown error",
        };
    }
}
