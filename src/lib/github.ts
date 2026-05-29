import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// ─── Token Cache ──────────────────────────────────────────────────────────────
// Caches installation tokens in memory keyed by installationId.
// Tokens are valid for 1 hour from GitHub, we cache for 50 minutes to have
// a 10-minute safety buffer before expiry.

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

interface CachedToken {
    token: string;
    expiresAt: string;
    cachedAt: number; // Date.now() when cached
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Get a valid installation token, using cache if available.
 * Only generates a new token if the cached one is expired or missing.
 */
export async function getInstallationToken(installationId: string): Promise<{ token: string; expiresAt: string }> {
    // Check cache first
    const cached = tokenCache.get(installationId);
    if (cached && (Date.now() - cached.cachedAt) < TOKEN_CACHE_TTL_MS) {
        const ageMin = ((Date.now() - cached.cachedAt) / 60000).toFixed(1);
        const remainMin = ((TOKEN_CACHE_TTL_MS - (Date.now() - cached.cachedAt)) / 60000).toFixed(1);
        console.log(`[github] ♻️  REUSED cached token for installation ${installationId} (age: ${ageMin}min, expires in: ${remainMin}min)`);
        return { token: cached.token, expiresAt: cached.expiresAt };
    }

    // Cache miss or expired — generate fresh token
    const { token, expiresAt } = await generateInstallationToken(installationId);

    tokenCache.set(installationId, {
        token,
        expiresAt,
        cachedAt: Date.now(),
    });

    console.log(`[github] ✨ GENERATED new token for installation ${installationId} (cached for 50min)`);

    return { token, expiresAt };
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
