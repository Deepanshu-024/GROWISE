import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/**
 * GET /api/agent/repositories
 * Returns all repositories stored in the database with fields needed
 * to populate the DB Agent test page selector.
 */
export async function GET() {
    try {
        const repositories = await prisma.repository.findMany({
            select: {
                id: true,
                repositoryId: true,
                name: true,
                fullName: true,
                owner: true,
                defaultBranch: true,
                framework: true,
                archetypes: true,
                isSupported: true,
                packageJson: true,
                user: {
                    select: {
                        githubAccessToken: true,
                        githubInstallationId: true,
                        githubUsername: true,
                        email: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        return NextResponse.json({ repositories });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/repositories] Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
