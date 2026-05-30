"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

export interface ReportedRepo {
    id: string;
    name: string;
    fullName: string;
    compiledReportAt: string | null;
}

/**
 * Fetches repositories that have a compiled report for the current user.
 */
export async function getReportedRepos(): Promise<ReportedRepo[]> {
    const { userId: clerkId } = await auth();

    if (!clerkId) return [];

    const user = await prisma.user.findUnique({
        where: { clerkId },
        select: { id: true },
    });

    if (!user) return [];

    const repos = await prisma.repository.findMany({
        where: {
            userId: user.id,
            compiledReport: { not: null },
        },
        select: {
            id: true,
            name: true,
            fullName: true,
            compiledReportAt: true,
        },
        orderBy: { compiledReportAt: "desc" },
    });

    return repos.map((r) => ({
        id: r.id,
        name: r.name,
        fullName: r.fullName,
        compiledReportAt: r.compiledReportAt?.toISOString() ?? null,
    }));
}
