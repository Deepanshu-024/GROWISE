import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import { findRepositoryByAnyId } from "./repositoryLookup";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_MIDDLEWARE_FILES = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LLMMiddlewareResult {
  middlewareType: string;
  authMethod: string | null;
  hasRateLimit: boolean;
  isGlobalProtection: boolean;
  matcherPatterns: string[];
  publicRoutes: string[];
  protectedRoutePatterns: string[];
  middlewareSummary: string;
}

interface MiddlewareFileResult {
  file: string;
  middlewareType: string;
  authMethod: string | null;
  hasRateLimit: boolean;
  isGlobalProtection: boolean;
  matcherPatterns: string[];
  publicRoutes: string[];
  protectedRoutePatterns: string[];
  middlewareSummary: string;
}

interface RouteCoverage {
  route: string;
  coveredByMiddleware: boolean;
  middlewareFile: string | null;
  coverageType: "global" | "pattern_match" | "none";
}

interface MiddlewareChainResult {
  repository: string;
  framework: string;
  routerType: string;
  skippedFiles: string[];
  middlewareFiles: MiddlewareFileResult[];
  routeCoverage: RouteCoverage[];
  summary: {
    totalMiddlewareFiles: number;
    middlewareFilesSkipped: number;
    routesCoveredByMiddleware: number;
    routesNotCoveredByMiddleware: number;
    hasGlobalRateLimit: boolean;
    middlewareAuthProviders: string[];
  };
  message?: string;
}

// ─── In-memory file cache ─────────────────────────────────────────────────────

type FileCache = Map<string, string>;

// ─── GitHub file fetch helper (same pattern as getRouteMapTool) ───────────────

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

// ─── GitHub repo tree fetch helper ────────────────────────────────────────────

interface RepoTreeNode {
  path: string;
  type: "blob" | "tree";
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  branch: string,
  accessToken: string
): Promise<RepoTreeNode[] | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "DevilDev-Agent",
    },
  });

  if (!response.ok) {
    // Try 'master' if 'main' fails
    if (response.status === 404 && branch === "main") {
      const masterResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/master?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "DevilDev-Agent",
          },
        }
      );
      if (!masterResponse.ok) return null;
      const masterData = await masterResponse.json();
      return (masterData.tree as RepoTreeNode[]) ?? null;
    }
    return null;
  }

  const data = await response.json();
  return (data.tree as RepoTreeNode[]) ?? null;
}

// ─── Router type detection ───────────────────────────────────────────────────

function detectRouterType(
  knownRoutes: string[],
  framework: string | null
): "nextjs-app-router" | "nextjs-pages-router" | "react-custom" | "mixed" {
  if (!framework || framework === "react") return "react-custom";

  const hasAppRouter = knownRoutes.some(
    (r) => r.includes("/app/api/") || r.startsWith("/api/")
  );
  const hasPagesRouter = knownRoutes.some(
    (r) => r.includes("/pages/api/")
  );

  if (hasAppRouter && hasPagesRouter) return "mixed";
  if (hasPagesRouter) return "nextjs-pages-router";
  return "nextjs-app-router"; // default for Next.js
}

// ─── Middleware file exclusion patterns ───────────────────────────────────────

const EXCLUDED_PATTERNS = [
  "node_modules",
  ".test.",
  ".spec.",
  ".d.ts",
  "dist/",
  "build/",
];

function isExcludedFile(filePath: string): boolean {
  return EXCLUDED_PATTERNS.some((pattern) => filePath.includes(pattern));
}

// ─── Middleware file discovery ────────────────────────────────────────────────

