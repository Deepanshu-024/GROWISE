import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { getRepoTreeTool } from "./agent-tools";
import prisma from "@/lib/prisma";
import pLimit from "p-limit";
import {
    UiImport,
    LLMBatchImportResult,
    FrequencyEntry,
    FrequencyMap,
    FileCache,
} from "@/lib/interface/tools";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024;
const FETCH_CONCURRENCY = 10;   // parallel GitHub fetches
const BATCH_SIZE = 10;          // files per LLM call

// ─── Path filters ─────────────────────────────────────────────────────────────

const EXCLUDED_PATH_PATTERNS = [
    "node_modules",
    ".test.",
    ".spec.",
    ".d.ts",
    "/dist/",
    "/build/",
    "/__tests__/",
    "/coverage/",
    ".stories.",
    ".story.",
];

function isExcluded(filePath: string): boolean {
    return EXCLUDED_PATH_PATTERNS.some((p) => filePath.includes(p));
}

/**
 * Only target files that are route-level consumers:
 *   - Next.js App Router: page.tsx / layout.tsx / route.ts(x) / template.tsx / loading.tsx / not-found.tsx
 *   - Next.js Pages Router: pages/** /*.tsx (but NOT pages/api/**)
 *
 * This deliberately skips pure UI components (button.tsx, card.tsx…)
 * so we only track which real pages/routes consume each internal function.
 */
function isTargetFile(filePath: string): boolean {
    if (isExcluded(filePath)) return false;

    // App Router special file names
    if (/\/(page|layout|route|template|loading|not-found)\.(tsx|jsx|ts)$/.test(filePath)) {
        return true;
    }

    // Pages Router (top-level pages, not API routes)
    if (/\/pages\/(?!api\/).*\.(tsx|jsx)$/.test(filePath)) {
        return true;
    }

    return false;
}

// ─── Regex import extractor ────────────────────────────────────────────────────

const INTERNAL_PREFIXES = ["./", "../", "@/", "~/"];

function isInternalPath(importPath: string): boolean {
    return INTERNAL_PREFIXES.some((prefix) => importPath.startsWith(prefix));
}

/**
 * Extracts full import statement lines from raw source using regex.
 * Returns only internal import lines — no LLM involved.
 *
 * Handles:
 *   import { A, B } from '@/lib/foo'
 *   import A from '@/lib/foo'
 *   import * as A from '@/lib/foo'
 *   (Skips type-only and side-effect imports automatically via the `from` requirement)
 */
function extractInternalImportLines(source: string): string[] {
    // Match multi-token imports ending with `from 'path'`
    // Uses a non-greedy approach to capture the full statement up to the path
    const regex = /^import\s(?:type\s+)?(?:[^'";\n]+?from\s+)?['"]([^'"]+)['"]/gm;
    const results: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
        const importPath = match[1];
        // Skip type-only imports that use the `import type` form
        if (match[0].startsWith("import type ")) continue;
        if (isInternalPath(importPath)) {
            results.push(match[0].trimEnd());
        }
    }

    return results;
}

// ─── GitHub file fetch helper ──────────────────────────────────────────────────

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
        throw new Error(`File too large: ${contentLength} bytes`);

    const content = await response.text();
    if (content.length > MAX_FILE_SIZE)
        throw new Error(`File content too large: ${content.length} chars`);

    cache.set(cacheKey, content);
    return content;
}

// ─── Tree parser ───────────────────────────────────────────────────────────────

