"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { getInstallationRepositories } from "@/lib/github";

export async function getGithubConnectionStatus() {
    const { userId } = await auth();

    if (!userId) {
        throw new Error("Unauthorized");
    }

    const user = await prisma.user.findUnique({
        where: { clerkId: userId },
        select: { githubInstallationId: true, githubUsername: true },
    });

    return {
        githubInstallationId: user?.githubInstallationId || null,
        githubUsername: user?.githubUsername || null,
    };
}

export async function fetchInstallationRepositoriesAction(installationId: string) {
    const { userId } = await auth();

    if (!userId) {
        throw new Error("Unauthorized");
    }

    // Verify ownership: ensure this installation ID matches the user's saved ID
    const user = await prisma.user.findUnique({
        where: { clerkId: userId },
        select: { githubInstallationId: true },
    });

    if (!user || user.githubInstallationId !== installationId) {
        throw new Error("Unauthorized access to GitHub installation");
    }

    return await getInstallationRepositories(installationId);
}
