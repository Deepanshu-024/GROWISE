import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { getInstallationDetails } from "@/lib/github";

export async function GET(req: NextRequest) {
    try {
        const { userId } = await auth();

        if (!userId) {
            return NextResponse.redirect(new URL("/sign-in", req.url));
        }

        const searchParams = req.nextUrl.searchParams;
        console.log("🔍 Request URL:", req.url);
        const installationId = searchParams.get("installation_id");
        console.log("📦 Installation ID:", installationId);
        const setupAction = searchParams.get("setup_action");
        console.log("📦 Setup Action:", setupAction);
        const state = searchParams.get("state");
        console.log("📦 State:", state);

        // Verify state parameter
        if (state) {
        console.log("Step 1 - State received:", state);
        try {
            // Verify state exists in database and matches userId
            const authState = await prisma.githubAuthState.findUnique({
                where: { state }
            });
            
            if (!authState) {
                console.log("State not found in database");
                return NextResponse.redirect(new URL("/dashboard?error=invalid_state", req.url));
            }
            
            if (authState.userId !== userId) {
                console.log("State userId doesn't match current user");
                return NextResponse.redirect(new URL("/dashboard?error=invalid_state", req.url));
            }
            
            if (authState.expiresAt < new Date()) {
                console.log("State has expired");
                return NextResponse.redirect(new URL("/dashboard?error=invalid_state", req.url));
            }
            
            // Delete used state (one-time use)
            await prisma.githubAuthState.delete({ where: { state } });
            
            console.log("State validated successfully");
            
        } catch (error) {
            console.log("Step 3 - Error occurred");
            console.error("Error:", error);
            return NextResponse.redirect(new URL("/dashboard?error=invalid_state", req.url));
        }
    }

        if (!installationId) {
            console.log("Step 4");
            return NextResponse.redirect(new URL("/dashboard?error=no_installation", req.url));
        }

        // Fetch installation details from GitHub
        console.log("Step 5");
        const installationDetails = await getInstallationDetails(installationId);
        console.log("Step 6");

        // Update user record with GitHub installation data.
        // Use a transaction: first clear the installationId from any previous
        // owner (handles re-installs / transfers), then assign to current user.
        await prisma.$transaction(async (tx) => {
            // Clear old owner of this installation (if any)
            await tx.user.updateMany({
                where: { githubInstallationId: installationId },
                data: { githubInstallationId: null, githubUsername: null },
            });
            // Assign to current user
            await tx.user.update({
                where: { clerkId: userId },
                data: {
                    githubInstallationId: installationId,
                    githubUsername: installationDetails.account.login || null,
                },
            });
        });
        console.log("Step 7");

        // Redirect to dashboard with success message
        return NextResponse.redirect(new URL("/dashboard?github=connected", req.url));
    } catch (error) {
        console.error("Error handling GitHub callback:", error);
        return NextResponse.redirect(new URL("/dashboard?error=callback_failed", req.url));
    }
}
