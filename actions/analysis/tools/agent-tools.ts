import { z } from "zod";
import { tool } from "langchain"

// Types for GitHub API responses
interface GitHubTreeNode {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
  url: string;
}

interface GitHubTreeResponse {
  sha: string;
  url: string;
  tree: GitHubTreeNode[];
  truncated: boolean;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: Array<{
    name: string;
    path: string;
    sha: string;
    url: string;
    git_url: string;
    html_url: string;
    repository: {
      id: number;
      name: string;
      full_name: string;
    };
    score: number;
  }>;
}

// Maximum file size limit (500 KB)
const MAX_FILE_SIZE = 500 * 1024;

// ─── Context schema shared by all GitHub tools ─────────────────────────────────
// Agents pass these values once at invocation time via `context`,
// so the LLM never needs to guess or repeat them in every tool call.

export const githubContextSchema = z.object({
  owner: z.string().describe("Repository owner/organization name"),
  repo: z.string().describe("Repository name"),
  branch: z.string().describe("Branch name (e.g. 'main')"),
  accessToken: z.string().describe("GitHub access token"),
});

export type GitHubContext = z.infer<typeof githubContextSchema>;

// Helper to extract GitHub context from tool config
function getGitHubContext(config: any): GitHubContext {
  const ctx = config?.context;
  if (!ctx?.owner || !ctx?.repo || !ctx?.accessToken) {
    throw new Error(
      "GitHub context missing. Agent must be invoked with context: { owner, repo, branch, accessToken }."
    );
  }
  return {
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.branch ?? "main",
    accessToken: ctx.accessToken,
  };
}

// ─── Tool 1: Get Repository Tree ──────────────────────────────────────────────
// No input needed — reads owner/repo/branch/accessToken from context.

export const getRepoTreeTool = tool(
  async (_input, config): Promise<string> => {
    const { owner, repo, branch, accessToken } = getGitHubContext(config);
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DevilDev-Agent'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          // Try 'master' branch if 'main' fails
          if (branch === "main") {
            const masterUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`;
            const masterResponse = await fetch(masterUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'DevilDev-Agent'
              }
            });

            if (masterResponse.ok) {
              const masterData: GitHubTreeResponse = await masterResponse.json();
              const formattedTree = masterData.tree.map(node => ({
                path: node.path,
                type: node.type,
                size: node.size || 0,
                mode: node.mode
              }));

              const result = {
                success: true,
                sha: masterData.sha,
                truncated: masterData.truncated,
                totalFiles: formattedTree.filter(n => n.type === "blob").length,
                totalDirectories: formattedTree.filter(n => n.type === "tree").length,
                tree: formattedTree
              };

              return `Repository tree structure for ${owner}/${repo} (master branch):
${JSON.stringify(result, null, 2)}

Summary: Found ${result.totalFiles} files and ${result.totalDirectories} directories.
${masterData.truncated ? 'Note: Tree was truncated by GitHub API.' : ''}`;
            }
          }
          throw new Error(`Repository or branch not found: ${owner}/${repo}/${branch}`);
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data: GitHubTreeResponse = await response.json();

      if (data.truncated) {
        console.warn("Repository tree was truncated by GitHub API");
      }

      // Format the tree for better readability
      const formattedTree = data.tree.map(node => ({
        path: node.path,
        type: node.type,
        size: node.size || 0,
        mode: node.mode
      }));

      const result = {
        success: true,
        sha: data.sha,
        truncated: data.truncated,
        totalFiles: formattedTree.filter(n => n.type === "blob").length,
        totalDirectories: formattedTree.filter(n => n.type === "tree").length,
        tree: formattedTree
      };

      return `Repository tree structure for ${owner}/${repo} (${branch} branch):
${JSON.stringify(result, null, 2)}

Summary: Found ${result.totalFiles} files and ${result.totalDirectories} directories.
${data.truncated ? 'Note: Tree was truncated by GitHub API.' : ''}`;

    } catch (error) {
      return `Error getting repository tree: ${error instanceof Error ? error.message : "Unknown error occurred"}`;
    }
  },
  {
    name: "getRepoTree",
    description: "Get the complete file tree structure of the repository. No input needed — repo details are provided via context.",
    schema: z.object({}),
  }
);

// ─── Tool 2: Get File Content ─────────────────────────────────────────────────
// Agent only specifies the file path — owner/repo/branch/accessToken come from context.

export const getFileContentTool = tool(
  async (input, config): Promise<string> => {
    const { owner, repo, branch, accessToken } = getGitHubContext(config);
    const { path } = input as { path: string };
    try {
      let url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
      if (branch) {
        url += `?ref=${encodeURIComponent(branch)}`;
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'DevilDev-Agent'
        }
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(`File not found: ${path}`);
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      // Check content length before reading
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${contentLength} bytes (max: ${MAX_FILE_SIZE} bytes)`);
      }

      const content = await response.text();

      // Double-check actual content size
      if (content.length > MAX_FILE_SIZE) {
        throw new Error(`File content too large: ${content.length} characters (max: ${MAX_FILE_SIZE})`);
      }

      return `File content for ${path} (${content.length} characters):

${content}`;

    } catch (error) {
      return `Error reading file ${path}: ${error instanceof Error ? error.message : "Unknown error occurred"}`;
    }
  },
  {
    name: "getFileContent",
    description: "Get the raw content of a specific file from the repository. Only specify the file path — repo details come from context.",
    schema: z.object({
      path: z.string().describe("File path within the repository (e.g., 'src/app/page.tsx')"),
    }),
  }
);

