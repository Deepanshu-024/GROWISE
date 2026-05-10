import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { gpt5Mini } from "@/lib/llm";

/**
 * POST /api/project/[id]/chat
 * Chat with the compiled report — asks GPT questions grounded in the report context.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await params;
        const body = await req.json();
        const { message, history } = body;

        if (!message || typeof message !== "string") {
            return Response.json(
                { error: "message is required" },
                { status: 400 },
            );
        }

        // Fetch repository + compiled report
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id }, { repositoryId: id }],
            },
            select: {
                fullName: true,
                framework: true,
                compiledReport: true,
                archetypes: true,
            },
        });

        if (!repository) {
            return Response.json(
                { error: "Repository not found" },
                { status: 404 },
            );
        }

        if (!repository.compiledReport) {
            return Response.json(
                { error: "No compiled report available. Run the analysis first." },
                { status: 400 },
            );
        }

        // Build conversation messages
        const systemMessage = `You are a helpful technical advisor chatbot for startup founders and CTOs. You have access to a detailed scalability analysis report for the repository "${repository.fullName}" (${repository.framework ?? "unknown"} framework).

Your job is to answer questions about the report clearly and concisely. Always ground your answers in the report data — do not invent findings that aren't in the report.

When answering:
- Be specific and reference finding IDs (e.g., [DB-1], [AUTH-2]) when relevant
- Translate technical concepts into business language when helpful
- If asked about something not covered in the report, say so clearly
- Keep answers focused and actionable
- Use markdown formatting for readability

Here is the full compiled report:

---
${repository.compiledReport}
---`;

        const conversationHistory = Array.isArray(history)
            ? history.slice(-10).map((h: { role: string; content: string }) => ({
                role: h.role as "user" | "assistant",
                content: h.content,
            }))
            : [];

        const messages = [
            { role: "system" as const, content: systemMessage },
            ...conversationHistory,
            { role: "user" as const, content: message },
        ];

        // Stream the response
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const response = await gpt5Mini.invoke(messages);
                    const content =
                        typeof response.content === "string"
                            ? response.content
                            : JSON.stringify(response.content);

                    // Send the full response as a single SSE event
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify({ type: "response", content })}\n\n`,
                        ),
                    );
                } catch (error) {
                    const errorMsg =
                        error instanceof Error
                            ? error.message
                            : "Unknown error";
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify({ type: "error", error: errorMsg })}\n\n`,
                        ),
                    );
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
        console.error("[api/project/chat] Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}
