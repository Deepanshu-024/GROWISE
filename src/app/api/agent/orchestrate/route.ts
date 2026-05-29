import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import prisma from "@/lib/prisma";
import { orchestrateAgents } from "../../../../../actions/agents/orchestrator";

/**
 * POST /api/agent/orchestrate
 *
 * Runs ALL archetype agents sequentially for a given repository.
 * Requires authenticated user who owns the repository.
 *
 * Body: { repositoryId: string }
 */
export async function POST(req: NextRequest) {
    try {
        // ── Authenticate user ───────────────────────────────────────────
        const { userId: clerkId } = await auth();

        if (!clerkId) {
            return Response.json(
                { error: "Unauthorized. Please sign in." },
                { status: 401 },
            );
        }

        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true },
        });

        if (!user) {
            return Response.json(
                { error: "User not found." },
                { status: 401 },
            );
        }

        // ── Parse request body ──────────────────────────────────────────
        const body = await req.json();
        const { repositoryId } = body;

        if (!repositoryId) {
            return Response.json(
                { error: "repositoryId is required" },
                { status: 400 },
            );
        }

        // ── Verify ownership ────────────────────────────────────────────
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [
                    { id: String(repositoryId) },
                    { repositoryId: String(repositoryId) },
                ],
                userId: user.id,
            },
            select: { id: true },
        });

        if (!repository) {
            return Response.json(
                { error: "Repository not found or you do not have access." },
                { status: 404 },
            );
        }

        // ── Run orchestration ───────────────────────────────────────────
        const result = await orchestrateAgents(String(repositoryId));

        return Response.json({
            success: true,
            totalAgents: result.totalAgents,
            completedAgents: result.completedAgents,
            failedAgents: result.failedAgents,
            totalExecutionTimeMs: result.totalExecutionTimeMs,
            hasCompiledReport: !!result.compiledReport,
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/orchestrate] Error:", message);
        return Response.json(
            { error: message },
            { status: 500 },
        );
    }
}
