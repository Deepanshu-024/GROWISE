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
    LLMUiImportResult,
    FrequencyEntry,
    FrequencyMap,
    FileCache
} from "@/lib/interface/tools";

// ─── Exclusion patterns ───────────────────────────────────────────────────────
const MAX_FILE_SIZE = 500 * 1024;
const CONCURRENCY = 10;
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
    return EXCLUDED_PATH_PATTERNS.some((pattern) => filePath.includes(pattern));
}

function isUiFile(filePath: string): boolean {
    return (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) && !isExcluded(filePath);
}

// ─── GitHub file fetch helper (reused — same as resolveImportsTool) ────────────

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

// ─── Tree parser ──────────────────────────────────────────────────────────────

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


// ─── LLM chain ────────────────────────────────────────────────────────────────

const UI_IMPORT_EXTRACTION_PROMPT = `You are a TypeScript/JavaScript import analyzer focused on UI components.

You will be given:
1. The path of a UI file (.tsx or .jsx) in a repository
2. A list of ALL files that actually exist in the repository (the repo tree)
3. The source content of the UI file

Your job is to extract ONLY internal imports from this file and resolve each one.

IGNORE completely:
- External node_module imports (react, next, lodash, @radix-ui, @clerk, stripe, etc.)
- Type-only imports (import type ...)
- Side-effect imports with no named imports (import "./globals.css")

INCLUDE only imports that resolve to a file inside the repository:
- Relative paths: start with ./ or ../
- Alias paths: start with @/ or ~/ (treat @ and ~ as the repo root; try both root and src/)

For each INTERNAL import, extract:
1. importedNames: string[]
   - The specific function/component names being imported
   - e.g. ["getProducts", "getFeaturedProducts"]
   - For default imports: ["default"]
   - For namespace imports: ["*"]
   - Exclude type-only names

2. rawPath: string
   - The import path exactly as written
   - e.g. "@/lib/products" or "../../services/cart"

3. resolvedPath: string | null
   - The actual file path in the repo (from the repo tree)
   - Try extensions in this order: .ts → .tsx → .js → .jsx → /index.ts → /index.tsx → /index.js → /index.jsx
   - ONLY use paths from the provided repo tree — never invent paths
   - If no match found: null

4. isServerAction: boolean
   - true if the imported file path contains any of:
     "actions", "action", "server-actions", "server-action" anywhere in the path
   - OR if the LLM can identify this is clearly a server action file from context
   - false otherwise

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
      "isServerAction": boolean
    }}
  ]
}}

If no internal imports are found, return {{ "imports": [] }}.`;

const uiImportExtractionChain = PromptTemplate.fromTemplate(UI_IMPORT_EXTRACTION_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMUiImportResult>());

async function invokeUiImportChain(
    vars: { filePath: string; repoTree: string; fileContent: string }
): Promise<LLMUiImportResult | null> {
    try {
        return await uiImportExtractionChain.invoke(vars);
    } catch {
        try { return await uiImportExtractionChain.invoke(vars); } catch { return null; }
    }
}

// ─── Frequency classifier ─────────────────────────────────────────────────────