function discoverMiddlewareFiles(
  tree: RepoTreeNode[],
  framework: string | null
): string[] {
  const files = tree
    .filter((node) => node.type === "blob")
    .map((node) => node.path);

  const middlewareFiles: Set<string> = new Set();

  // Next.js middleware (exact paths)
  const nextjsMiddlewarePaths = [
    "middleware.ts",
    "middleware.js",
    "src/middleware.ts",
    "src/middleware.js",
  ];

  // Next.js Pages Router additional patterns
  const pagesMiddlewarePaths = [
    "pages/_middleware.ts",
    "pages/api/_middleware.ts",
    "src/pages/_middleware.ts",
    "src/pages/api/_middleware.ts",
  ];

  // Check exact Next.js middleware paths
  for (const mwPath of nextjsMiddlewarePaths) {
    if (files.includes(mwPath)) {
      middlewareFiles.add(mwPath);
    }
  }

  // Check Pages Router middleware paths
  for (const mwPath of pagesMiddlewarePaths) {
    if (files.includes(mwPath)) {
      middlewareFiles.add(mwPath);
    }
  }

  // React custom backend patterns
  if (!framework || framework === "react") {
    for (const filePath of files) {
      if (isExcludedFile(filePath)) continue;

      // Files in middleware/ or middlewares/ folders
      const segments = filePath.split("/");
      if (
        segments.some(
          (seg) => seg === "middleware" || seg === "middlewares"
        )
      ) {
        middlewareFiles.add(filePath);
        continue;
      }

      // Files named middleware.ts/.js at any level
      const fileName = segments[segments.length - 1];
      if (
        fileName === "middleware.ts" ||
        fileName === "middleware.js"
      ) {
        middlewareFiles.add(filePath);
        continue;
      }

      // Root or src/ level app.ts, app.js, server.ts, server.js
      const appServerNames = ["app.ts", "app.js", "server.ts", "server.js"];
      if (
        appServerNames.includes(fileName) &&
        (segments.length === 1 ||
          (segments.length === 2 && segments[0] === "src"))
      ) {
        middlewareFiles.add(filePath);
      }
    }
  }

  // Also check custom backend patterns for Next.js projects
  // (they might have an Express/custom server in addition)
  if (framework && framework !== "react") {
    for (const filePath of files) {
      if (isExcludedFile(filePath)) continue;

      const segments = filePath.split("/");
      if (
        segments.some(
          (seg) => seg === "middleware" || seg === "middlewares"
        )
      ) {
        middlewareFiles.add(filePath);
      }
    }
  }

  // Filter out excluded and cap at MAX_MIDDLEWARE_FILES
  const result = Array.from(middlewareFiles)
    .filter((f) => !isExcludedFile(f))
    .slice(0, MAX_MIDDLEWARE_FILES);

  return result;
}

// ─── Framework-specific middleware hints ──────────────────────────────────────

const MIDDLEWARE_FRAMEWORK_HINTS: Record<string, string> = {
  "nextjs-app-router": `This is a Next.js App Router middleware file (middleware.ts). Look for: clerkMiddleware() from @clerk/nextjs/server, withAuth() from next-auth/middleware, authMiddleware() (older Clerk API), createMiddleware() from @supabase/auth-helpers-nextjs. The config export with matcher array controls which routes this middleware applies to. publicRoutes array or isPublicRoute() calls mark routes as explicitly public.`,
  "nextjs-pages-router": `This is a Next.js Pages Router middleware file. Look for: withAuth from next-auth/middleware, withApiAuthRequired from @auth0/nextjs-auth0, getSession checks, custom session validation. _middleware.ts files apply to routes in the same directory.`,
  "react-custom": `This is a custom backend middleware file (Express/Fastify/Koa). Look for: app.use() calls for global middleware, router.use() for scoped middleware, passport.authenticate(), jwt.verify() middleware, custom auth functions applied as middleware arrays. Rate limiting via express-rate-limit or similar.`,
  mixed: `This is a Next.js App Router middleware file (middleware.ts). Look for: clerkMiddleware() from @clerk/nextjs/server, withAuth() from next-auth/middleware, authMiddleware() (older Clerk API), createMiddleware() from @supabase/auth-helpers-nextjs. The config export with matcher array controls which routes this middleware applies to. publicRoutes array or isPublicRoute() calls mark routes as explicitly public.`,
  unknown: `Analyze this file and extract any middleware configuration you find regardless of the framework.`,
};

function getMiddlewareFrameworkHint(routerType: string): string {
  return MIDDLEWARE_FRAMEWORK_HINTS[routerType.toLowerCase()] ?? MIDDLEWARE_FRAMEWORK_HINTS.unknown;
}

// ─── LLM middleware extraction chain ─────────────────────────────────────────

