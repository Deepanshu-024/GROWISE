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
        const repositories = await getInstallationRepositories(user.githubInstallationId);

        return NextResponse.json({
            repositories,
        });
    } catch (error) {
        console.error("Error fetching repositories:", error);
        return NextResponse.json(
            { error: "Failed to fetch repositories" },
            { status: 500 }
        );
    }
}