function extractFilePathsFromTree(treeOutput: string): string[] {
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

// ─── Batch LLM chain ──────────────────────────────────────────────────────────

/**
 * The LLM receives pre-extracted import lines (not full source) for a batch
 * of up to BATCH_SIZE files. Its job is only to:
 *   1. Parse each import line to get importedNames
 *   2. Resolve the path against the repo tree
 *   3. Detect whether the resolved file is a server action
 *
 * This is far cheaper than sending full source: we send ~5 import lines per file
 * instead of ~200 lines of source per file.
 */
const BATCH_IMPORT_RESOLUTION_PROMPT = `You are a TypeScript import resolver.

You will receive a batch of files with their ALREADY-EXTRACTED internal import statements.
Your job is to resolve each import and extract its named exports.

For each import line:
1. importedNames: string[]
   - Named imports: e.g. import {{ getProducts, getFeatured }} from '...' → ["getProducts", "getFeatured"]
   - Default import: import Foo from '...' → ["default"]
   - Namespace import: import * as Foo from '...' → ["*"]
   - Mixed: import Foo, {{ Bar }} from '...' → ["default", "Bar"]

2. rawPath: string
   - The import path exactly as written in the import statement

3. resolvedPath: string | null
   - Find the matching file in the repo tree for this rawPath
   - For alias paths (@ or ~): treat as repo root, try both root and src/ prefix
   - Try extensions in order: .ts → .tsx → .js → .jsx → /index.ts → /index.tsx → /index.js → /index.jsx
   - ONLY use paths that exist in the repo tree — never invent paths
   - If no match found: null

4. isServerAction: boolean
   - true if the resolved path contains "actions", "action", "server-actions", or "server-action" anywhere
   - false otherwise

Repo file tree (all files that actually exist):
{repoTree}

Files and their import statements to resolve:
{batchedImports}

Return ONLY valid JSON with NO markdown, NO backticks, NO explanation:
{{
  "files": [
    {{
      "filePath": "exact file path from input",
      "imports": [
        {{
          "importedNames": ["string"],
          "rawPath": "string",
          "resolvedPath": "string or null",
          "isServerAction": boolean
        }}
      ]
    }}
  ]
}}`;

const batchImportResolutionChain = PromptTemplate.fromTemplate(BATCH_IMPORT_RESOLUTION_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMBatchImportResult>());

async function invokeBatchResolutionChain(vars: {
    repoTree: string;
    batchedImports: string;
}): Promise<LLMBatchImportResult | null> {
    try {
        return await batchImportResolutionChain.invoke(vars);
    } catch {
        try {
            return await batchImportResolutionChain.invoke(vars);
        } catch {
            return null;
        }
    }
}

// ─── Batch formatter ──────────────────────────────────────────────────────────

/**
 * Formats a batch of { filePath, importLines[] } into a compact text block
 * that fits in a single LLM prompt. No source code — only import lines.
 */
function formatBatchForPrompt(
    batch: Array<{ filePath: string; importLines: string[] }>
): string {
    return batch
        .map(({ filePath, importLines }) => {
            if (importLines.length === 0) return null;
            return `=== FILE: ${filePath} ===\n${importLines.join("\n")}`;
        })
        .filter(Boolean)
        .join("\n\n");
}

// ─── Frequency classifier ─────────────────────────────────────────────────────

function classifyFrequency(count: number): "high" | "medium" | "low" {
    if (count >= 4) return "high";
    if (count >= 2) return "medium";
    return "low";
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

export const buildImportFrequencyMapTool = tool(
    async (input): Promise<string> => {
        const { repositoryId, accessToken } = input as {
            repositoryId: string;
            accessToken: string;
        };

        try {
            // 1. Read repository metadata from DB
            const repository = await prisma.repository.findUnique({
                where: { repositoryId },
                select: { fullName: true, defaultBranch: true },
            });

            if (!repository) {
                return (
                    `Error: Repository with ID "${repositoryId}" not found in database. ` +
                    `Ensure framework analysis has been run before calling this tool.`
                );
            }

            const [owner, repo] = repository.fullName.split("/");
            const branch = repository.defaultBranch ?? "main";
            const cache: FileCache = new Map();

            // 2. Fetch the full repo tree
            let treeOutput: string;
            try {
                treeOutput = await getRepoTreeTool.invoke({ owner, repo, branch, accessToken });
            } catch (err) {
                return `Error: Failed to fetch repository tree for ${repository.fullName}: ${err instanceof Error ? err.message : "Unknown error"}`;
            }

            if (treeOutput.startsWith("Error")) {
                return `Error: getRepoTreeTool failed for ${repository.fullName}: ${treeOutput}`;
            }

            const allFilePaths = extractFilePathsFromTree(treeOutput);
            if (allFilePaths.length === 0) {
                return `Error: Could not parse repository tree for ${repository.fullName}.`;
            }

            // 3. Filter to target files only (pages, layouts, routes — not UI primitives)
            const targetFiles = allFilePaths.filter(isTargetFile);

            console.log(
                `[buildImportFrequencyMap] ${allFilePaths.length} total files → ` +
                `${targetFiles.length} target files (pages/layouts/routes)`
            );

            if (targetFiles.length === 0) {
                const result: FrequencyMap = {
                    repository: repository.fullName,
                    summary: {
                        totalUiFiles: 0,
                        totalUiFilesProcessed: 0,
                        totalFunctionsTracked: 0,
                        highFrequencyCount: 0,
                        mediumFrequencyCount: 0,
                        lowFrequencyCount: 0,
                        serverActionsFound: 0,
                        skippedFiles: [],
                    },
                    functions: [],
                };
                return JSON.stringify({ ...result, message: "No page/layout/route files found in repository" }, null, 2);
            }

            // 4. Fetch all target files concurrently, then extract imports via regex
            const fetchLimit = pLimit(FETCH_CONCURRENCY);
            const skippedFiles: string[] = [];

            // Each entry: { filePath, importLines[] } — regex result, no LLM yet
            const fileImportLines: Array<{ filePath: string; importLines: string[] }> = [];

            const fetchTasks = targetFiles.map((filePath) =>
                fetchLimit(async () => {
                    let content: string | null;
                    try {
                        content = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
                    } catch {
                        skippedFiles.push(filePath);
                        return;
                    }

                    if (!content) {
                        skippedFiles.push(filePath);
                        return;
                    }

                    const importLines = extractInternalImportLines(content);
                    // Only include files that actually have internal imports
                    if (importLines.length > 0) {
                        fileImportLines.push({ filePath, importLines });
                    }
                })
            );

            await Promise.all(fetchTasks);

            console.log(
                `[buildImportFrequencyMap] Regex pass done: ` +
                `${fileImportLines.length} files have internal imports, ` +
                `${skippedFiles.length} skipped`
            );

            if (fileImportLines.length === 0) {
                const result: FrequencyMap = {
                    repository: repository.fullName,
                    summary: {
                        totalUiFiles: targetFiles.length,
                        totalUiFilesProcessed: targetFiles.length - skippedFiles.length,
                        totalFunctionsTracked: 0,
                        highFrequencyCount: 0,
                        mediumFrequencyCount: 0,
                        lowFrequencyCount: 0,
                        serverActionsFound: 0,
                        skippedFiles,
                    },
                    functions: [],
                };
                return JSON.stringify({ ...result, message: "No internal imports found in target files" }, null, 2);
            }

            // 5. Split into batches of BATCH_SIZE and resolve via LLM (one call per batch)
            const repoTree = allFilePaths.join("\n");
            const batches: Array<typeof fileImportLines> = [];
            for (let i = 0; i < fileImportLines.length; i += BATCH_SIZE) {
                batches.push(fileImportLines.slice(i, i + BATCH_SIZE));
            }

            console.log(
                `[buildImportFrequencyMap] ${fileImportLines.length} files → ` +
                `${batches.length} LLM batch(es) of up to ${BATCH_SIZE} files each`
            );

            // Map: "functionName:resolvedPath" → FrequencyEntry (mutable accumulator)
            const frequencyMap = new Map<string, FrequencyEntry>();

            for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
                const batch = batches[batchIdx];
                const batchedImports = formatBatchForPrompt(batch);

                if (!batchedImports) continue;

                console.log(`[buildImportFrequencyMap] LLM batch ${batchIdx + 1}/${batches.length}`);

                const llmResult = await invokeBatchResolutionChain({ repoTree, batchedImports });

                if (!llmResult?.files) {
                    // If batch fails, mark all files in it as skipped
                    batch.forEach(({ filePath }) => skippedFiles.push(filePath));
                    continue;
                }

                // Aggregate results from this batch
                for (const fileResult of llmResult.files) {
                    const uiFilePath = fileResult.filePath;
                    const imports: UiImport[] = fileResult.imports ?? [];

                    for (const imp of imports) {
                        for (const name of imp.importedNames) {
                            const key = `${name}:${imp.resolvedPath ?? "__unresolved__::" + imp.rawPath}`;

                            if (!frequencyMap.has(key)) {
                                frequencyMap.set(key, {
                                    name,
                                    definedIn: imp.resolvedPath,
                                    isServerAction: imp.isServerAction,
                                    uiImportCount: 0,
                                    frequency: "low",
                                    importedInUiFiles: [],
                                });
                            }

                            const entry = frequencyMap.get(key)!;

                            if (!entry.importedInUiFiles.includes(uiFilePath)) {
                                entry.uiImportCount += 1;
                                entry.importedInUiFiles.push(uiFilePath);
                            }

                            if (imp.isServerAction) entry.isServerAction = true;
                        }
                    }
                }
            }

            // 6. Finalize frequency classification
            const allEntries: FrequencyEntry[] = [];
            for (const entry of frequencyMap.values()) {
                entry.frequency = classifyFrequency(entry.uiImportCount);
                allEntries.push(entry);
            }

            // 7. Sort: descending uiImportCount, server actions first at same count
            allEntries.sort((a, b) => {
                if (b.uiImportCount !== a.uiImportCount) return b.uiImportCount - a.uiImportCount;
                const aScore = a.isServerAction ? 1 : 0;
                const bScore = b.isServerAction ? 1 : 0;
                return bScore - aScore;
            });

            // 8. Build summary
            const highFrequencyCount = allEntries.filter((e) => e.frequency === "high").length;
            const mediumFrequencyCount = allEntries.filter((e) => e.frequency === "medium").length;
            const lowFrequencyCount = allEntries.filter((e) => e.frequency === "low").length;
            const serverActionsFound = allEntries.filter((e) => e.isServerAction).length;
            const totalUiFilesProcessed = targetFiles.length - skippedFiles.length;

            console.log(
                `[buildImportFrequencyMap] Complete: ${allEntries.length} functions tracked across ` +
                `${totalUiFilesProcessed} files (${batches.length} LLM calls, ${skippedFiles.length} skipped)`
            );

            const result: FrequencyMap = {
                repository: repository.fullName,
                summary: {
                    totalUiFiles: targetFiles.length,
                    totalUiFilesProcessed,
                    totalFunctionsTracked: allEntries.length,
                    highFrequencyCount,
                    mediumFrequencyCount,
                    lowFrequencyCount,
                    serverActionsFound,
                    skippedFiles,
                },
                functions: allEntries,
            };

            return JSON.stringify(result, null, 2);

        } catch (error) {
            return `Error building import frequency map for repository "${repositoryId}": ${error instanceof Error ? error.message : "Unknown error occurred"}`;
        }
    },
    {
        name: "buildImportFrequencyMap",
        description:
            "Scans all page, layout, and route files in a repository to build a frequency map of which internal functions are imported most across the UI. " +
            "Uses regex to extract import statements, then resolves them in batches of 10 files per LLM call — significantly more efficient than per-file analysis. " +
            "Import count is a proxy for real user traffic — a function imported in 6 pages is hit far more than one imported in 1 page. " +
            "Returns all functions sorted by import frequency so the agent can prioritize which ones to investigate for DB calls and scale risks. " +
            "Server actions are identified and prioritized at the same import count. DB investigation is the agent's job — this tool only provides the frequency data.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
            accessToken: z.string().describe("GitHub access token for fetching files via the API"),
        }),
    }
);
