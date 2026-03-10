import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { searchCodeTool } from "./agent-tools";
import prisma from "@/lib/prisma";

// ─── Shared in-memory file cache (keyed by "owner/repo/branch/path") ─────────
type FileCache = Map<string, string>;

const MAX_FILE_SIZE = 500 * 1024;
const MAX_DEPTH = 3;

// ─── Output Types ─────────────────────────────────────────────────────────────

interface DownstreamCall {
    callee: string;
    calleeFile: string | null;
    depth: number;
    isInsideLoop: boolean;
    loopType: string | null;
    isDatabaseCall: boolean;
}

interface UpstreamCall {
    callerFunction: string;
    callerFile: string;
    depth: number;
    isRouteHandler: boolean;
    routePath: string | null;
    isPublicRoute: boolean | null;
    upstream?: UpstreamCall[];
}

interface ScaleSummary {
    reachableFromPublicRoute: boolean;
    hasDbCallsInsideLoop: boolean;
    estimatedCallFrequency: "every_request" | "authenticated_only" | "admin_only" | "unknown";
    loopedDbCallCount: number;
    maxDepthReached: number;
}

interface TraceResult {
    function: string;
    file: string;
    downstream: DownstreamCall[];
    upstream: UpstreamCall[];
    scaleSummary: ScaleSummary;
}

// LLM JSON shapes
interface LLMDownstreamResult {
    calls: Array<{
        callee: string;
        importSource: string | null;
        isInsideLoop: boolean;
        loopType: string | null;
        isDatabaseCall: boolean;
    }>;
}

interface LLMUpstreamResult {
    callerFunction: string;
    isRouteHandler: boolean;
    routePath: string | null;
    isPublicRoute: boolean | null;
}

// ─── GitHub file fetch helper ─────────────────────────────────────────────────

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

// ─── LLM Chains ──────────────────────────────────────────────────────────────

const DOWNSTREAM_PROMPT = `You are a static code analysis assistant.

Given the source file and the target function name, extract every function call made INSIDE that function body.

For each call, determine:
1. The callee name (the function being called).
2. Which import it comes from (check the import statements). Use null if local or unknown.
3. Whether the call is inside a loop (forEach, map, for, while, for...of, for...in, reduce). Only true if certain.
4. The loop type string if inside a loop, otherwise null.
5. Whether it looks like a database operation (prisma., db., model., .find, .create, .update, .delete, .query, .execute, .save, .insert, .select, .where).

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "calls": [
    {{
      "callee": "string",
      "importSource": "string or null",
      "isInsideLoop": boolean,
      "loopType": "string or null",
      "isDatabaseCall": boolean
    }}
  ]
}}

If the function is not found, return {{ "calls": [] }}.

Target function: {functionName}
File path: {filePath}

Source file:
{fileContent}`;

const UPSTREAM_PROMPT = `You are a static code analysis assistant.

Given the source file, determine where the function "{functionName}" is called and classify the call site.

Determine:
1. The name of the function or handler that contains the call.
2. Whether that wrapper is a route handler (Express router.get/post/put/delete/patch, Next.js GET/POST/PUT/DELETE named exports, app.get, Fastify/Hono route registration).
3. The route path string if it is a route handler (e.g. "/api/users"), otherwise null.
4. Whether the route is public (no auth middleware visible) or protected. Use null if unknown.

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "callerFunction": "string",
  "isRouteHandler": boolean,
  "routePath": "string or null",
  "isPublicRoute": boolean or null
}}

If "{functionName}" is not called in this file, return:
{{ "callerFunction": "unknown", "isRouteHandler": false, "routePath": null, "isPublicRoute": null }}

Function to find: {functionName}
File path: {filePath}

Source file:
{fileContent}`;

const downstreamChain = PromptTemplate.fromTemplate(DOWNSTREAM_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMDownstreamResult>());

const upstreamChain = PromptTemplate.fromTemplate(UPSTREAM_PROMPT)
    .pipe(gpt4oMini)
    .pipe(new JsonOutputParser<LLMUpstreamResult>());

// ─── Concrete LLM call helpers with single retry ────────────────────────────────────