function classifyFrequency(count: number): "high" | "medium" | "low" {
    if (count >= 4) return "high";
    if (count >= 2) return "medium";
    return "low";
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Build Import Frequency Map
 * Scans all .tsx and .jsx UI files to build a frequency map of which internal
 * functions are imported most across the UI. Import count = proxy for how often
 * real users trigger that function. Agent uses this to weight severity of findings
 * by actual traffic patterns rather than treating all code paths equally.
 *
 * Also detects direct database calls (e.g. prisma.product.findMany()) inside
 * server components, which bypass the normal import chain entirely.
 */
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
                return `Error: Repository with ID "${repositoryId}" not found in database. ` +
                    `Ensure framework analysis has been run before calling this tool.`;
            }

            const [owner, repo] = repository.fullName.split("/");
            const branch = repository.defaultBranch ?? "main";
            const cache: FileCache = new Map();

            // 2. Fetch the full repo tree via getRepoTreeTool
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
                return `Error: Could not parse repository tree for ${repository.fullName}. The tree output may be malformed.`;
            }

            // 3. Filter to UI files only (.tsx / .jsx, excluding noise paths)
            const uiFiles = allFilePaths.filter(isUiFile);

            console.log(`[buildImportFrequencyMap] Found ${uiFiles.length} UI files (.tsx/.jsx)`);

            if (uiFiles.length === 0) {
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
                return JSON.stringify({ ...result, message: "No UI files found in repository" }, null, 2);
            }

            console.log(`[buildImportFrequencyMap] Processing ${uiFiles.length} files with concurrency ${CONCURRENCY}`);

            // Use only the file path list in the prompt to keep it compact (same as resolveImportsTool)
            const repoTree = allFilePaths.join("\n");

            // 4. Process UI files concurrently with p-limit
            const limit = pLimit(CONCURRENCY);
            const skippedFiles: string[] = [];

            // Map: "functionName:resolvedPath" → FrequencyEntry (mutable accumulator)
            const frequencyMap = new Map<string, FrequencyEntry>();

            const tasks = uiFiles.map((uiFilePath) =>
                limit(async () => {
                    // ── Fetch file content ─────────────────────────────────────────
                    let fileContent: string | null;
                    try {
                        fileContent = await fetchFileContent(owner, repo, uiFilePath, branch, accessToken, cache);
                    } catch {
                        skippedFiles.push(uiFilePath);
                        return;
                    }

                    if (!fileContent) {
                        skippedFiles.push(uiFilePath);
                        return;
                    }

                    // ── Run LLM to extract internal imports ────────────────────────
                    const llmResult = await invokeUiImportChain({ filePath: uiFilePath, repoTree, fileContent });

                    if (!llmResult) {
                        skippedFiles.push(uiFilePath);
                        return;
                    }

                    const imports: UiImport[] = llmResult.imports ?? [];

                    for (const imp of imports) {
                        for (const name of imp.importedNames) {
                            // Deduplication key: name + resolvedPath (null-safe)
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

                            // Avoid double-counting the same UI file for the same function
                            if (!entry.importedInUiFiles.includes(uiFilePath)) {
                                entry.uiImportCount += 1;
                                entry.importedInUiFiles.push(uiFilePath);
                            }

                            // Promote isServerAction if any import occurrence marks it true
                            if (imp.isServerAction) entry.isServerAction = true;
                        }
                    }
                })
            );

            await Promise.all(tasks);

            // 5. Finalize frequency classification for all entries
            const allEntries: FrequencyEntry[] = [];

            for (const entry of frequencyMap.values()) {
                entry.frequency = classifyFrequency(entry.uiImportCount);
                allEntries.push(entry);
            }

            // 6. Sort: descending uiImportCount, server actions before regular at same count
            allEntries.sort((a, b) => {
                if (b.uiImportCount !== a.uiImportCount) return b.uiImportCount - a.uiImportCount;
                // At same count: server actions first
                const aScore = a.isServerAction ? 1 : 0;
                const bScore = b.isServerAction ? 1 : 0;
                return bScore - aScore;
            });

            // 7. Build summary
            const highFrequencyCount = allEntries.filter((e) => e.frequency === "high").length;
            const mediumFrequencyCount = allEntries.filter((e) => e.frequency === "medium").length;
            const lowFrequencyCount = allEntries.filter((e) => e.frequency === "low").length;
            const serverActionsFound = allEntries.filter((e) => e.isServerAction).length;
            const totalUiFilesProcessed = uiFiles.length - skippedFiles.length;

            console.log(
                `[buildImportFrequencyMap] Complete: ${allEntries.length} functions tracked, ` +
                `${highFrequencyCount} high frequency, ${skippedFiles.length} files skipped`
            );

            const result: FrequencyMap = {
                repository: repository.fullName,
                summary: {
                    totalUiFiles: uiFiles.length,
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
            "Scans all .tsx and .jsx UI files in a repository to build a frequency map of which internal functions are imported most across the UI. " +
            "Import count is a proxy for how often real users trigger that function — a function imported in 6 UI files is hit far more than one imported in 1 file. " +
            "Returns all functions sorted by import frequency so the agent can prioritize which ones to investigate for DB calls, performance issues, and scale risks. " +
            "Server actions are identified and prioritized at the same import count. DB investigation is the agent's job — this tool only provides the frequency data.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
            accessToken: z.string().describe("GitHub access token for fetching files via the API"),
        }),
    }
);
