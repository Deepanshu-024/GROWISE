import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { gpt5Mini } from "@/lib/llm";
import { scaleChatbotPrompt } from "../../../../../../prompts/scale-chatbot";
import { createGitHubIssue } from "../../../../../../actions/github/create-issue";

// ─── Types ────────────────────────────────────────────────────────────────────

interface StoredMessage {
    role: "user" | "assistant";
    content: string;
    referencedClusters?: string[];
    mode?: string;
    timestamp: string;
    // Extra fields for create_issue results
    issueNumber?: number;
    issueUrl?: string;
}

interface LLMAnswerResponse {
    mode: "answer";
    content: string;
}

interface LLMCreateIssueResponse {
    mode: "create_issue";
    title: string;
    body: string;
    labels: string[];
    message: string;
}

interface LLMBuildPlanResponse {
    mode: "build_plan";
    content: string;
}

interface LLMClarifyResponse {
    mode: "clarify";
    content: string;
}

type LLMResponse =
    | LLMAnswerResponse
    | LLMCreateIssueResponse
    | LLMBuildPlanResponse
    | LLMClarifyResponse;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format stored messages into a human-readable conversation history string
 * for the LLM prompt.
 */
function formatConversationHistory(messages: StoredMessage[]): string {
    return messages
        .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
        .join("\n");
}

/**
 * Try to parse the LLM's raw text output as JSON.
 * Handles edge cases: markdown fences, leading/trailing junk.
 */
