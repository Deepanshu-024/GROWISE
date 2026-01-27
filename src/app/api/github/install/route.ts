import { NextRequest, NextResponse } from "next/server";
import crypto from 'crypto';
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

        const githubAppName = process.env.GITHUB_APP_NAME;

        if (!githubAppName) {
            return NextResponse.json(
                { error: "GitHub App not configured" },
                { status: 500 }
            );
        }

        // Generate state parameter for security (tied to user session)
        const state = crypto.randomUUID();

        await prisma.githubAuthState.create({
            data: {
                state,
                userId,
                expiresAt: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
            }
        });

        // Redirect to GitHub App installation page
        const installUrl = new URL(`https://github.com/apps/${githubAppName}/installations/new`);
        installUrl.searchParams.set('state', state);
        installUrl.searchParams.set('setup_action', 'install');
        console.log("1 Redirecting to GitHub installation page:", installUrl.toString());
        return NextResponse.redirect(installUrl.toString());
    } catch (error) {
        console.error("Error initiating GitHub installation:", error);
        return NextResponse.json(
            { error: "Failed to initiate GitHub installation" },
            { status: 500 }
        );
    }
}
