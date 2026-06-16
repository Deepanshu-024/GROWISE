import { NextRequest } from "next/server";
import { runReportCompiler } from "../../../../actions/agents/report-compiler";

/**
 * POST /api/agent/compile-report
 * Triggers the report compiler agent for a repository that already has
 * completed specialist agent reports. Streams SSE events.
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId } = body;

        if (!repositoryId) {
            return Response.json(
                { error: "repositoryId is required" },
                { status: 400 },
            );
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const send = (event: any) => {
                    try {
                        controller.enqueue(
                            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                        );
                    } catch {
                        /* stream closed */
                    }
                };

                try {
                    const result = await runReportCompiler({
                        repositoryId: String(repositoryId),
                        onEvent: send,
                    });

                    // Send final result event
                    send({
                        type: "result",
                        compiledReport: result.compiledReport,
                        executionTimeMs: result.executionTimeMs,
                        error: result.error,
                    });
                } catch (error) {
                    const message =
                        error instanceof Error
                            ? error.message
                            : "Unknown error";
                    console.error(
                        "[api/agent/compile-report] Stream error:",
                        message,
                    );
                    send({
                        type: "error",
                        error: message,
                        timestamp: new Date().toISOString(),
                    });
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
        console.error("[api/agent/compile-report] Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}
