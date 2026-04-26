import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";

export async function POST(req: NextRequest) {
    try {
        const { userId } = await auth();

        if (!userId) {
            return NextResponse.json(
                { error: "Unauthorized" },
                { status: 401 }
            );
        }

        // Clear GitHub integration fields from user record
        await prisma.user.update({
            where: { clerkId: userId },
            data: {
                githubInstallationId: null,
                githubAccessToken: null,
                githubAccessTokenExpiry: null,
                githubUsername: null,
            },
        });

        return NextResponse.json({
            success: true,
            message: "GitHub account disconnected successfully",
        });
    } catch (error) {
        console.error("Error disconnecting GitHub:", error);
        return NextResponse.json(
            { error: "Failed to disconnect GitHub account" },
            { status: 500 }
        );
    }
}
