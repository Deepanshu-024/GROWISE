"use server";

import { Octokit } from "@octokit/rest";
import { generateInstallationToken } from "@/lib/github";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateIssueInput {
    installationId: string;
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
}

export interface CreateIssueResult {
    success: boolean;
    issueNumber?: number;
    issueUrl?: string;
    error?: string;
}

// ─── Main Function ────────────────────────────────────────────────────────────

/**
 * Create a GitHub issue on a repository using the GitHub App installation token.
 */
export async function createGitHubIssue(input: CreateIssueInput): Promise<CreateIssueResult> {
    const { installationId, owner, repo, title, body, labels } = input;

    try {
        console.log(`[createGitHubIssue] Creating issue on ${owner}/${repo}: "${title}"`);

        const { token } = await generateInstallationToken(installationId);

        const octokit = new Octokit({ auth: token });

        const { data } = await octokit.issues.create({
            owner,
            repo,
            title,
            body: body ?? "",
            labels: labels ?? [],
        });

        console.log(`[createGitHubIssue] Issue #${data.number} created: ${data.html_url}`);

        return {
            success: true,
            issueNumber: data.number,
            issueUrl: data.html_url,
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[createGitHubIssue] Failed: ${message}`);
        return {
            success: false,
            error: message,
        };
    }
}
