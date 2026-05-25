import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";

/**
 * GET /api/project/[id]/chat/history
 * Returns all chat conversations for this repository + authenticated user.
 * Each conversation has: id, title, updatedAt, messageCount.
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

        // Resolve Clerk ID → internal user UUID
        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true },
        });
        if (!user) {
            return Response.json({ error: "User not found" }, { status: 404 });
        }

        // Find the repository by either internal ID or GitHub repository ID
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id }, { repositoryId: id }],
                userId: user.id,
            },
            select: { id: true },
        });

        if (!repository) {
            return Response.json(
                { error: "Repository not found" },
                { status: 404 },
            );
        }

        // Fetch all conversations for this user + repo, newest first
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

        // Return conversations with message count
        const result = conversations.map((c) => ({
            id: c.id,
            title: c.title,
            messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
        }));

        return Response.json({ conversations: result });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/project/chat/history] GET Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}

/**
 * POST /api/project/[id]/chat/history
 * Creates a new conversation. Returns the new ChatMessage.id.
 * Body: { title?: string }
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const { userId: clerkId } = await auth();
        if (!clerkId) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { id } = await params;
        const body = await req.json().catch(() => ({}));

        // Resolve Clerk ID → internal user UUID
        const user = await prisma.user.findUnique({
            where: { clerkId },
            select: { id: true },
        });
        if (!user) {
            return Response.json({ error: "User not found" }, { status: 404 });
        }

        // Find the repository
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id }, { repositoryId: id }],
                userId: user.id,
            },
            select: { id: true },
        });

        if (!repository) {
            return Response.json(
                { error: "Repository not found" },
                { status: 404 },
            );
        }

        // Create a new conversation
        const conversation = await prisma.chatMessage.create({
            data: {
                userId: user.id,
                repositoryId: repository.id,
                title: body.title || null,
                messages: [],
            },
            select: {
                id: true,
                title: true,
                createdAt: true,
            },
        });

        return Response.json({ conversation }, { status: 201 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/project/chat/history] POST Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}
