import { NextRequest, NextResponse } from "next/server";
import { runAuthAgent } from "../../../../../actions/agents/auth";
import { getInstallationToken } from "@/lib/github";

/**
 * POST /api/agent/auth-test
 * Runs the Auth Agent for a given repository.
 *
 * Body: { repositoryId: string, accessToken?: string, installationId?: string }
 * - If accessToken is provided it is used directly.
 * - If accessToken is missing but installationId is provided, a short-lived
 *   GitHub App installation token is generated automatically.
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, accessToken, installationId } = body;

        if (!repositoryId) {
            return NextResponse.json(
                { error: "repositoryId is required" },
                { status: 400 }
            );
        }

        let resolvedToken: string = accessToken ?? "";

        // Fall back to GitHub App installation token when OAuth token is absent
        if (!resolvedToken && installationId) {
            console.log("[api/agent/auth-test] No access token – generating installation token for", installationId);
            const { token } = await getInstallationToken(String(installationId));
            resolvedToken = token;
        }

        if (!resolvedToken) {
            return NextResponse.json(
                { error: "No access token available. Provide accessToken or ensure this user's GitHub App is installed (installationId)." },
                { status: 400 }
            );
        }

        const startTime = Date.now();
        const report = await runAuthAgent(String(repositoryId), resolvedToken);
        const executionTimeMs = Date.now() - startTime;

        return NextResponse.json({ report, executionTimeMs });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/auth-test] Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