function parseLLMResponse(raw: string): LLMResponse {
    let cleaned = raw.trim();

    // Strip markdown code fences if present
    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Try to extract JSON object if there's leading/trailing text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    const parsed = JSON.parse(cleaned);

    // Validate mode
    const validModes = ["answer", "create_issue", "build_plan", "clarify"];
    if (!parsed.mode || !validModes.includes(parsed.mode)) {
        throw new Error(`Invalid mode: ${parsed.mode}`);
    }

    return parsed as LLMResponse;
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/project/[id]/chat
 *
 * Body: {
 *   message: string,
 *   conversationId: string,
 *   referencedClusters?: string[]
 * }
 *
 * - Loads conversation from DB
 * - Fills the scaleChatbotPrompt with context
 * - Calls LLM, parses structured JSON response
 * - If mode === "create_issue" → creates GitHub issue
 * - Persists user + assistant messages to DB
 * - Returns SSE events
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        // ── Auth ──────────────────────────────────────────────
        const { userId: clerkId } = await auth();
        if (!clerkId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json();
        const { message, conversationId, referencedClusters } = body;

        if (!message || typeof message !== "string") {
            return Response.json(
                { error: "message is required" },
                { status: 400 },
            );
        }

        if (!conversationId || typeof conversationId !== "string") {
            return Response.json(
                { error: "conversationId is required" },
                { status: 400 },
            );
        }

        // ── Resolve user ─────────────────────────────────────
        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true, githubInstallationId: true },
        });
        if (!user) {
            return Response.json({ error: "User not found" }, { status: 404 });
        }

        // ── Fetch repository + compiled report ───────────────
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id }, { repositoryId: id }],
                userId: user.id,
            },
            select: {
                id: true,
                fullName: true,
                owner: true,
                name: true,
                framework: true,
                compiledReport: true,
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

        // ── Load conversation ────────────────────────────────
        const conversation = await prisma.chatMessage.findFirst({
            where: {
                id: conversationId,
                userId: user.id,
                repositoryId: repository.id,
            },
        });

        if (!conversation) {
            return Response.json(
                { error: "Conversation not found" },
                { status: 404 },
            );
        }

        const existingMessages = (conversation.messages ?? []) as unknown as StoredMessage[];

        // ── Build the prompt ─────────────────────────────────
        const conversationHistoryStr = formatConversationHistory(existingMessages);
        const clustersNote =
            Array.isArray(referencedClusters) && referencedClusters.length > 0
                ? `\n\n**Referenced Clusters:** ${referencedClusters.join(", ")}`
                : "";

        const filledPrompt = scaleChatbotPrompt
            .replace("{compiledReport}", repository.compiledReport)
            .replace("{conversationHistory}", conversationHistoryStr)
            .replace("{userInput}", message + clustersNote);

        const llmMessages = [
            { role: "system" as const, content: filledPrompt },
            { role: "user" as const, content: message + clustersNote },
        ];

        // ── Call LLM ─────────────────────────────────────────
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const response = await gpt5Mini.invoke(llmMessages);
                    const rawContent =
                        typeof response.content === "string"
                            ? response.content
                            : JSON.stringify(response.content);

                    console.log("[chat] Raw LLM response:", rawContent.substring(0, 200));

                    // ── Parse structured response ────────────
                    let parsed: LLMResponse;
                    try {
                        parsed = parseLLMResponse(rawContent);
                    } catch (parseErr) {
                        console.error("[chat] JSON parse failed, falling back to answer mode:", parseErr);
                        // Fallback: treat raw text as an answer
                        parsed = { mode: "answer", content: rawContent };
                    }

                    // ── Build the user message to persist ────
                    const userStoredMsg: StoredMessage = {
                        role: "user",
                        content: message,
                        timestamp: new Date().toISOString(),
                        ...(Array.isArray(referencedClusters) && referencedClusters.length > 0
                            ? { referencedClusters }
                            : {}),
                    };

                    // ── Handle each mode ─────────────────────
                    let assistantStoredMsg: StoredMessage;
                    let ssePayload: Record<string, unknown>;

                    if (parsed.mode === "create_issue") {
                        // Attempt to create the GitHub issue
                        let issueResult = null;
                        if (user.githubInstallationId) {
                            issueResult = await createGitHubIssue({
                                installationId: user.githubInstallationId,
                                owner: repository.owner,
                                repo: repository.name,
                                title: parsed.title,
                                body: parsed.body,
                                labels: parsed.labels,
                            });
                        }

                        const issueSuccess = issueResult?.success ?? false;
                        const issueMessage = issueSuccess
                            ? `${parsed.message}\n\n✅ Issue #${issueResult!.issueNumber} created: [View on GitHub](${issueResult!.issueUrl})`
                            : user.githubInstallationId
                                ? `${parsed.message}\n\n❌ Failed to create issue: ${issueResult?.error ?? "Unknown error"}`
                                : `${parsed.message}\n\n⚠️ GitHub App not installed — issue was not created. Here's the payload:\n\n**${parsed.title}**\n\n${parsed.body}`;

                        assistantStoredMsg = {
                            role: "assistant",
                            content: issueMessage,
                            mode: "create_issue",
                            timestamp: new Date().toISOString(),
                            ...(issueResult?.issueNumber ? { issueNumber: issueResult.issueNumber } : {}),
                            ...(issueResult?.issueUrl ? { issueUrl: issueResult.issueUrl } : {}),
                        };

                        ssePayload = {
                            type: "response",
                            mode: "create_issue",
                            content: issueMessage,
                            issueCreated: issueSuccess,
                            issueNumber: issueResult?.issueNumber ?? null,
                            issueUrl: issueResult?.issueUrl ?? null,
                        };
                    } else {
                        // answer, build_plan, or clarify — all have { mode, content }
                        const content = (parsed as LLMAnswerResponse | LLMBuildPlanResponse | LLMClarifyResponse).content;

                        assistantStoredMsg = {
                            role: "assistant",
                            content,
                            mode: parsed.mode,
                            timestamp: new Date().toISOString(),
                        };

                        ssePayload = {
                            type: "response",
                            mode: parsed.mode,
                            content,
                        };
                    }

                    // ── Persist messages to DB ───────────────
                    const updatedMessages = [
                        ...existingMessages,
                        userStoredMsg,
                        assistantStoredMsg,
                    ];

                    // Auto-generate title from first user message if not set
                    const shouldSetTitle = !conversation.title && existingMessages.length === 0;

                    await prisma.chatMessage.update({
                        where: { id: conversationId },
                        data: {
                            messages: updatedMessages as any[],
                            ...(shouldSetTitle
                                ? { title: message.length > 80 ? message.substring(0, 77) + "..." : message }
                                : {}),
                        },
                    });

                    // ── Send SSE ─────────────────────────────
                    controller.enqueue(
                        encoder.encode(
                            `data: ${JSON.stringify(ssePayload)}\n\n`,
                        ),
                    );
                } catch (error) {
                    const errorMsg =
                        error instanceof Error
                            ? error.message
                            : "Unknown error";
                    console.error("[chat] Stream error:", errorMsg);
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
