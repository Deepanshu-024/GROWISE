import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { getInstallationRepositories } from "@/lib/github";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();

        if (!userId) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        // Fetch user from database
        const user = await prisma.user.findUnique({
            where: { clerkId: userId },
            select: {
                id: true,
                githubInstallationId: true,
            },
        });

        if (!user || !user.githubInstallationId) {
            return NextResponse.json(
                { error: "GitHub not connected" },
                { status: 400 }
            );
        }

        // Fetch repositories from GitHub
        const ghRepos = await getInstallationRepositories(user.githubInstallationId);

        // Cross-reference with DB to get UUIDs and report status
        const dbRepos = await prisma.repository.findMany({
            where: { userId: user.id },
            select: {
                id: true,
                repositoryId: true,
                compiledReport: true,
                isSupported: true,
                framework: true,
            },
        });

        const dbMap = new Map(
            dbRepos.map((r) => [
                r.repositoryId,
                {
                    dbId: r.id,
                    hasReport: r.compiledReport !== null,
                    isSupported: r.isSupported,
                    framework: r.framework,
                },
            ])
        );

        const repositories = ghRepos.map((repo: any) => {
            const dbInfo = dbMap.get(String(repo.id));
            return {
                ...repo,
                dbId: dbInfo?.dbId ?? null,
                hasReport: dbInfo?.hasReport ?? false,
                isSupported: dbInfo?.isSupported ?? null,
                framework: dbInfo?.framework ?? null,
            };
        });

        return NextResponse.json({ repositories });
    } catch (error) {
        console.error("Error fetching repositories:", error);
        return NextResponse.json(
            { error: "Failed to fetch repositories" },
            { status: 500 }
        );
    }
}