// ─── Tool 3: Search Code ──────────────────────────────────────────────────────
// Agent specifies search query + optional filters — owner/repo/accessToken come from context.

// Rate-limit guard for GitHub Code Search API (10 req/min limit)
let _lastSearchCodeCallMs = 0;
const SEARCH_CODE_MIN_INTERVAL_MS = 6_000; // 6 seconds → max ~10 calls/min

export const searchCodeTool = tool(
  async (input, config): Promise<string> => {
    const { owner, repo, accessToken } = getGitHubContext(config);
    const { query, language, extension, path } = input as {
      query: string;
      language?: string | null;
      extension?: string | null;
      path?: string | null;
    };
    try {
      // Enforce minimum interval between Code Search API calls
      const now = Date.now();
      const elapsed = now - _lastSearchCodeCallMs;
      if (_lastSearchCodeCallMs > 0 && elapsed < SEARCH_CODE_MIN_INTERVAL_MS) {
        const waitMs = SEARCH_CODE_MIN_INTERVAL_MS - elapsed;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      _lastSearchCodeCallMs = Date.now();

      // Build search query with filters
      let searchQuery = `${query} repo:${owner}/${repo}`;

      if (language) {
        searchQuery += ` language:${language}`;
      }

      if (extension) {
        searchQuery += ` extension:${extension}`;
      }

      if (path) {
        searchQuery += ` path:${path}`;
      }

      const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=30`;

      let response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'DevilDev-Agent'
        }
      });

      // If rate-limited, wait and retry once
      if (response.status === 403) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '10', 10);
        const waitSec = Math.min(retryAfter, 60);
        console.warn(`[searchCode] Rate limited. Waiting ${waitSec}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
        _lastSearchCodeCallMs = Date.now();
        response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DevilDev-Agent'
          }
        });
      }

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error("GitHub code search rate limit exceeded or insufficient permissions");
        }
        if (response.status === 422) {
          throw new Error("Invalid search query or repository too large for code search");
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const data: GitHubSearchResponse = await response.json();

      // Format results for better readability
      const formattedResults = data.items.map(item => ({
        name: item.name,
        path: item.path,
        url: item.html_url,
        score: item.score
      }));

      const result = {
        success: true,
        totalCount: data.total_count,
        incompleteResults: data.incomplete_results,
        query: searchQuery,
        results: formattedResults
      };

      return `Code search results for "${query}" in ${owner}/${repo}:

Total matches: ${data.total_count}
Results returned: ${formattedResults.length}
Incomplete results: ${data.incomplete_results}

${formattedResults.length > 0 ?
          'Found files:\n' + formattedResults.map(item =>
            `- ${item.path} (score: ${item.score})`
          ).join('\n') :
          'No files found matching the search criteria.'
        }

Search query used: ${searchQuery}`;

    } catch (error) {
      return `Error searching code for "${query}": ${error instanceof Error ? error.message : "Unknown error occurred"}`;
    }
  },
  {
    name: "searchCode",
    description: "Search for specific keywords, patterns, or code within the repository. Only specify the search query — repo details come from context.",
    schema: z.object({
      query: z.string().describe("Search query (e.g., 'PrismaClient', 'findMany', '$transaction')"),
      language: z.string().nullable().describe("Filter by programming language (e.g., 'typescript', 'tsx'). Pass null if not needed."),
      extension: z.string().nullable().describe("Filter by file extension (e.g., 'ts', 'tsx'). Pass null if not needed."),
      path: z.string().nullable().describe("Filter by file path pattern (e.g., 'src/', 'api/'). Pass null if not needed."),
    }),
  }
);



