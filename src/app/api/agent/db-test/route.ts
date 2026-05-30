import { NextRequest } from "next/server";
import { runDatabaseAgent, StreamEvent } from "../../../../../actions/agents/db";

/**
 * POST /api/agent/db-test
 * Runs the Database Agent for a given repository.
 * Returns a Server-Sent Events stream with live agent events.
 *
 * Body: {
 *   repositoryId: string,
 *   installationId: string,
 *   archetypeScore?: number,
 * }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, installationId, archetypeScore } = body;

        if (!repositoryId) {
            return new Response(
                JSON.stringify({ error: "repositoryId is required" }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }

        if (!installationId) {
            return new Response(
                JSON.stringify({ error: "installationId is required" }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }

        const encoder = new TextEncoder();

        const stream = new ReadableStream({
            async start(controller) {
                const send = (event: StreamEvent) => {
                    try {
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
                        );
                    } catch {
                        // stream might be closed
                    }
                };

                try {
                    const output = await runDatabaseAgent({
                        repositoryId: String(repositoryId),
                        installationId: String(installationId),
                        archetypeScore: typeof archetypeScore === "number" ? archetypeScore : 0.5,
                        onEvent: send,
                    });

                    try {
                            controller.enqueue(
                                encoder.encode(`data: ${JSON.stringify({
                                    type: "result",
                                    rawFindings: (output as any).rawFindings ?? null,
                                    intermediateSteps: output.intermediateSteps,
                                    totalToolCalls: output.totalToolCalls,
                                    executionTimeMs: output.executionTimeMs,
                                    error: output.error,
                                })}\n\n`)
                        );
                    } catch {
                        // stream closed
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : "Unknown error";
                    console.error("[api/agent/db-test] Stream error:", message);
                    try {
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify({ type: "error", error: message, stepNumber: -1, timestamp: new Date().toISOString(), elapsedMs: 0 })}\n\n`)
                        );
                    } catch {
                        // stream closed
                    }
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/db-test] Error:", message);
        return new Response(
            JSON.stringify({ error: message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
}
