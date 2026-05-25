import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { gpt5Mini } from "@/lib/llm";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
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

interface IssueHandlerResult {
    assistantMsg: StoredMessage;
    ssePayload: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format stored messages into a simple conversation history string.
 */
function formatConversationHistory(messages: StoredMessage[]): string {
    return messages
        .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
        .join("\n");
}

/**
 * Invoke the ScaleBot LLM chain using a LangChain RunnableSequence.
 * Pattern: PromptTemplate → LLM → StringOutputParser
 */
async function invokeScaleChatbot(
    compiledReport: string,
    conversationHistory: string,
    userInput: string,
): Promise<string> {
    const prompt = PromptTemplate.fromTemplate(scaleChatbotPrompt);
    const chain = prompt.pipe(gpt5Mini).pipe(new StringOutputParser());

    const result = await chain.invoke({
        compiledReport,
        conversationHistory,
        userInput,
    });

    console.log("[chat] Raw LLM response:", result.substring(0, 200));
    return result;
}

/**
 * Parse the LLM's raw text output as structured JSON.
 * Handles markdown fences and leading/trailing junk.
 * Falls back to "answer" mode if parsing fails.
 */
function parseLLMResponse(raw: string): LLMResponse {
    let cleaned = raw.trim();

    // Strip markdown code fences if present
    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON object if there's surrounding text
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

/**
 * Build the StoredMessage for the user's input.
 */
function buildUserMessage(
    message: string,
    referencedClusters?: string[],
): StoredMessage {
    return {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
        ...(Array.isArray(referencedClusters) && referencedClusters.length > 0
            ? { referencedClusters }
            : {}),
    };
}

/**
 * Handle "create_issue" mode — creates GitHub issue and builds response payloads.
 */
async function handleCreateIssueMode(
    parsed: LLMCreateIssueResponse,
    githubInstallationId: string | null,
    owner: string,
    repo: string,
): Promise<IssueHandlerResult> {
    let issueResult = null;

    if (githubInstallationId) {
        issueResult = await createGitHubIssue({
            installationId: githubInstallationId,
            owner,
            repo,
            title: parsed.title,
            body: parsed.body,
            labels: parsed.labels,
        });
    }

    const issueSuccess = issueResult?.success ?? false;
    const issueMessage = issueSuccess
        ? `${parsed.message}\n\n✅ Issue #${issueResult!.issueNumber} created: [View on GitHub](${issueResult!.issueUrl})`
        : githubInstallationId
            ? `${parsed.message}\n\n❌ Failed to create issue: ${issueResult?.error ?? "Unknown error"}`
            : `${parsed.message}\n\n⚠️ GitHub App not installed — issue was not created. Here's the payload:\n\n**${parsed.title}**\n\n${parsed.body}`;

    return {
        assistantMsg: {
            role: "assistant",
            content: issueMessage,
            mode: "create_issue",
            timestamp: new Date().toISOString(),
            ...(issueResult?.issueNumber ? { issueNumber: issueResult.issueNumber } : {}),
            ...(issueResult?.issueUrl ? { issueUrl: issueResult.issueUrl } : {}),
        },
        ssePayload: {
            type: "response",
            mode: "create_issue",
            content: issueMessage,
            issueCreated: issueSuccess,
            issueNumber: issueResult?.issueNumber ?? null,
            issueUrl: issueResult?.issueUrl ?? null,
        },
    };
}

/**
 * Handle "answer", "build_plan", or "clarify" modes — all share { mode, content }.
 */
function handleContentMode(
    parsed: LLMAnswerResponse | LLMBuildPlanResponse | LLMClarifyResponse,
): IssueHandlerResult {
    return {
        assistantMsg: {
            role: "assistant",
            content: parsed.content,
            mode: parsed.mode,
            timestamp: new Date().toISOString(),
        },
        ssePayload: {
            type: "response",
            mode: parsed.mode,
            content: parsed.content,
        },
    };
}

/**
 * Persist user + assistant messages to the conversation in the DB.
 * Auto-generates a title from the first user message if none is set.
 */
async function persistMessages(
    conversationId: string,
    existingMessages: StoredMessage[],
    userMsg: StoredMessage,
    assistantMsg: StoredMessage,
    conversationTitle: string | null,
    rawUserMessage: string,
): Promise<void> {
    const updatedMessages = [...existingMessages, userMsg, assistantMsg];
    const shouldSetTitle = !conversationTitle && existingMessages.length === 0;

    await prisma.chatMessage.update({
        where: { id: conversationId },
        data: {
            messages: updatedMessages as any[],
            ...(shouldSetTitle
                ? { title: rawUserMessage.length > 80 ? rawUserMessage.substring(0, 77) + "..." : rawUserMessage }
                : {}),
        },
    });
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * GET /api/project/[id]/chat?conversationId=xxx
 *
 * Returns the messages array for a specific conversation.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { userId: clerkId } = await auth();
        if (!clerkId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const conversationId = req.nextUrl.searchParams.get("conversationId");

        if (!conversationId) {
            return Response.json(
                { error: "conversationId query param is required" },
                { status: 400 },
            );
        }

        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true },
        });
        if (!user) {
            return Response.json({ error: "User not found" }, { status: 404 });
        }

        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id }, { repositoryId: id }],
                userId: user.id,
            },
            select: { id: true },
        });

        if (!repository) {
            return Response.json({ error: "Repository not found" }, { status: 404 });
        }

        const conversation = await prisma.chatMessage.findFirst({
            where: {
                id: conversationId,
                userId: user.id,
                repositoryId: repository.id,
            },
            select: {
                id: true,
                title: true,
                messages: true,
            },
        });

        if (!conversation) {
            return Response.json({ error: "Conversation not found" }, { status: 404 });
        }

        return Response.json({
            id: conversation.id,
            title: conversation.title,
            messages: conversation.messages ?? [],
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[api/project/chat] GET Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}

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
 * - Invokes LLM chain (PromptTemplate → gpt5Mini → StringOutputParser)
 * - Parses structured JSON response
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

        // ── Prepare inputs ───────────────────────────────────
        const conversationHistoryStr = formatConversationHistory(existingMessages);
        const clustersNote =
            Array.isArray(referencedClusters) && referencedClusters.length > 0
                ? `\n\n**Referenced Clusters:** ${referencedClusters.join(", ")}`
                : "";
        const userInput = message + clustersNote;

        // ── Invoke LLM chain ─────────────────────────────────
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const rawResult = await invokeScaleChatbot(
                        repository.compiledReport!,
                        conversationHistoryStr,
                        userInput,
                    );

                    // ── Parse response ────────────────────────
                    let parsed: LLMResponse;
                    try {
                        parsed = parseLLMResponse(rawResult);
                    } catch (parseErr) {
                        console.error("[chat] JSON parse failed, falling back to answer mode:", parseErr);
                        parsed = { mode: "answer", content: rawResult };
                    }

                    // ── Build messages & SSE payload ──────────
                    const userMsg = buildUserMessage(message, referencedClusters);

                    const { assistantMsg, ssePayload } =
                        parsed.mode === "create_issue"
                            ? await handleCreateIssueMode(
                                  parsed,
                                  user.githubInstallationId,
                                  repository.owner,
                                  repository.name,
                              )
                            : handleContentMode(
                                  parsed as LLMAnswerResponse | LLMBuildPlanResponse | LLMClarifyResponse,
                              );

                    // ── Persist to DB ─────────────────────────
                    await persistMessages(
                        conversationId,
                        existingMessages,
                        userMsg,
                        assistantMsg,
                        conversation.title,
                        message,
                    );

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
