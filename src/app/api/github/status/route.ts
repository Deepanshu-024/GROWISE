import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

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
                githubUsername: true,
            },
        });

        if (!user) {
            return NextResponse.json(
                { error: "User not found" },
                { status: 404 }
            );
        }

        const connected = !!user.githubInstallationId;

        return NextResponse.json({
            connected,
            username: user.githubUsername,
            installationId: user.githubInstallationId,
        });
    } catch (error) {
        console.error("Error fetching GitHub status:", error);
        return NextResponse.json(
            { error: "Failed to fetch GitHub status" },
            { status: 500 }
        );
    }
}
