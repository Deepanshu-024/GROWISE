import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

/**
 * Generate an installation access token for a GitHub App installation
 * @param installationId - The GitHub App installation ID
 * @returns Access token with expiration time
 */
export async function generateInstallationToken(installationId: string) {
    try {
        const appId = process.env.GITHUB_APP_ID;
        const privateKey = process.env.GITHUB_PRIVATE_KEY;

        if (!appId || !privateKey) {
            throw new Error("GitHub App credentials not configured");
        }
        console.log("App ID:", appId);
        console.log("Private Key:", privateKey);
        const decodedPrivateKey = privateKey.replace(/\\n/g, '\n');
        console.log("Decoded Private Key:", decodedPrivateKey);

        const auth = createAppAuth({
            appId,
            privateKey: decodedPrivateKey,
        });
        console.log("Auth created111");
        const installationAuthentication = await auth({
            type: "installation",
            installationId: parseInt(installationId),
        });
        console.log("Auth created222");
        return {
            token: installationAuthentication.token,
            expiresAt: installationAuthentication.expiresAt,
        };
    } catch (error) {
        console.error("Error generating installation token:", error);
        throw new Error("Failed to generate GitHub installation token");
    }
}

/**
 * Get all repositories accessible by a GitHub App installation
 * @param installationId - The GitHub App installation ID
 * @returns List of repositories
 */
export async function getInstallationRepositories(installationId: string) {
    try {
        const { token } = await generateInstallationToken(installationId);

        const octokit = new Octokit({
            auth: token,
        });

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
 * @param installationId - The GitHub App installation ID
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param path - Path to the file or directory
 * @returns Repository content
 */
export async function getRepositoryContent(
    installationId: string,
    owner: string,
    repo: string,
    path: string = ""
) {
    try {
        const { token } = await generateInstallationToken(installationId);

        const octokit = new Octokit({
            auth: token,
        });

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
 * @param installationId - The GitHub App installation ID
 * @returns Installation details including account information
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

        return {
            id: data.id,
            account: {
                login: data.account?.login,
                type: data.account?.type,
                avatarUrl: data.account?.avatar_url,
            },
            repositorySelection: data.repository_selection,
        };
    } catch (error) {
        console.error("Error fetching installation details:", error);
        throw new Error("Failed to fetch GitHub installation details");
    }
}
