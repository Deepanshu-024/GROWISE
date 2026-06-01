"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

async function authenticateUser() {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
        throw new Error("Unauthorized");
    }

    const user = await prisma.user.findUnique({
        where: { clerkId },
        select: { id: true, githubInstallationId: true },
    });

    if (!user) throw new Error("User not found");

    return user;
}

/**
 * Get all repositories for the current user
 */
export async function getUserRepositories() {
    const user = await authenticateUser();

    const repositories = await prisma.repository.findMany({
        where: {
            userId: user.id,
        },
        orderBy: {
            updatedAt: "desc",
        },
    });

    return repositories;
}

/**
 * Get a specific repository by GitHub repository ID
 */
export async function getRepositoryById(repositoryId: string) {
    const user = await authenticateUser();

    const repository = await prisma.repository.findFirst({
        where: {
            repositoryId: repositoryId,
            userId: user.id,
        },
    });

    return repository;
}

/**
 * Get repository data needed by the project page.
 * Accepts either the internal repository UUID or GitHub repository ID.
 */
export async function getRepositoryWithReport(repoId: string) {
    const user = await authenticateUser();

    if (!user.githubInstallationId) {
        throw new Error("GitHub not connected. Please connect your GitHub account from the dashboard.");
    }

    const repository = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repoId }, { repositoryId: repoId }],
            userId: user.id,
        },
        select: {
            id: true,
            repositoryId: true,
            name: true,
            fullName: true,
            framework: true,
            archetypes: true,
            archClassificationConfidence: true,
            repoSizeKB: true,
            compiledReport: true,
            compiledReportAt: true,
            updatedAt: true,
        },
    });

    if (!repository) throw new Error(`Repository "${repoId}" not found`);

    return {
        ...repository,
        archetypes: repository.archetypes as { name: string; score: number }[] | null,
        compiledReportAt: repository.compiledReportAt?.toISOString() ?? null,
        updatedAt: repository.updatedAt.toISOString(),
    };
}

/**
 * Get repository metadata and raw agent reports for the reports page.
 * Accepts either the internal repository UUID or GitHub repository ID.
 */
export async function getRepositoryWithAgentReports(repoId: string) {
    const user = await authenticateUser();

    const repository = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repoId }, { repositoryId: repoId }],
            userId: user.id,
        },
        select: {
            id: true,
            repositoryId: true,
            name: true,
            fullName: true,
            framework: true,
            archetypes: true,
            archClassificationConfidence: true,
            repoSizeKB: true,
            compiledReport: true,
            compiledReportAt: true,
            updatedAt: true,
            agentReports: {
                orderBy: { updatedAt: "desc" },
            },
        },
    });

    if (!repository) throw new Error(`Repository "${repoId}" not found`);

    const { agentReports, ...repo } = repository;

    return {
        repository: {
            ...repo,
            archetypes: repo.archetypes as { name: string; score: number }[] | null,
            compiledReportAt: repo.compiledReportAt?.toISOString() ?? null,
            updatedAt: repo.updatedAt.toISOString(),
        },
        reports: agentReports.map((report) => ({
            ...report,
            createdAt: report.createdAt.toISOString(),
            updatedAt: report.updatedAt.toISOString(),
        })),
    };
}

/**
 * Check whether the authenticated user's repository already has reports.
 * Accepts either the internal repository UUID or GitHub repository ID.
 */
export async function checkRepositoryReportStatus(repoId: string) {
    const user = await authenticateUser();

    const repository = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repoId }, { repositoryId: repoId }],
            userId: user.id,
        },
        select: {
            compiledReport: true,
            agentReports: {
                where: {
                    status: "completed",
                    rawFindings: { not: null },
                },
                select: { id: true },
                take: 1,
            },
        },
    });

    if (!repository) {
        return {
            hasReports: false,
            hasCompiledReport: false,
        };
    }

    return {
        hasReports: repository.agentReports.length > 0,
        hasCompiledReport: !!repository.compiledReport,
    };
}

/**
 * Delete a repository from the database
 */
export async function deleteRepository(repositoryId: string) {
    const user = await authenticateUser();

    await prisma.repository.delete({
        where: {
            userId_repositoryId: {
                userId: user.id,
                repositoryId: repositoryId,
            }
        },
    });

    return { success: true };
}
