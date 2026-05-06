import { NextRequest } from "next/server";
import {
    orchestrateAgents,
    OrchestratorStreamEvent,
} from "../../../../../actions/agents/orchestrator";

/**
 * POST /api/agent/orchestrate
 * Runs ALL archetype agents in parallel for a given repository.
 * Returns a Server-Sent Events stream with per-agent progress events.
 *
 * Body: { repositoryId: string }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId } = body;

        if (!repositoryId) {
            return new Response(
                JSON.stringify({ error: "repositoryId is required" }),
                { status: 400, headers: { "Content-Type": "application/json" } },
            );
        }

        const encoder = new TextEncoder();

        const stream = new ReadableStream({
            async start(controller) {
                const send = (event: OrchestratorStreamEvent) => {
                    try {
                        controller.enqueue(
                            encoder.encode(
                                `data: ${JSON.stringify(event)}\n\n`,
                            ),
                        );
                    } catch {
                        // stream may be closed
                    }
                };

                try {
                    await orchestrateAgents(String(repositoryId), send);
                } catch (error) {
                    const message =
                        error instanceof Error
                            ? error.message
                            : "Unknown error";
                    console.error(
                        "[api/agent/orchestrate] Stream error:",
                        message,
                    );
                    try {
                        controller.enqueue(
                            encoder.encode(
                                `data: ${JSON.stringify({
                                    type: "orchestration_complete",
                                    timestamp: new Date().toISOString(),
                                    error: message,
                                    totalAgents: 0,
                                    completedAgents: 0,
                                    failedAgents: 0,
                                    totalExecutionTimeMs: 0,
                                    summary: [],
                                })}\n\n`,
                            ),
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
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            },
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/orchestrate] Error:", message);
        return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}
