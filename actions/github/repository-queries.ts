"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

/**
 * Get all repositories for the current user
 */
export async function getUserRepositories() {
    const { userId } = await auth();

    if (!userId) {
        throw new Error("Unauthorized");
    }

    const repositories = await prisma.repository.findMany({
        where: {
            userId: userId,
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
    const { userId } = await auth();

    if (!userId) {
        throw new Error("Unauthorized");
    }

    const repository = await prisma.repository.findFirst({
        where: {
            repositoryId: repositoryId,
            userId: userId,
        },
    });

    return repository;
}

/**
 * Delete a repository from the database
 */
export async function deleteRepository(repositoryId: string) {
    const { userId } = await auth();

    if (!userId) {
        throw new Error("Unauthorized");
    }

    await prisma.repository.delete({
        where: {
            repositoryId: repositoryId,
            userId: userId,
        },
    });

    return { success: true };
}
