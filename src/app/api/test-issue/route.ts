import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { createGitHubIssue } from "../../../../actions/github/create-issue";

/**
 * TEMPORARY test route to verify GitHub issue creation works.
 * Usage: GET /api/test-issue?repoId=<repository-db-id>
 * Remove after POC is verified.
 */
export async function GET(req: NextRequest) {
    try {
        const repoId = req.nextUrl.searchParams.get("repoId");

        if (!repoId) {
            return NextResponse.json(
                { error: "Missing ?repoId= query parameter" },
                { status: 400 },
            );
        }

        // Fetch the repository and its user
        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id: repoId }, { repositoryId: repoId }],
            },
            include: {
                user: {
                    select: {
                        githubInstallationId: true,
                    },
                },
            },
        });

        if (!repository) {
            return NextResponse.json(
                { error: `Repository "${repoId}" not found` },
                { status: 404 },
            );
        }

        const installationId = repository.user?.githubInstallationId;
        if (!installationId) {
            return NextResponse.json(
                { error: "User has no GitHub App installation linked" },
                { status: 400 },
            );
        }

        // Create a test issue with dummy values
        const result = await createGitHubIssue({
            installationId,
            owner: repository.owner,
            repo: repository.name,
            title: "Test Issue",
            body: "This is a test issue created by the system to verify GitHub issue creation works.\n\nThis issue can be safely closed and deleted.",
            labels: [],
        });

        if (!result.success) {
            return NextResponse.json(
                { error: result.error },
                { status: 500 },
            );
        }

        return NextResponse.json({
            success: true,
            issueNumber: result.issueNumber,
            issueUrl: result.issueUrl,
            message: `Issue #${result.issueNumber} created successfully!`,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
