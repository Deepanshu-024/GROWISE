import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { getRepoTreeTool } from "./agent-tools";
import { findRepositoryByAnyId } from "./repositoryLookup";

const MAX_FILE_SIZE = 500 * 1024;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolvedImport {
    importedNames: string[];
    rawPath: string;
    resolvedPath: string | null;
    isExternal: boolean;
    packageName?: string;
    unresolved: boolean;
}

interface ImportResult {
    file: string;
    totalImports: number;
    resolvedCount: number;
    unresolvedCount: number;
    imports: ResolvedImport[];
}

interface LLMImportResult {
    imports: ResolvedImport[];
}

// ─── GitHub file fetch helper (same pattern as traceFunctionTool) ─────────────

type FileCache = Map<string, string>;

async function fetchFileContent(
    owner: string,
    repo: string,
    filePath: string,
    branch: string,
    accessToken: string,
    cache: FileCache
): Promise<string | null> {
    const cacheKey = `${owner}/${repo}/${branch}/${filePath}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey)!;

    const url =
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}` +
        `?ref=${encodeURIComponent(branch)}`;

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3.raw",
            "User-Agent": "DevilDev-Agent",
        },
    });

    if (!response.ok) {
        if (response.status === 404) throw new Error(`File not found: ${filePath}`);
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE)
        throw new Error(`File too large: ${contentLength} bytes (max: ${MAX_FILE_SIZE} bytes)`);

    const content = await response.text();
    if (content.length > MAX_FILE_SIZE)
        throw new Error(`File content too large: ${content.length} characters (max: ${MAX_FILE_SIZE})`);

    cache.set(cacheKey, content);
    return content;
}

// ─── Tree parser — extract file paths from getRepoTreeTool string output ──────

function extractFilePathsFromTree(treeOutput: string): string[] {
    // getRepoTreeTool returns a string containing a JSON block with a "tree" array
    const jsonMatch = treeOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const tree: Array<{ path: string; type: string }> = parsed.tree ?? [];
        return tree.filter((n) => n.type === "blob").map((n) => n.path);
    } catch {
        return [];
    }
}

// ─── LLM chain ────────────────────────────────────────────────────────────────

const IMPORT_RESOLUTION_PROMPT = `You are a TypeScript/JavaScript import resolver.

You will be given:
1. A source file and its path in a repository
2. A list of ALL files that actually exist in the repository (the repo tree)

Your job is to extract EVERY import statement from the source file and resolve each one.

Import types to handle:
- ES6 static imports:      import {{ foo }} from "./bar"
- ES6 default imports:     import foo from "./bar"
- ES6 namespace imports:   import * as foo from "./bar"
- CommonJS require:        const foo = require("./bar")
- Dynamic imports:         const foo = await import("./bar")
- Side-effect imports:     import "./bar"

For each import, determine:
1. importedNames: array of names imported ([] for side-effect imports, ["default"] for default imports, ["*"] for namespace imports)
2. rawPath: the import path exactly as written in the source code
3. isExternal: true if it is a node_module (bare import with no ./ ../ @/ ~/ prefix), false if internal
4. resolvedPath: the actual file path in the repo (from the repo tree). Set to null if external or unresolvable.
5. packageName: only include for external imports — the npm package name (e.g. "stripe", "@clerk/nextjs")
6. unresolved: true ONLY if the import is internal but you cannot find a matching path in the repo tree

Resolution rules for INTERNAL imports:
- Relative paths (start with ./ or ../): walk relative to the directory of the current file
- Alias paths (start with @/ or ~/): treat @ and ~ as the repo root (usually maps to src/ — try both root and src/)
- Try extensions in order: .ts → .tsx → .js → .jsx → /index.ts → /index.tsx → /index.js → /index.jsx
- ONLY use paths that appear in the provided repo tree — never invent paths
- If you cannot find a match, set resolvedPath: null and unresolved: true

Current file path: {filePath}

Repo file tree (only files that actually exist):
{repoTree}

Source file content:
{fileContent}

Return ONLY valid JSON in this exact shape, no markdown, no backticks, no explanation:
{{
  "imports": [
    {{
      "importedNames": ["string"],
      "rawPath": "string",
      "resolvedPath": "string or null",
      "isExternal": boolean,
      "packageName": "string (only for external imports)",
      "unresolved": boolean
    }}
  ]
}}

If there are no imports, return {{ "imports": [] }}.`;