async function invokeDownstreamChain(
    vars: { functionName: string; filePath: string; fileContent: string }
): Promise<LLMDownstreamResult | null> {
    try {
        return await downstreamChain.invoke(vars);
    } catch {
        try { return await downstreamChain.invoke(vars); } catch { return null; }
    }
}

async function invokeUpstreamChain(
    vars: { functionName: string; filePath: string; fileContent: string }
): Promise<LLMUpstreamResult | null> {
    try {
        return await upstreamChain.invoke(vars);
    } catch {
        try { return await upstreamChain.invoke(vars); } catch { return null; }
    }
}

// ─── Downstream traversal ─────────────────────────────────────────────────────

async function traceDownstream(
    functionName: string,
    filePath: string,
    owner: string,
    repo: string,
    branch: string,
    accessToken: string,
    cache: FileCache,
    depth: number
): Promise<DownstreamCall[]> {
    if (depth > MAX_DEPTH) return [];

    const content = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
    if (!content) return [];

    const result = await invokeDownstreamChain({ functionName, filePath, fileContent: content });

    if (!result) return [];

    return (result.calls ?? []).map((c) => ({
        callee: c.callee,
        calleeFile: c.importSource ?? null,
        depth,
        isInsideLoop: c.isInsideLoop ?? false,
        loopType: c.loopType ?? null,
        isDatabaseCall: c.isDatabaseCall ?? false,
    }));
}

// ─── Upstream traversal ───────────────────────────────────────────────────────

