import { NextRequest, NextResponse } from "next/server";
import { runAuthAgent } from "../../../../../actions/agents/auth";

/**
 * POST /api/agent/auth-test
 * Runs the Auth Agent for a given repository.
 *
 * Body: { repositoryId: string, installationId: string }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, installationId } = body;

        if (!repositoryId) {
            return NextResponse.json({ error: "repositoryId is required" }, { status: 400 });
        }
        if (!installationId) {
            return NextResponse.json({ error: "installationId is required" }, { status: 400 });
        }

        const startTime = Date.now();
        const report = await runAuthAgent(String(repositoryId), String(installationId));
        const executionTimeMs = Date.now() - startTime;

        return NextResponse.json({ report, executionTimeMs });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/auth-test] Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