const MIDDLEWARE_EXTRACTION_PROMPT = `You are analyzing a middleware file from a {routerType} application.
The framework is: {framework}.

Framework-specific guidance:
{frameworkHint}

Extract the middleware configuration from this file.
Return ONLY raw facts — no recommendations, no severity judgments.
If you cannot determine a value with confidence: use null or false.
Never guess.

Extract the following:

middlewareType: string
  The type of middleware:
  "clerk" | "nextauth" | "auth0" | "supabase" |
  "jwt" | "session" | "custom" | "rate-limit" |
  "cors" | "logging" | "multiple" | "unknown"

authMethod: string | null
  The specific auth function/method used:
  e.g. "clerkMiddleware", "withAuth", "authMiddleware",
       "getServerSession", "withApiAuthRequired",
       "jwt.verify", "passport.authenticate"
  null if no auth in this middleware

hasRateLimit: boolean
  true if any rate limiting is configured in this file:
  upstash/ratelimit, express-rate-limit, custom rate limiting,
  redis-based rate limiting
  false if none detected

isGlobalProtection: boolean
  true if this middleware applies to ALL routes with no matcher
  false if it has a matcher config limiting which routes it covers

matcherPatterns: string[]
  Array of route patterns this middleware matches against
  For Next.js: the matcher array from the config export
    e.g. ["/dashboard(.*)", "/api/(.*)"]
  For Express: the paths passed to app.use()
    e.g. ["/api"] or [] if global
  Empty array if isGlobalProtection is true OR no matcher found

publicRoutes: string[]
  Routes explicitly marked as public/excluded from auth:
  For Clerk: routes in publicRoutes array or isPublicRoute checks
  For NextAuth: routes excluded from withAuth
  For custom: routes with explicit public/skip checks
  Empty array if none found

protectedRoutePatterns: string[]
  The effective patterns that ARE protected by this middleware
  If isGlobalProtection: ["(.*)"] meaning everything
  If has matcher: same as matcherPatterns minus publicRoutes
  If custom logic: extract the patterns from conditional checks

middlewareSummary: string
  One sentence describing what this middleware does
  e.g. "Clerk middleware protecting all /api and /dashboard routes,
        with webhooks explicitly marked as public"

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "middlewareType": "string",
  "authMethod": "string or null",
  "hasRateLimit": boolean,
  "isGlobalProtection": boolean,
  "matcherPatterns": ["string"],
  "publicRoutes": ["string"],
  "protectedRoutePatterns": ["string"],
  "middlewareSummary": "string"
}}

If this file is not actually a middleware file, return:
{{
  "middlewareType": "unknown",
  "authMethod": null,
  "hasRateLimit": false,
  "isGlobalProtection": false,
  "matcherPatterns": [],
  "publicRoutes": [],
  "protectedRoutePatterns": [],
  "middlewareSummary": "Not a middleware file"
}}

File path: {filePath}

Middleware file content:
{fileContent}`;

const middlewareExtractionChain = PromptTemplate.fromTemplate(MIDDLEWARE_EXTRACTION_PROMPT)
  .pipe(gpt4oMini)
  .pipe(new JsonOutputParser<LLMMiddlewareResult>());

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

async function extractMiddlewareFromFile(
  filePath: string,
  fileContent: string,
  routerType: string,
  framework: string
): Promise<LLMMiddlewareResult | null> {
  const vars = {
    filePath,
    fileContent,
    routerType,
    framework,
    frameworkHint: getMiddlewareFrameworkHint(routerType),
  };

  try {
    return await middlewareExtractionChain.invoke(vars);
  } catch (err) {
    if (!isRateLimitError(err)) {
      console.warn(`[getMiddlewareChain] Non-retryable error for "${filePath}":`, err);
      return null;
    }

    // Rate limit — wait 5 s then retry once
    console.warn(`[getMiddlewareChain] Rate limit hit for "${filePath}", retrying in 5 s…`);
    await new Promise((res) => setTimeout(res, 5_000));

    try {
      return await middlewareExtractionChain.invoke(vars);
    } catch (retryErr) {
      console.warn(`[getMiddlewareChain] Retry also failed for "${filePath}":`, retryErr);
      return null;
    }
  }
}

// ─── Route coverage analysis (TypeScript, not LLM) ──────────────────────────

function routeMatchesPattern(route: string, pattern: string): boolean {
  // Simple prefix matching:
  // pattern "/api/(.*)" covers "/api/products" ✅
  // pattern "/dashboard(.*)" covers "/dashboard/settings" ✅
  // pattern "/api/(.*)" does NOT cover "/webhook" ❌

  // Strip regex parts like (.*), (.+), etc. to get the prefix
  const prefix = pattern
    .replace(/\(\.\*\)/g, "")
    .replace(/\(\.\+\)/g, "")
    .replace(/\/+$/, ""); // remove trailing slashes

  if (!prefix) {
    // Pattern like "(.*)" matches everything
    return true;
  }

  return route === prefix || route.startsWith(prefix + "/") || route.startsWith(prefix);
}

