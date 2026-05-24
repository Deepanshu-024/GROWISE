"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

/**
 * Get all repositories for the current user
 */
export async function getUserRepositories() {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
        throw new Error("Unauthorized");
    }

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) throw new Error("User not found");

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
    const { userId: clerkId } = await auth();

    if (!clerkId) {
        throw new Error("Unauthorized");
    }

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) throw new Error("User not found");

    const repository = await prisma.repository.findFirst({
        where: {
            repositoryId: repositoryId,
            userId: user.id,
        },
    });

    return repository;
}

/**
 * Delete a repository from the database
 */
export async function deleteRepository(repositoryId: string) {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
        throw new Error("Unauthorized");
    }

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) throw new Error("User not found");

    await prisma.repository.delete({
        where: {
            repositoryId: repositoryId,
            userId: user.id,
        },
    });

    return { success: true };
}
