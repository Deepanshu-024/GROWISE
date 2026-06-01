"use server";

import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { runChatbotPipeline } from "./chatbot";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StoredMessage {
    role: "user" | "assistant";
    content: string;
    referencedClusters?: string[];
    mode?: string;
    timestamp: string;
    issueNumber?: number;
    issueUrl?: string;
}

export interface ConversationSummary {
    id: string;
    title: string | null;
    messageCount: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface ConversationDetail {
    id: string;
    title: string | null;
    messages: StoredMessage[];
}

// ─── Internal: auth + resolve user & repo ─────────────────────────────────────

async function authenticateUser() {
    const { userId: clerkId } = await auth();
    if (!clerkId) throw new Error("Unauthorized");
    return clerkId;
}

async function resolveUserAndRepo(clerkId: string, repoId: string) {
    const user = await prisma.user.findUnique({
        where: { clerkId },
        select: { id: true, githubInstallationId: true },
    });
    if (!user) throw new Error("User not found");

    const repository = await prisma.repository.findFirst({
        where: {
            OR: [{ id: repoId }, { repositoryId: repoId }],
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
    if (!repository) throw new Error("Repository not found");

    return { user, repository };
}

// ─── Conversation CRUD ────────────────────────────────────────────────────────

/**
 * List all conversations for the authenticated user + repo, newest first.
 */
export async function getConversations(
    repoId: string,
) {
    const clerkId = await authenticateUser();
    const { user, repository } = await resolveUserAndRepo(clerkId, repoId);

    const conversations = await prisma.chatMessage.findMany({
        where: {
            repositoryId: repository.id,
            userId: user.id,
        },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            title: true,
            messages: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    return conversations.map((c) => ({
        id: c.id,
        title: c.title,
        messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
    }));
}

/**
 * Create a new conversation for the authenticated user + repo.
 */
export async function createConversation(
    repoId: string,
    title?: string,
) {
    const clerkId = await authenticateUser();
    const { user, repository } = await resolveUserAndRepo(clerkId, repoId);

    const chatCount = await prisma.chatMessage.count({
        where: {
            repositoryId: repository.id,
            userId: user.id,
        },
    });

    if (chatCount >= 2) {
        throw new Error("Chat limit reached: You can create a maximum of 2 chats per project.");
    }

    const conversation = await prisma.chatMessage.create({
        data: {
            userId: user.id,
            repositoryId: repository.id,
            title: title || null,
            messages: [],
        },
        select: {
            id: true,
            title: true,
            createdAt: true,
        },
    });

    return conversation;
}

/**
 * Get a single conversation's messages.
 */
export async function getConversationMessages(
    repoId: string,
    conversationId: string,
) {
    const clerkId = await authenticateUser();
    const { user, repository } = await resolveUserAndRepo(clerkId, repoId);

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

    if (!conversation) throw new Error("Conversation not found");

    return {
        id: conversation.id,
        title: conversation.title,
        messages: (conversation.messages ?? []) as unknown as StoredMessage[],
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
) {
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

// ─── Full Chat Flow (called directly from the client) ─────────────────────────

export interface ChatResponse {
    content: string;
    mode: string;
    issueNumber?: number;
    issueUrl?: string;
    issueCreated?: boolean;
    /** Updated conversation title (set after first message) */
    updatedTitle?: string;
}

/**
 * Send a chat message — the single entry point called by the frontend.
 *
 * 1. Authenticates the user
 * 2. Loads conversation + repo context from DB
 * 3. Runs the chatbot pipeline (LLM chain → parse → handle mode)
 * 4. Persists user + assistant messages
 * 5. Returns the assistant response
 */
export async function sendChatMessage(
    repoId: string,
    conversationId: string,
    message: string,
    referencedClusters?: string[],
) {
    console.log("------------------------------------------");
    console.log("[chat] [sendChatMessage] Server Action invoked!");
    console.log("  - repoId:", repoId);
    console.log("  - conversationId:", conversationId);
    console.log("  - message:", message);
    console.log("  - referencedClusters:", referencedClusters);
    console.log("------------------------------------------");

    const clerkId = await authenticateUser();
    const { user, repository } = await resolveUserAndRepo(clerkId, repoId);

    if (!repository.compiledReport || repository.compiledReport === "COMPILING") {
        throw new Error("No compiled report available. Run the analysis first.");
    }

    // Load conversation
    const conversation = await prisma.chatMessage.findFirst({
        where: {
            id: conversationId,
            userId: user.id,
            repositoryId: repository.id,
        },
    });

    if (!conversation) throw new Error("Conversation not found");

    const existingMessages = (conversation.messages ?? []) as unknown as StoredMessage[];
    console.log(`[chat] [sendChatMessage] Loaded conversation. Existing messages count: ${existingMessages.length}`);

    const userMessageCount = existingMessages.filter((m) => m.role === "user").length;
    if (userMessageCount >= 3) {
        throw new Error("Message limit reached: You can send a maximum of 3 messages per chat.");
    }

    // Import and run the chatbot pipeline
    const { userMsg, assistantMsg, response } = await runChatbotPipeline({
        compiledReport: repository.compiledReport,
        existingMessages,
        userMessage: message,
        referencedClusters,
        githubInstallationId: user.githubInstallationId,
        repoOwner: repository.owner,
        repoName: repository.name,
    });

    console.log("[chat] [sendChatMessage] runChatbotPipeline returned userMsg:", JSON.stringify(userMsg));
    console.log("[chat] [sendChatMessage] runChatbotPipeline returned assistantMsg:", JSON.stringify(assistantMsg));

    // Persist to DB
    await persistMessages(
        conversationId,
        existingMessages,
        userMsg as any,
        assistantMsg as any,
        conversation.title,
        message,
    );

    // Return title if this was the first message (title was just set)
    const isFirstMessage = existingMessages.length === 0 && !conversation.title;
    const updatedTitle = isFirstMessage
        ? (message.length > 80 ? message.substring(0, 77) + "..." : message)
        : undefined;

    return {
        content: response.content,
        mode: response.mode,
        issueNumber: 'issueNumber' in response ? response.issueNumber : undefined,
        issueUrl: 'issueUrl' in response ? response.issueUrl : undefined,
        issueCreated: 'issueCreated' in response ? response.issueCreated : undefined,
        updatedTitle,
    };
}
