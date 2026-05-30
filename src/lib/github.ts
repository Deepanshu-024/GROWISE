import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import prisma from "@/lib/prisma";

// ─── Token Cache ──────────────────────────────────────────────────────────────
// Caches installation tokens in the User table (githubAccessToken / githubAccessTokenExpiry).
// Tokens are cached for 50 minutes (GitHub tokens last 1 hour).

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

/**
 * Get a valid installation token, using database cache if available.
 * Only generates a new token if the cached one is expired or missing.
 */
export async function getInstallationToken(installationId: string): Promise<{ token: string; expiresAt: string }> {
    // Check database cache first
    const user = await prisma.user.findFirst({
        where: { githubInstallationId: installationId },
        select: { githubAccessToken: true, githubAccessTokenExpiry: true },
    });

    if (user?.githubAccessToken && user?.githubAccessTokenExpiry && new Date() < new Date(user.githubAccessTokenExpiry)) {
        console.log(`[github] ♻️  REUSED cached token for installation ${installationId}`);
        return { token: user.githubAccessToken, expiresAt: new Date(user.githubAccessTokenExpiry).toISOString() };
    }

    // Cache miss or expired — generate fresh token
    const { token } = await generateInstallationToken(installationId);
    const expiresAt = new Date(Date.now() + TOKEN_CACHE_TTL_MS);

    // Save to database
    await prisma.user.updateMany({
        where: { githubInstallationId: installationId },
        data: {
            githubAccessToken: token,
            githubAccessTokenExpiry: expiresAt,
        },
    });

    console.log(`[github] ✨ GENERATED new token for installation ${installationId} (saved to db, expires in 50min)`);

    return { token, expiresAt: expiresAt.toISOString() };
}

// ─── Internal: Generate a fresh token (not exported, use getInstallationToken) ─

async function generateInstallationToken(installationId: string) {
    try {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_PRIVATE_KEY;

        if (!appId || !privateKey) {
            throw new Error("GitHub App credentials not configured");
        }

        const decodedPrivateKey = privateKey.replace(/\\n/g, '\n');

        const auth = createAppAuth({
            appId,
            privateKey: decodedPrivateKey,
        });

        const installationAuthentication = await auth({
            type: "installation",
            installationId: parseInt(installationId),
        });

        return {
            token: installationAuthentication.token,
            expiresAt: installationAuthentication.expiresAt,
        };
    } catch (error) {
        console.error("Error generating installation token:", error);
        throw new Error("Failed to generate GitHub installation token");
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all repositories accessible by a GitHub App installation
 */
export async function getInstallationRepositories(installationId: string) {
    try {
        const { token } = await getInstallationToken(installationId);

        const octokit = new Octokit({ auth: token });

        const { data } = await octokit.apps.listReposAccessibleToInstallation();

        return data.repositories.map((repo: any) => ({
            id: repo.id,
            name: repo.name,
            fullName: repo.full_name,
            private: repo.private,
            description: repo.description,
            url: repo.html_url,
            defaultBranch: repo.default_branch,
        }));
    } catch (error) {
        console.error("Error fetching installation repositories:", error);
        throw new Error("Failed to fetch GitHub repositories");
    }
}

/**
 * Get repository content from a specific path
 */
export async function getRepositoryContent(
    installationId: string,
    owner: string,
    repo: string,
    path: string = ""
) {
    try {
        const { token } = await getInstallationToken(installationId);

        const octokit = new Octokit({ auth: token });

        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path,
        });

        return data;
    } catch (error) {
        console.error("Error fetching repository content:", error);
        throw new Error("Failed to fetch repository content");
    }
}

/**
 * Get installation details from GitHub
 * Note: This uses App-level auth (JWT), not an installation token,
 * so it doesn't go through the token cache.
 */
export async function getInstallationDetails(installationId: string) {
    try {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_PRIVATE_KEY;

        if (!appId || !privateKey) {
            throw new Error("GitHub App credentials not configured");
        }

        const decodedPrivateKey = privateKey.replace(/\\n/g, '\n');

        const octokit = new Octokit({
            authStrategy: createAppAuth,
            auth: {
                appId,
                privateKey: decodedPrivateKey,
            },
        });

        const { data } = await octokit.rest.apps.getInstallation({
            installation_id: parseInt(installationId),
        });

        const account = data.account as any;

        return {
            id: data.id,
            account: {
                login: account?.login,
                type: account?.type,
                avatarUrl: account?.avatar_url,
            },
            repositorySelection: data.repository_selection,
        };
    } catch (error) {
        console.error("Error fetching installation details:", error);
        throw new Error("Failed to fetch GitHub installation details");
    }
}
