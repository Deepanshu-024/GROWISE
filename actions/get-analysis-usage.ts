"use server";

import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

const MAX_FREE_ANALYSES = 2;

export interface AnalysisUsage {
    used: number;
    limit: number;
    remaining: number;
}

/**
 * Returns how many repos the current user has analyzed (has a compiledReport).
 */
export async function getAnalysisUsage(): Promise<AnalysisUsage> {
    const { userId: clerkId } = await auth();

    if (!clerkId) {
        return { used: 0, limit: MAX_FREE_ANALYSES, remaining: MAX_FREE_ANALYSES };
    }

    const user = await prisma.user.findUnique({
        where: { clerkId },
        select: { id: true },
    });

    if (!user) {
        return { used: 0, limit: MAX_FREE_ANALYSES, remaining: MAX_FREE_ANALYSES };
    }

    const analyzedCount = await prisma.repository.count({
        where: {
            userId: user.id,
            compiledReport: { not: null },
        },
    });

    return {
        used: analyzedCount,
        limit: MAX_FREE_ANALYSES,
        remaining: Math.max(0, MAX_FREE_ANALYSES - analyzedCount),
    };
}
