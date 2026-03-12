import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { getRepoTreeTool, searchCodeTool } from "./agent-tools";
import pLimit from "p-limit";
import prisma from "@/lib/prisma";


const MAX_FILE_SIZE = 500 * 1024;
const MAX_IMPORTER_DEPTH = 3;
const MAX_IMPORTERS_PER_FILE = 15;

// ─── Types ────────────────────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "info";
type OrmType = "prisma" | "mongoose" | "typeorm" | "drizzle" | "knex" | "raw" | "unknown";
type QueryType = "findMany" | "findOne" | "findFirst" | "create" | "update" | "delete" | "aggregate" | "raw" | "save" | "insert" | "other";
type FileRole = "seed" | "importer_level_1" | "importer_level_2" | "importer_level_3";

interface DbFinding {
    file: string;
    line: number;
    snippet: string;
    queryType: QueryType;
    orm: OrmType;
    patterns: {
        isInsideLoop: boolean;
        loopType: string | null;
        hasPagination: boolean;
        isSelectStar: boolean;
        hasMissingAwait: boolean;
        isNPlusOne: boolean;
        hasUnboundedResult: boolean;
        isInsideTransaction: boolean;
    };
    severity: Severity;
    reason: string;
}

interface FileSummary {
    totalQueries: number;
    criticalCount: number;
    warningCount: number;
    primaryOrm: OrmType;
    overallRisk: Severity | "low";
    topConcern: string;
}

interface FileBreakdownEntry {
    file: string;
    role: FileRole;
    fileSummary: FileSummary;
}

interface ScanResult {
    repository: string;
    summary: {
        totalFilesScanned: number;
        seedFiles: number;
        hotFiles: number;
        totalFindings: number;
        criticalCount: number;
        warningCount: number;
        infoCount: number;
        skippedFiles: string[];
    };
    findings: DbFinding[];
    fileBreakdown: FileBreakdownEntry[];
}

interface LLMFileAnalysis {
    findings: DbFinding[];
    fileSummary: FileSummary;
}

// ─── In-memory file cache ─────────────────────────────────────────────────────

type FileCache = Map<string, string>;

// ─── GitHub file fetch helper (same pattern as resolveImportsTool) ────────────

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

    if (!response.ok) return null;

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) return null;

    const content = await response.text();
    if (content.length > MAX_FILE_SIZE) return null;

    cache.set(cacheKey, content);
    return content;
}

// ─── Pass 1: Regex seed detection ────────────────────────────────────────────