function routeMatchesAnyPublicRoute(route: string, publicRoutes: string[]): boolean {
  return publicRoutes.some((publicRoute) => routeMatchesPattern(route, publicRoute));
}

function analyzeRouteCoverage(
  knownRoutes: string[],
  middlewareFiles: MiddlewareFileResult[]
): RouteCoverage[] {
  const coverage: RouteCoverage[] = [];

  for (const route of knownRoutes) {
    let isCoveredByMiddleware = false;
    let coveringMiddlewareFile: string | null = null;
    let coverageType: "global" | "pattern_match" | "none" = "none";

    for (const mw of middlewareFiles) {
      // Skip non-auth middleware (e.g. cors, logging only)
      if (mw.middlewareType === "unknown") continue;

      if (mw.isGlobalProtection) {
        // Check if route is in publicRoutes
        if (!routeMatchesAnyPublicRoute(route, mw.publicRoutes)) {
          isCoveredByMiddleware = true;
          coveringMiddlewareFile = mw.file;
          coverageType = "global";
          break;
        }
      } else if (mw.protectedRoutePatterns.length > 0) {
        // Check if route matches any protected pattern
        const matches = mw.protectedRoutePatterns.some((pattern) =>
          routeMatchesPattern(route, pattern)
        );
        if (matches) {
          // Also check it's not in publicRoutes
          if (!routeMatchesAnyPublicRoute(route, mw.publicRoutes)) {
            isCoveredByMiddleware = true;
            coveringMiddlewareFile = mw.file;
            coverageType = "pattern_match";
            break;
          }
        }
      }
    }

    coverage.push({
      route,
      coveredByMiddleware: isCoveredByMiddleware,
      middlewareFile: coveringMiddlewareFile,
      coverageType,
    });
  }

  return coverage;
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Get Middleware Chain
 * Discovers middleware files in the repository automatically,
 * extracts middleware configuration using LLM, and cross-references
 * against known routes to determine middleware coverage.
 * Returns raw coverage facts only — the agent determines true
 * protection status by cross-referencing with getRouteMapTool.
 */
export const getMiddlewareChainTool = tool(
  async (input): Promise<string> => {
    const { repositoryId, accessToken, knownRoutes } = input as {
      repositoryId: string;
      accessToken: string;
      knownRoutes: string[];
    };

    try {
      // ── Step 1: Read repository metadata from DB ──────────────────────────

      const repository = await findRepositoryByAnyId(repositoryId, {
        fullName: true,
        defaultBranch: true,
        framework: true,
      });

      if (!repository) {
        return `Error: Repository with ID "${repositoryId}" not found in database. ` +
          `Ensure framework analysis has been run before calling this tool.`;
      }

      const [owner, repo] = repository.fullName.split("/");
      const branch = repository.defaultBranch ?? "main";
      const framework = repository.framework ?? "next";
      const routerType = detectRouterType(knownRoutes, framework);
      const cache: FileCache = new Map();
      const skippedFiles: string[] = [];

      // ── Step 2: Discover middleware files internally ───────────────────────

      console.log(`[getMiddlewareChain] Scanning repo tree for middleware files`);

      const tree = await fetchRepoTree(owner, repo, branch, accessToken);

      if (!tree) {
        return `Error: Failed to fetch repository tree for "${repository.fullName}". ` +
          `Ensure the access token is valid and the repository exists.`;
      }

      const middlewareFilePaths = discoverMiddlewareFiles(tree, framework);

      console.log(`[getMiddlewareChain] Found ${middlewareFilePaths.length} middleware files`);
      console.log(
        `[getMiddlewareChain] Framework: ${framework}, ` +
        `Router type: ${routerType}`
      );

      // If no middleware files found, return early with empty result
      if (middlewareFilePaths.length === 0) {
        const emptyResult: MiddlewareChainResult = {
          repository: repository.fullName,
          framework,
          routerType,
          skippedFiles: [],
          middlewareFiles: [],
          routeCoverage: knownRoutes.map((route) => ({
            route,
            coveredByMiddleware: false,
            middlewareFile: null,
            coverageType: "none" as const,
          })),
          summary: {
            totalMiddlewareFiles: 0,
            middlewareFilesSkipped: 0,
            routesCoveredByMiddleware: 0,
            routesNotCoveredByMiddleware: knownRoutes.length,
            hasGlobalRateLimit: false,
            middlewareAuthProviders: [],
          },
          message: "No middleware files found in repository. Routes may rely entirely on handler-level auth checks.",
        };

        console.log(
          `[getMiddlewareChain] Complete: 0 middleware files, 0 routes covered, ${knownRoutes.length} routes not covered`
        );

        return JSON.stringify(emptyResult, null, 2);
      }

      // ── Step 3: LLM extraction per middleware file ────────────────────────

      const allMiddleware: MiddlewareFileResult[] = [];

      for (const filePath of middlewareFilePaths) {
        console.log(`[getMiddlewareChain] Analyzing: ${filePath}`);

        const fileContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
        if (!fileContent) {
          skippedFiles.push(filePath);
          continue;
        }

        const llmResult = await extractMiddlewareFromFile(filePath, fileContent, routerType, framework);
        if (!llmResult) {
          skippedFiles.push(filePath);
          continue;
        }

        allMiddleware.push({
          file: filePath,
          middlewareType: llmResult.middlewareType,
          authMethod: llmResult.authMethod,
          hasRateLimit: llmResult.hasRateLimit,
          isGlobalProtection: llmResult.isGlobalProtection,
          matcherPatterns: llmResult.matcherPatterns,
          publicRoutes: llmResult.publicRoutes,
          protectedRoutePatterns: llmResult.protectedRoutePatterns,
          middlewareSummary: llmResult.middlewareSummary,
        });
      }

      // ── Step 4: Route coverage analysis (TypeScript, not LLM) ─────────────

      console.log(
        `[getMiddlewareChain] Analyzing route coverage for ${knownRoutes.length} routes`
      );

      const routeCoverage = analyzeRouteCoverage(knownRoutes, allMiddleware);

      // ── Build summary ─────────────────────────────────────────────────────

      const coveredCount = routeCoverage.filter((r) => r.coveredByMiddleware).length;
      const notCoveredCount = routeCoverage.filter((r) => !r.coveredByMiddleware).length;
      const hasGlobalRateLimit = allMiddleware.some((m) => m.hasRateLimit && m.isGlobalProtection);

      // Collect unique auth providers from middleware files
      const middlewareAuthProviders = Array.from(
        new Set(
          allMiddleware
            .map((m) => m.middlewareType)
            .filter((t) => t !== "unknown" && t !== "cors" && t !== "logging")
        )
      );

      console.log(
        `[getMiddlewareChain] Complete: ${allMiddleware.length} middleware files, ${coveredCount} routes covered, ${notCoveredCount} routes not covered`
      );

      const result: MiddlewareChainResult = {
        repository: repository.fullName,
        framework,
        routerType,
        skippedFiles,
        middlewareFiles: allMiddleware,
        routeCoverage,
        summary: {
          totalMiddlewareFiles: allMiddleware.length,
          middlewareFilesSkipped: skippedFiles.length,
          routesCoveredByMiddleware: coveredCount,
          routesNotCoveredByMiddleware: notCoveredCount,
          hasGlobalRateLimit,
          middlewareAuthProviders,
        },
      };

      return JSON.stringify(result, null, 2);

    } catch (error) {
      return `Error analyzing middleware chain for repository "${repositoryId}": ${
        error instanceof Error ? error.message : "Unknown error occurred"
      }`;
    }
  },
  {
    name: "getMiddlewareChain",
    description: "Discovers middleware files in the repository automatically and extracts middleware configuration including auth provider, matcher patterns, public routes, and rate limiting presence. Cross-references against known routes to determine which routes are covered by middleware protection and which are not. Returns raw coverage facts only — the agent cross-references this output with getRouteMapTool results to determine true protection status. A route not covered by middleware may still be protected at handler level. The agent decides which uncovered routes are genuine security gaps based on project context, route sensitivity, and handler-level auth status.",
    schema: z.object({
      repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
      accessToken: z.string().describe("GitHub access token for fetching files via the API"),
      knownRoutes: z.array(z.string()).describe("Route paths the agent knows about from getRouteMapTool output (e.g. ['/api/products', '/api/checkout/create-order', '/api/admin']). Used to determine middleware coverage for each route."),
    }),
  }
);