async function traceUpstream(
    functionName: string,
    owner: string,
    repo: string,
    branch: string,
    accessToken: string,
    cache: FileCache,
    depth: number
): Promise<UpstreamCall[]> {
    if (depth > MAX_DEPTH) return [];

    // Use searchCodeTool to find all files that reference this function
    let searchResultRaw: string;
    try {
        searchResultRaw = await searchCodeTool.invoke({
            owner,
            repo,
            query: functionName,
            accessToken,
            language: null,
            extension: null,
            path: null,
        });
    } catch {
        return [];
    }

    // Parse file paths from searchCodeTool string output ("- path (score: X)")
    const callerFiles = [...searchResultRaw.matchAll(/^- (.+?) \(score:/gm)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .slice(0, 10); // cap at 10 call sites to avoid runaway cost

    const upstreamCalls: UpstreamCall[] = [];

    for (const callerFile of callerFiles) {
        const content = await fetchFileContent(owner, repo, callerFile, branch, accessToken, cache);
        if (!content) continue;

        const llmResult = await invokeUpstreamChain({
            functionName,
            filePath: callerFile,
            fileContent: content,
        });

        if (!llmResult || llmResult.callerFunction === "unknown") continue;

        const node: UpstreamCall = {
            callerFunction: llmResult.callerFunction,
            callerFile,
            depth,
            isRouteHandler: llmResult.isRouteHandler ?? false,
            routePath: llmResult.routePath ?? null,
            isPublicRoute: llmResult.isPublicRoute ?? null,
        };

        // Recurse up unless already at a route handler or max depth
        if (!node.isRouteHandler && depth < MAX_DEPTH) {
            node.upstream = await traceUpstream(
                llmResult.callerFunction,
                owner,
                repo,
                branch,
                accessToken,
                cache,
                depth + 1
            );
        }

        upstreamCalls.push(node);
    }

    return upstreamCalls;
}

// ─── Scale summary computation ────────────────────────────────────────────────

function collectRouteLeaves(nodes: UpstreamCall[]): UpstreamCall[] {
    const leaves: UpstreamCall[] = [];
    for (const node of nodes) {
        if (node.isRouteHandler) {
            leaves.push(node);
        } else if (node.upstream && node.upstream.length > 0) {
            leaves.push(...collectRouteLeaves(node.upstream));
        }
    }
    return leaves;
}

function computeMaxDepth(nodes: UpstreamCall[]): number {
    if (nodes.length === 0) return 0;
    return Math.max(...nodes.map((n) => Math.max(n.depth, computeMaxDepth(n.upstream ?? []))));
}

function buildScaleSummary(downstream: DownstreamCall[], upstream: UpstreamCall[]): ScaleSummary {
    const loopedDbCalls = downstream.filter((d) => d.isInsideLoop && d.isDatabaseCall);
    const routeLeaves = collectRouteLeaves(upstream);
    const publicRoutes = routeLeaves.filter((n) => n.isPublicRoute === true);

    let estimatedCallFrequency: ScaleSummary["estimatedCallFrequency"] = "unknown";
    if (publicRoutes.length > 0) {
        estimatedCallFrequency = "every_request";
    } else if (routeLeaves.some((n) => n.isPublicRoute === false)) {
        estimatedCallFrequency = "authenticated_only";
    }

    const downstreamMaxDepth = downstream.reduce((m, d) => Math.max(m, d.depth), 0);
    const upstreamMaxDepth = computeMaxDepth(upstream);

    return {
        reachableFromPublicRoute: publicRoutes.length > 0,
        hasDbCallsInsideLoop: loopedDbCalls.length > 0,
        estimatedCallFrequency,
        loopedDbCallCount: loopedDbCalls.length,
        maxDepthReached: Math.max(downstreamMaxDepth, upstreamMaxDepth),
    };
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Trace Function
 * Traces a function's call graph in both directions:
 *  - Downstream: what the function calls (loop detection, DB detection, import resolution)
 *  - Upstream: who calls this function, recursing up to route handlers (max depth 3)
 *
 * Uses an in-memory file cache to avoid fetching the same file twice per invocation.
 * All LLM calls use LangChain LCEL chains (PromptTemplate | gpt4oMini | JsonOutputParser).
 */
export const traceFunctionTool = tool(
    async (input): Promise<string> => {
        const { repositoryId, accessToken, filePath, functionName, direction, depth } = input as {
            repositoryId: string;
            accessToken: string;
            filePath: string;
            functionName: string;
            direction: "upstream" | "downstream" | "both";
            depth?: number | null;
        };

        const effectiveMaxDepth = Math.min(depth ?? MAX_DEPTH, MAX_DEPTH);

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

            // 2. Per-invocation in-memory file cache
            const cache: FileCache = new Map();

            // 3. Verify the target file is accessible
            const targetContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
            if (!targetContent) {
                return `Error: File "${filePath}" not found in ${repository.fullName} (branch: ${branch}). ` +
                    `Check the file path and ensure the access token has read permissions.`;
            }

            // 4. Run requested direction(s)
            let downstream: DownstreamCall[] = [];
            let upstream: UpstreamCall[] = [];

            if (direction === "downstream" || direction === "both") {
                downstream = await traceDownstream(
                    functionName, filePath, owner, repo, branch, accessToken, cache, 1
                );
            }

            if (direction === "upstream" || direction === "both") {
                upstream = await traceUpstream(
                    functionName, owner, repo, branch, accessToken, cache, 1
                );
            }

            // 5. Build result
            const scaleSummary = buildScaleSummary(downstream, upstream);
            scaleSummary.maxDepthReached = Math.min(scaleSummary.maxDepthReached, effectiveMaxDepth);

            const result: TraceResult = {
                function: functionName,
                file: filePath,
                downstream,
                upstream,
                scaleSummary,
            };

            return JSON.stringify(result, null, 2);

        } catch (error) {
            return `Error tracing function "${functionName}" in "${filePath}": ${error instanceof Error ? error.message : "Unknown error occurred"
                }`;
        }
    },
    {
        name: "traceFunction",
        description: "Trace a function's call graph upstream (who calls it, up to route handlers) and downstream (what it calls, with loop and DB detection). Fetches source files from GitHub, uses an LLM to analyse call relationships, and recurses to a max depth of 3. Returns a structured JSON tree with a scaleSummary showing whether the function is reachable from a public route, has DB calls inside loops, and estimated call frequency.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
            accessToken: z.string().describe("GitHub access token for fetching files via the API"),
            filePath: z.string().describe("Path to the file containing the function (e.g. 'src/services/UserService.ts')"),
            functionName: z.string().describe("Name of the function to trace (e.g. 'getUsersWithPosts')"),
            direction: z.enum(["upstream", "downstream", "both"]).describe("Which direction to trace the call graph"),
            depth: z.number().nullable().describe("Max recursion depth (default 3, hard max 3)"),
        }),
    }
);
