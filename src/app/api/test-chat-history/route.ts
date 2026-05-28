import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";

/**
 * GET /api/test-chat-history
 * Creates a test conversation and then fetches all conversations for the hardcoded repo+user.
 * For development/testing only — DELETE before production.
 */
export async function GET(req: NextRequest) {
    const repoId = "fc92842f-98a0-4955-abb3-9c5e7c33c949";
    const userId = "ae3b5fd2-dd98-4960-b160-741ffea77455";

    try {
        // Step 1: Verify the user exists
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, clerkId: true },
        });
        if (!user) {
            return Response.json({ error: "User not found", userId }, { status: 404 });
        }

        // Step 2: Verify the repository exists and belongs to this user
        const repo = await prisma.repository.findUnique({
            where: { id: repoId },
            select: { id: true, fullName: true, userId: true },
        });
        if (!repo) {
            return Response.json({ error: "Repository not found", repoId }, { status: 404 });
        }
        if (repo.userId !== userId) {
            return Response.json({
                error: "Repository does not belong to this user",
                repoUserId: repo.userId,
                expectedUserId: userId,
            }, { status: 400 });
        }

        // Step 3: Create a test conversation with some sample messages
        const testConversation = await prisma.chatMessage.create({
            data: {
                userId,
                repositoryId: repoId,
                title: "Test conversation — " + new Date().toISOString(),
                messages: [
                    {
                        role: "user",
                        content: "What are the top scalability risks?",
                        timestamp: new Date().toISOString(),
                    },
                    {
                        role: "assistant",
                        content: "Based on the analysis, the top 3 risks are...",
                        mode: "answer",
                        timestamp: new Date().toISOString(),
                    },
                ],
            },
        });

        // Step 4: Fetch all conversations for this user+repo (same as GET /chat/history)
        const allConversations = await prisma.chatMessage.findMany({
            where: {
                repositoryId: repoId,
                userId,
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

        const result = allConversations.map((c) => ({
            id: c.id,
            title: c.title,
            messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
        }));

        return Response.json({
            status: "success",
            created: {
                id: testConversation.id,
                title: testConversation.title,
            },
            allConversations: result,
            meta: {
                user: user.email,
                repo: repo.fullName,
                totalConversations: result.length,
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[test-chat-history] Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}
