import { NextRequest } from "next/server";
import { runEventDrivenAgent, StreamEvent } from "../../../../../actions/agents/event-driven";
import { generateInstallationToken } from "@/lib/github";

/**
 * POST /api/agent/event-driven-test
 * Runs the Event-driven Agent for a given repository.
 * Returns a Server-Sent Events stream with live agent events.
 *
 * Body: {
 *   repositoryId: string,
 *   accessToken?: string,
 *   installationId?: string,
 * }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, accessToken, installationId } = body;

        if (!repositoryId) {
            return new Response(
                JSON.stringify({ error: "repositoryId is required" }),
                { status: 400, headers: { "Content-Type": "application/json" } }
            );
        }

        let resolvedToken: string = accessToken ?? "";

        if (!resolvedToken && installationId) {
            console.log("[api/agent/event-driven-test] No access token; generating installation token for", installationId);
            const { token } = await generateInstallationToken(String(installationId));
            resolvedToken = token;
        }

        if (!resolvedToken) {
            return new Response(
                JSON.stringify({ error: "No access token available. Provide accessToken or ensure this user's GitHub App is installed (installationId)." }),
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
                    const output = await runEventDrivenAgent({
                        repositoryId: String(repositoryId),
                        accessToken: resolvedToken,
                        onEvent: send,
                    });

                    try {
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify({
                                type: "result",
                                rawFindings: output.rawFindings ?? null,
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
                    console.error("[api/agent/event-driven-test] Stream error:", message);
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
        console.error("[api/agent/event-driven-test] Error:", message);
        return new Response(
            JSON.stringify({ error: message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
}
