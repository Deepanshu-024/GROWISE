import { NextRequest, NextResponse } from "next/server";
import { runDatabaseAgent } from "../../../../../actions/agents/db";
import { generateInstallationToken } from "@/lib/github";

/**
 * POST /api/agent/db-test
 * Runs the Database Agent for a given repository.
 *
 * Body: { repositoryId: string, accessToken?: string, installationId?: string, archetypeScore?: number }
 * - If accessToken is provided it is used directly.
 * - If accessToken is missing but installationId is provided, a short-lived
 *   GitHub App installation token is generated automatically.
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, accessToken, installationId, archetypeScore } = body;

        if (!repositoryId) {
            return NextResponse.json(
                { error: "repositoryId is required" },
                { status: 400 }
            );
        }

        let resolvedToken: string = accessToken ?? "";

        // Fall back to GitHub App installation token when OAuth token is absent
        if (!resolvedToken && installationId) {
            console.log("[api/agent/db-test] No access token – generating installation token for", installationId);
            const { token } = await generateInstallationToken(String(installationId));
            resolvedToken = token;
        }

        if (!resolvedToken) {
            return NextResponse.json(
                { error: "No access token available. Provide accessToken or ensure this user's GitHub App is installed (installationId)." },
                { status: 400 }
            );
        }

        const output = await runDatabaseAgent({
            repositoryId: String(repositoryId),
            accessToken: resolvedToken,
            archetypeScore: typeof archetypeScore === "number" ? archetypeScore : 0.5,
        });

        return NextResponse.json(output);
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/db-test] Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