// Helper function to validate GitHub access token
export async function validateGitHubToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'DevilDev-Agent'
      }
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Tool 4: Get Code Block
 * Fetches a specific line range from a file in a GitHub repository.
 * Use lineStart/lineEnd from get_flow step data to read exactly the function
 * body without fetching the full file — typically 80-90% fewer tokens.
 */
export const getCodeBlockTool = tool(
  async (input, config): Promise<string> => {
    const { owner, repo, branch, accessToken } = getGitHubContext(config);
    const { filePath, lineStart, lineEnd } = input as {
      filePath: string;
      lineStart: number;
      lineEnd: number;
    };
    try {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'DevilDev-Agent'
        }
      });

      if (!response.ok) {
        // Try default branch if specified branch fails
        if (response.status === 404) {
          const fallbackUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;
          const fallbackResp = await fetch(fallbackUrl, {
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Accept': 'application/vnd.github.v3.raw',
              'User-Agent': 'DevilDev-Agent'
            }
          });
          if (!fallbackResp.ok) {
            throw new Error(`File not found: ${filePath} (tried branch "${branch}" and default)`);
          }
          const fallbackContent = await fallbackResp.text();
          return sliceLines(fallbackContent, filePath, lineStart, lineEnd);
        }
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();
      return sliceLines(content, filePath, lineStart, lineEnd);

    } catch (error) {
      return `Error reading code block from ${filePath}:${lineStart}-${lineEnd}: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  },
  {
    name: 'getCodeBlock',
    description:
      'Fetch a specific line range from a file in the repository. ' +
      'PREFERRED over getFileContent when you have lineStart/lineEnd from get_flow step data. ' +
      'Returns only the requested lines with line numbers — uses ~80-90% fewer tokens than reading the full file. ' +
      'Only specify filePath and line range — repo details come from context.',
    schema: z.object({
      filePath: z.string().describe('File path within the repository (e.g. "src/app/api/checkout/route.ts")'),
      lineStart: z.number().describe('First line to include (1-indexed)'),
      lineEnd: z.number().describe('Last line to include (1-indexed)'),
    }),
  }
);

/** Slice file content to the given 1-indexed line range and prepend line numbers. */
function sliceLines(content: string, filePath: string, lineStart: number, lineEnd: number): string {
  const allLines = content.split('\n');
  const totalLines = allLines.length;

  // Clamp to valid range
  const start = Math.max(1, lineStart);
  const end = Math.min(totalLines, lineEnd);

  if (start > totalLines) {
    return `File ${filePath} has only ${totalLines} lines (requested lineStart=${lineStart})`;
  }

  const sliced = allLines.slice(start - 1, end);
  const numbered = sliced.map((line, i) => `${String(start + i).padStart(4, ' ')} | ${line}`);

  return [
    `Code block: ${filePath} lines ${start}–${end} (of ${totalLines} total)`,
    '',
    ...numbered,
  ].join('\n');
}