const importResolutionChain = PromptTemplate.fromTemplate(IMPORT_RESOLUTION_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMImportResult>());

async function invokeImportChain(
    vars: { filePath: string; repoTree: string; fileContent: string }
): Promise<LLMImportResult | null> {
    try {
        return await importResolutionChain.invoke(vars);
    } catch {
        try { return await importResolutionChain.invoke(vars); } catch { return null; }
    }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Resolve Imports
 * Fetches a source file from GitHub and resolves every import statement to
 * its actual file path in the repository. Uses the full repo tree to validate
 * resolved paths — only paths that truly exist are returned.
 *
 * Handles ES6 imports, CommonJS require(), dynamic import(), relative paths,
 * alias paths (@/, ~/), and external node_modules.
 */
export const resolveImportsTool = tool(
    async (input): Promise<string> => {
        const { repositoryId, accessToken, filePath } = input as {
            repositoryId: string;
            accessToken: string;
            filePath: string;
        };

        try {
            // 1. Read repository metadata from DB
            const repository = await findRepositoryByAnyId(repositoryId, {
                fullName: true,
                defaultBranch: true,
            });

            if (!repository) {
                return `Error: Repository with ID "${repositoryId}" not found in database. ` +
                    `Ensure framework analysis has been run before calling this tool.`;
            }

            const [owner, repo] = repository.fullName.split("/");
            const branch = repository.defaultBranch ?? "main";
            const cache: FileCache = new Map();

            // 2. Fetch the target file
            let fileContent: string | null;
            try {
                fileContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
            } catch (err) {
                return `Error: File "${filePath}" could not be fetched from ${repository.fullName}: ${err instanceof Error ? err.message : "Unknown error"
                    }`;
            }

            if (!fileContent) {
                return `Error: File "${filePath}" not found in ${repository.fullName} (branch: ${branch}).`;
            }

            // 3. Fetch the full repo tree via getRepoTreeTool
            let treeOutput: string;
            try {
                treeOutput = await getRepoTreeTool.invoke({
                    owner,
                    repo,
                    branch,
                    accessToken,
                });
            } catch (err) {
                return `Error: Failed to fetch repository tree for ${repository.fullName}: ${err instanceof Error ? err.message : "Unknown error"
                    }`;
            }

            if (treeOutput.startsWith("Error")) {
                return `Error: getRepoTreeTool failed for ${repository.fullName}: ${treeOutput}`;
            }

            // 4. Extract file paths from tree output (blob nodes only)
            const filePaths = extractFilePathsFromTree(treeOutput);
            if (filePaths.length === 0) {
                return `Error: Could not parse repository tree for ${repository.fullName}. The tree output may be malformed.`;
            }

            // Pass only the file path list to keep the prompt compact
            const repoTree = filePaths.join("\n");

            // 5. Run LLM chain to extract and resolve imports
            const llmResult = await invokeImportChain({ filePath, repoTree, fileContent });

            if (!llmResult) {
                return `Error: LLM failed to resolve imports for "${filePath}" after 2 attempts. ` +
                    `The file may be too large or the model returned invalid JSON.`;
            }

            // 6. Build result
            const imports = llmResult.imports ?? [];
            const resolvedCount = imports.filter((i) => i.resolvedPath !== null || i.isExternal).length;
            const unresolvedCount = imports.filter((i) => i.unresolved === true).length;

            const result: ImportResult = {
                file: filePath,
                totalImports: imports.length,
                resolvedCount,
                unresolvedCount,
                imports,
            };

            return JSON.stringify(result, null, 2);

        } catch (error) {
            return `Error resolving imports for "${filePath}": ${error instanceof Error ? error.message : "Unknown error occurred"
                }`;
        }
    },
    {
        name: "resolveImports",
        description: "Fetch a source file from GitHub and resolve every import statement (ES6, CommonJS, dynamic) to its actual file path in the repository. Uses the full repo tree to validate resolved paths — only paths that genuinely exist are returned. Identifies external node_modules, relative paths, and alias paths (@/, ~/).",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
            accessToken: z.string().describe("GitHub access token for fetching files via the API"),
            filePath: z.string().describe("Path to the file whose imports should be resolved (e.g. 'src/controllers/UserController.ts')"),
        }),
    }
);