const DB_PATTERNS: { orm: OrmType; regex: RegExp }[] = [
    // Prisma
    { orm: "prisma", regex: /prisma\.\w+\.(findMany|findFirst|findUnique|findOne|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|groupBy|count|execute|queryRaw)\s*\(/g },
    { orm: "prisma", regex: /prisma\.\$queryRaw/g },
    { orm: "prisma", regex: /prisma\.\$executeRaw/g },
    // Mongoose
    { orm: "mongoose", regex: /\.(find|findOne|findById|findByIdAndUpdate|findOneAndUpdate|findOneAndDelete|aggregate|save|create|insertMany|updateOne|updateMany|deleteOne|deleteMany)\s*\(/g },
    // TypeORM
    { orm: "typeorm", regex: /\.(find|findOne|findOneBy|save|create|update|delete|remove|createQueryBuilder|getRepository)\s*\(/g },
    { orm: "typeorm", regex: /repository\.\w+\s*\(/g },
    { orm: "typeorm", regex: /dataSource\.\w+\s*\(/g },
    // Drizzle
    { orm: "drizzle", regex: /db\.(select|insert|update|delete|query)\s*\(/g },
    { orm: "drizzle", regex: /\.from\s*\(/g },
    // Knex
    { orm: "knex", regex: /knex\s*\(/g },
    { orm: "knex", regex: /\.table\s*\(/g },
    // Raw SQL
    { orm: "raw", regex: /pool\.query\s*\(/g },
    { orm: "raw", regex: /client\.query\s*\(/g },
    { orm: "raw", regex: /db\.query\s*\(/g },
    { orm: "raw", regex: /connection\.query\s*\(/g },
    { orm: "raw", regex: /\.execute\s*\(/g },
    { orm: "raw", regex: /\.raw\s*\(/g },
];

const EXCLUDED_PATH_PATTERNS = [
    "node_modules", ".test.", ".spec.", ".d.ts",
    "/dist/", "/build/", "/__tests__/", "/coverage/",
];
const INCLUDED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function shouldScanFile(path: string): boolean {
    if (EXCLUDED_PATH_PATTERNS.some((p) => path.includes(p))) return false;
    return INCLUDED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function matchesDbPatterns(content: string, targetOrms?: string[]): boolean {
    for (const { orm, regex } of DB_PATTERNS) {
        if (targetOrms && targetOrms.length > 0 && !targetOrms.includes(orm)) continue;
        regex.lastIndex = 0;
        if (regex.test(content)) return true;
    }
    return false;
}

// ─── Pass 2: Backwards import tracing ────────────────────────────────────────

function stripExtension(filePath: string): string {
    return filePath.replace(/\.(ts|tsx|js|jsx)$/, "");
}

function basename(filePath: string): string {
    return filePath.split("/").pop() ?? filePath;
}

async function traceImportersOf(
    filePath: string,
    owner: string,
    repo: string,
    branch: string,
    accessToken: string,
    cache: FileCache,
    currentDepth: number,
    visited: Set<string>
): Promise<Array<{ file: string; depth: number }>> {
    if (currentDepth > MAX_IMPORTER_DEPTH) return [];
    if (visited.has(filePath)) return [];
    visited.add(filePath);

    const fileNameWithoutExt = stripExtension(filePath);
    const fileNameOnly = basename(fileNameWithoutExt);

    let searchRaw: string;
    try {
        searchRaw = await searchCodeTool.invoke({
            owner,
            repo,
            query: fileNameOnly,
            accessToken,
            language: null,
            extension: null,
            path: null,
        });
    } catch {
        return [];
    }

    // Parse file paths from searchCodeTool output ("- path (score: X)")
    const candidateFiles = [...searchRaw.matchAll(/^- (.+?) \(score:/gm)]
        .map((m) => m[1].trim())
        .filter((f) => shouldScanFile(f) && f !== filePath)
        .slice(0, MAX_IMPORTERS_PER_FILE);

    const importers: Array<{ file: string; depth: number }> = [];

    for (const candidateFile of candidateFiles) {
        if (visited.has(candidateFile)) continue;

        const content = await fetchFileContent(owner, repo, candidateFile, branch, accessToken, cache);
        if (!content) continue;

        // Verify this file actually imports our target
        const importPattern = new RegExp(
            `(import\\s+[^'"]*from\\s+['"].*${fileNameOnly}['"]|require\\s*\\(\\s*['"].*${fileNameOnly}['"]\\s*\\))`,
            "m"
        );
        if (!importPattern.test(content)) continue;

        importers.push({ file: candidateFile, depth: currentDepth });

        // Recurse up
        const deeperImporters = await traceImportersOf(
            candidateFile, owner, repo, branch, accessToken, cache,
            currentDepth + 1, visited
        );
        importers.push(...deeperImporters);
    }

    return importers;
}

// ─── Pass 3: LLM deep analysis chain ─────────────────────────────────────────

const DB_ANALYSIS_PROMPT = `You are a senior backend engineer specialising in database performance at scale.

Analyse the source file below and identify ALL database interactions.

For each finding return:
- file: the file path (exactly as given)
- line: approximate line number (count newlines from the top of the file)
- snippet: the relevant 1-3 lines of code
- queryType: one of findMany | findOne | findFirst | create | update | delete | aggregate | raw | save | insert | other
- orm: one of prisma | mongoose | typeorm | drizzle | knex | raw | unknown
- patterns object:
    isInsideLoop: true if the DB call is inside forEach/map/for/while/for...of/reduce
    loopType: "forEach" | "map" | "for" | "while" | "for...of" | null
    hasPagination: true if the query has take/limit/skip/offset/paginate
    isSelectStar: true if all fields are selected with no field filtering
    hasMissingAwait: true if an async DB call is used without await
    isNPlusOne: true if this is clearly an N+1 query pattern
    hasUnboundedResult: true if findMany/find has no limit or pagination
    isInsideTransaction: true if the call is wrapped in a transaction
- severity: "critical" | "warning" | "info"
- reason: one sentence explaining WHY this severity matters at scale

Severity rules:
- critical → isInsideLoop + isDatabaseCall, OR isNPlusOne, OR hasUnboundedResult with no pagination
- warning  → findMany missing pagination, OR isSelectStar, OR hasMissingAwait, OR deeply nested includes (3+ levels)
- info     → raw SQL usage, single direct DB calls, well-paginated queries worth noting

Also return a fileSummary:
- totalQueries: number of DB interactions found
- criticalCount: count of critical findings
- warningCount: count of warning findings
- primaryOrm: the ORM predominantly used in this file
- overallRisk: "critical" | "warning" | "low"
- topConcern: one sentence — the biggest scale risk in this file

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "findings": [ {{ ...finding... }} ],
  "fileSummary": {{ ...summary... }}
}}

If there are no DB interactions, return {{ "findings": [], "fileSummary": {{ "totalQueries": 0, "criticalCount": 0, "warningCount": 0, "primaryOrm": "unknown", "overallRisk": "low", "topConcern": "No database interactions found." }} }}

File path: {filePath}

Source file:
{fileContent}`;

const dbAnalysisChain = PromptTemplate.fromTemplate(DB_ANALYSIS_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMFileAnalysis>());

async function analyseFileWithLLM(
    filePath: string,
    fileContent: string
): Promise<LLMFileAnalysis | null> {
    try {
        return await dbAnalysisChain.invoke({ filePath, fileContent });
    } catch {
        try {
            return await dbAnalysisChain.invoke({ filePath, fileContent });
        } catch {
            return null;
        }
    }
}

// ─── Severity sort order ──────────────────────────────────────────────────────

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Scan Database Access
 * Three-pass scanner that finds every database interaction in a repository:
 *  Pass 1 — Regex: identifies files with direct DB calls (seed set)
 *  Pass 2 — Backwards import tracing: finds all files that import seed files (up to 3 levels)
 *  Pass 3 — LLM analysis: deep pattern analysis per hot file (N+1, unbounded results, missing await, etc.)
 */
export const scanDatabaseAccessTool = tool(
    async (input): Promise<string> => {
        const { repositoryId, accessToken, targetOrms } = input as {
            repositoryId: string;
            accessToken: string;
            targetOrms?: string[] | null;
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

            // 2. Fetch the full repo tree
            let treeOutput: string;
            try {
                treeOutput = await getRepoTreeTool.invoke({ owner, repo, branch, accessToken });
            } catch (err) {
                return `Error: Failed to fetch repository tree for ${repository.fullName}: ${err instanceof Error ? err.message : "Unknown error"
                    }`;
            }

            if (treeOutput.startsWith("Error")) {
                return `Error: getRepoTreeTool failed: ${treeOutput}`;
            }

            // Parse tree to get file list
            const jsonMatch = treeOutput.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return `Error: Could not parse repository tree output for ${repository.fullName}.`;

            let allFilePaths: string[];
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                allFilePaths = (parsed.tree ?? [])
                    .filter((n: { type: string; path: string }) => n.type === "blob")
                    .map((n: { path: string }) => n.path)
                    .filter(shouldScanFile);
            } catch {
                return `Error: Could not parse repository tree JSON for ${repository.fullName}.`;
            }

            console.log(`[scanDatabaseAccess] Pass 1: scanning ${allFilePaths.length} files`);

            // ── PASS 1: Regex seed detection ──────────────────────────────────────

            const seedFiles = new Set<string>();
            let totalFilesScanned = 0;

            for (const filePath of allFilePaths) {
                const content = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
                if (!content) continue;
                totalFilesScanned++;
                if (matchesDbPatterns(content, targetOrms ?? undefined)) {
                    seedFiles.add(filePath);
                }
            }

            console.log(`[scanDatabaseAccess] Pass 1 complete: ${seedFiles.size} seed files found`);

            if (seedFiles.size === 0) {
                const result: ScanResult = {
                    repository: repository.fullName,
                    summary: { totalFilesScanned, seedFiles: 0, hotFiles: 0, totalFindings: 0, criticalCount: 0, warningCount: 0, infoCount: 0, skippedFiles: [] },
                    findings: [],
                    fileBreakdown: [],
                };
                return JSON.stringify(result, null, 2);
            }

            // ── PASS 2: Backwards import tracing ──────────────────────────────────

            // Map from file → role
            const hotFileMap = new Map<string, FileRole>();
            for (const seedFile of seedFiles) {
                hotFileMap.set(seedFile, "seed");
            }

            const visited = new Set<string>([...seedFiles]);

            for (const seedFile of seedFiles) {
                const importers = await traceImportersOf(
                    seedFile, owner, repo, branch, accessToken, cache, 1, visited
                );
                for (const { file, depth } of importers) {
                    if (!hotFileMap.has(file)) {
                        hotFileMap.set(file, `importer_level_${depth}` as FileRole);
                    }
                }
            }

            console.log(`[scanDatabaseAccess] Pass 2 complete: ${hotFileMap.size} hot files total`);

            // ── PASS 3: LLM deep analysis ──────────────────────────────────────────

            console.log(`[scanDatabaseAccess] Pass 3: analysing ${hotFileMap.size} files with LLM`);

            const allFindings: DbFinding[] = [];
            const fileBreakdown: FileBreakdownEntry[] = [];
            const skippedFiles: string[] = [];

            const llmLimit = pLimit(5);

            await Promise.all(
                [...hotFileMap.entries()].map(([filePath, role]) =>
                    llmLimit(async () => {
                        try {
                            const content = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
                            if (!content) {
                                skippedFiles.push(filePath);
                                return;
                            }

                            const analysis = await analyseFileWithLLM(filePath, content);
                            if (!analysis) {
                                skippedFiles.push(filePath);
                                return;
                            }

                            const taggedFindings: DbFinding[] = (analysis.findings ?? []).map((f) => ({
                                ...f,
                                file: filePath,
                            }));

                            // Thread-safe in Node.js single-threaded model
                            allFindings.push(...taggedFindings);

                            // Only add to breakdown if LLM found DB interactions
                            if ((analysis.findings ?? []).length > 0) {
                                fileBreakdown.push({ file: filePath, role, fileSummary: analysis.fileSummary });
                            }
                        } catch {
                            skippedFiles.push(filePath);
                        }
                    })
                )
            );

            console.log(`[scanDatabaseAccess] Pass 3 complete: ${allFindings.length} findings, ${skippedFiles.length} skipped`);

            // Sort findings: critical → warning → info
            allFindings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

            // ── Assemble summary ───────────────────────────────────────────────────

            const criticalCount = allFindings.filter((f) => f.severity === "critical").length;
            const warningCount = allFindings.filter((f) => f.severity === "warning").length;
            const infoCount = allFindings.filter((f) => f.severity === "info").length;

            const result: ScanResult = {
                repository: repository.fullName,
                summary: {
                    totalFilesScanned,
                    seedFiles: seedFiles.size,
                    hotFiles: hotFileMap.size,
                    totalFindings: allFindings.length,
                    criticalCount,
                    warningCount,
                    infoCount,
                    skippedFiles,
                },
                findings: allFindings,
                fileBreakdown,
            };

            return JSON.stringify(result, null, 2);

        } catch (error) {
            return `Error scanning database access for repository "${repositoryId}": ${error instanceof Error ? error.message : "Unknown error occurred"
                }`;
        }
    },
    {
        name: "scanDatabaseAccess",
        description: "Scan an entire repository for database interactions across all ORMs (Prisma, Mongoose, TypeORM, Drizzle, Knex, raw SQL). Uses three passes: regex to find direct DB files, backwards import tracing to find all callers (up to 3 levels), and LLM deep analysis to detect N+1 queries, unbounded results, missing await, and other scale risks. Returns findings sorted by severity with a per-file breakdown.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
            accessToken: z.string().describe("GitHub access token for fetching files via the API"),
            targetOrms: z.array(z.string()).nullable().describe("Optional list of ORMs to scan for (prisma, mongoose, typeorm, drizzle, knex, raw). If null, all ORMs are detected."),
        }),
    }
);
