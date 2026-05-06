import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";

/**
 * GET /api/reports/[repositoryId]
 * Fetches all agent reports for a given repository.
 */
export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ repositoryId: string }> },
) {
    try {
        const { repositoryId } = await params;

        if (!repositoryId) {
            return Response.json(
                { error: "repositoryId is required" },
                { status: 400 },
            );
        }

        // Find the repository — search by both id and repositoryId
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [
                    { id: repositoryId },
                    { repositoryId },
                ],
            },
            select: {
                id: true,
                repositoryId: true,
                name: true,
                fullName: true,
                framework: true,
                archetypes: true,
                archClassificationConfidence: true,
                repoSizeKB: true,
                updatedAt: true,
                agentReports: {
                    orderBy: { updatedAt: "desc" },
                },
            },
        });

        if (!repository) {
            return Response.json(
                { error: `Repository "${repositoryId}" not found` },
                { status: 404 },
            );
        }

        return Response.json({
            repository: {
                id: repository.id,
                repositoryId: repository.repositoryId,
                name: repository.name,
                fullName: repository.fullName,
                framework: repository.framework,
                archetypes: repository.archetypes,
                archClassificationConfidence: repository.archClassificationConfidence,
                repoSizeKB: repository.repoSizeKB,
                updatedAt: repository.updatedAt,
            },
            reports: repository.agentReports,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[api/reports] Error:", message);
        return Response.json({ error: message }, { status: 500 });
    }
}
