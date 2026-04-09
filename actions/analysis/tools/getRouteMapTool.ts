import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_ROUTE_FILES = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteDefinition {
  file: string;
  method: string;
  path: string | null;
  isProtected: boolean;
  authProvider: string | null;
  authMethod: string | null;
  hasRateLimit: boolean;
  dbCallCount: number;
  hasDbCallAfterAuth: boolean;
  userIdColumn: string | null;
  summary: string;
}

interface UnprotectedSensitiveRoute {
  file: string;
  path: string | null;
  method: string;
  reason: string;
}

interface LLMRouteResult {
  routes: Array<{
    method: string;
    path: string | null;
    isProtected: boolean;
    authProvider: string | null;
    authMethod: string | null;
    hasRateLimit: boolean;
    dbCallCount: number;
    hasDbCallAfterAuth: boolean;
    userIdColumn: string | null;
    summary: string;
  }>;
}

interface RouteMapResult {
  repository: string;
  detectedFramework: string;
  detectedRouterType: string;
  detectedAuthProvider: string | null;
  skippedFiles: string[];
  summary: {
    totalRoutesFound: number;
    protectedRoutes: number;
    unprotectedRoutes: number;
    routesWithRateLimit: number;
    routesWithDbCallAfterAuth: number;
    totalFilesAnalyzed: number;
  };
  routes: RouteDefinition[];
  unprotectedSensitiveRoutes: UnprotectedSensitiveRoute[];
}

// ─── In-memory file cache ─────────────────────────────────────────────────────

type FileCache = Map<string, string>;

// ─── GitHub file fetch helper (same pattern as getSchemaDefinitionsTool) ──────

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

// ─── Sensitive path keywords ─────────────────────────────────────────────────

const SENSITIVE_PATH_KEYWORDS = [
  "admin",
  "user",
  "users",
  "order",
  "orders",
  "account",
  "profile",
  "payment",
  "checkout",
  "private",
  "dashboard",
  "settings",
  "billing",
  "invoice",
  "subscription",
  "secret",
  "internal",
  "manage",
  "management",
];

function isSensitivePath(path: string | null): boolean {
  if (!path) return false;
  const segments = path.toLowerCase().split("/").filter(Boolean);
  return SENSITIVE_PATH_KEYWORDS.some((keyword) =>
    segments.some(
      (seg) =>
        seg === keyword ||
        seg.startsWith(keyword + "-") ||
        seg.endsWith("-" + keyword) ||
        seg.startsWith(keyword + "[") ||
        seg === "[" + keyword + "]"
    )
  );
}

function getSensitiveReason(path: string | null): string {
  if (!path) return "Route path could not be determined but may be sensitive";
  const segments = path.toLowerCase().split("/").filter(Boolean);
  const matched = SENSITIVE_PATH_KEYWORDS.filter((keyword) =>
    segments.some(
      (seg) =>
        seg === keyword ||
        seg.startsWith(keyword + "-") ||
        seg.endsWith("-" + keyword)
    )
  );
  return `Route contains sensitive path segment(s): ${matched.join(", ")} — no auth check detected`;
}

// ─── Router type detection ───────────────────────────────────────────────────

function detectRouterType(
  routeFiles: string[],
  framework: string | null
): "nextjs-app-router" | "nextjs-pages-router" | "react-custom" | "mixed" {
  if (!framework || framework === "react") return "react-custom";

  const hasAppRouter = routeFiles.some(
    (f) => f.includes("/app/api/") || f.startsWith("app/api/")
  );
  const hasPagesRouter = routeFiles.some(
    (f) => f.includes("/pages/api/") || f.startsWith("pages/api/")
  );

  if (hasAppRouter && hasPagesRouter) return "mixed";
  if (hasAppRouter) return "nextjs-app-router";
  if (hasPagesRouter) return "nextjs-pages-router";
  return "nextjs-app-router"; // default for Next.js
}

// ─── Path derivation from file path ──────────────────────────────────────────

function derivePathFromFilePath(filePath: string): string | null {
  // Next.js App Router: src/app/api/products/route.ts → /api/products
  const appMatch = filePath.match(
    /(?:src\/)?app(\/api\/.+?)\/route\.[tj]sx?$/
  );
  if (appMatch) return appMatch[1];

  // Next.js Pages Router: src/pages/api/users.ts → /api/users
  const pagesMatch = filePath.match(
    /(?:src\/)?pages(\/api\/.+?)\.[tj]sx?$/
  );
  if (pagesMatch) {
    // Remove file extension from last segment
    return pagesMatch[1].replace(/\.[tj]sx?$/, "");
  }

  return null;
}

// ─── Framework-specific extraction hints ─────────────────────────────────────

const FRAMEWORK_HINTS: Record<string, string> = {
  "nextjs-app-router": `This is a Next.js App Router route file. Each file exports named async functions for HTTP methods: GET, POST, PUT, DELETE, PATCH. Auth checks typically appear at the top of each exported function. Common auth patterns: auth() from @clerk/nextjs/server, getServerSession() from next-auth, createRouteHandlerClient() from @supabase/auth-helpers-nextjs, currentUser() from @clerk/nextjs/server. Route path is derived from the file path (e.g. src/app/api/products/route.ts → /api/products).`,
  "nextjs-pages-router": `This is a Next.js Pages Router API route file. Each file exports a default handler function that receives (req, res). Auth checks typically appear at the top of the handler or via wrapper functions. Common auth patterns: getSession()/getServerSession() from next-auth, withApiAuthRequired() from @auth0/nextjs-auth0, requireAuth() wrappers, session checks via req.session, JWT verification via jsonwebtoken. Route path is derived from the file path (e.g. src/pages/api/users.ts → /api/users).`,
  "react-custom": `This is a custom backend route file (Express/Fastify/Koa style). Routes are defined with app.get(), app.post(), router.get(), etc. Auth is typically applied via middleware functions before the handler. Common auth patterns: authMiddleware, requireAuth, isAuthenticated middleware, jwt.verify() calls, req.user checks, passport.authenticate() calls, custom auth guard decorators.`,
  mixed: `This is a Next.js App Router route file. Each file exports named async functions for HTTP methods: GET, POST, PUT, DELETE, PATCH. Auth checks typically appear at the top of each exported function. Common auth patterns: auth() from @clerk/nextjs/server, getServerSession() from next-auth, createRouteHandlerClient() from @supabase/auth-helpers-nextjs, currentUser() from @clerk/nextjs/server. Route path is derived from the file path (e.g. src/app/api/products/route.ts → /api/products).`,
  unknown: `Analyze this route file and extract any HTTP route handlers you find regardless of the framework. Look for exported functions, handler definitions, or route registrations.`,
};

function getFrameworkHint(detectedFramework: string): string {
  return FRAMEWORK_HINTS[detectedFramework.toLowerCase()] ?? FRAMEWORK_HINTS.unknown;
}

// ─── LLM route extraction chain ──────────────────────────────────────────────

const ROUTE_EXTRACTION_PROMPT = `You are analyzing a route file from a {detectedFramework} application.
The auth provider in use is: {detectedAuthProvider}.

Framework-specific guidance:
{frameworkHint}

Extract every HTTP route handler defined in this file.
For each route determine:
- The HTTP method
- Whether auth is checked before the main handler logic
- Which auth provider and method is used
- Whether rate limiting is present
- How many DB calls are made
- Whether there is a DB call to fetch the current user after auth
  (this is the pattern that causes a DB query on every request)

Return ONLY raw facts — no recommendations, no severity judgments.
If you cannot determine a value with confidence: use null or false.
Never guess.

For each route/handler found, extract:

  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ALL" | "unknown"

  path: The route path if determinable from the file path or code.
    For App Router: derive from file path
      src/app/api/products/route.ts → "/api/products"
      src/app/api/checkout/create-order/route.ts → "/api/checkout/create-order"
    For Pages Router: derive from file path
      src/pages/api/users.ts → "/api/users"
    For custom backends: extract from route registration code
    null if cannot be determined

    IMPORTANT: For dynamic route segments always use Next.js bracket notation.
    Use [param] not :param.
    Examples:
      /api/products/[slug]    ✅ correct
      /api/products/:slug     ❌ wrong
      /api/users/[id]         ✅ correct
      /api/users/:id          ❌ wrong
    The pre-derived path already uses bracket notation — prefer it.

    Pre-derived path from file path: {derivedPath}
    Use this as the path value. If the file content clearly shows
    a different path, correct it. Otherwise use the pre-derived value.

  isProtected: true if ANY auth check is present before the main logic:
    - auth(), auth().protect(), auth().userId from Clerk
    - getServerSession(), getSession() from NextAuth
    - currentUser() from Clerk
    - withApiAuthRequired() from Auth0
    - createRouteHandlerClient() from Supabase
    - jwt.verify() anywhere in handler
    - req.session, req.user checks
    - Custom auth middleware wrappers
    - requireAuth, isAuthenticated, authGuard patterns
    false if none of the above are found

  authProvider: "clerk" | "nextauth" | "auth0" | "supabase" | "jwt" | "session" | "custom" | null
    null if isProtected is false

  authMethod: The specific auth check used (e.g. "auth().protect()", "getServerSession()", "jwt.verify()")
    null if isProtected is false

  hasRateLimit: true if any rate limiting is present:
    - rateLimit(), rateLimiter() calls
    - upstash/ratelimit usage
    - custom rate limit middleware
    - redis-based rate limiting
    false if none detected

  dbCallCount: Approximate number of distinct DB calls in this handler.
    Count prisma.*, mongoose.*, db.* calls. 0 if no DB calls found.

  hasDbCallAfterAuth: true if there is a DB call that fetches the current user
    AFTER the auth check (e.g. prisma.user.findUnique({{ where: {{ clerkId: userId }} }}))
    This pattern causes a DB call on every authenticated request.
    false if no such pattern found.

  userIdColumn: If hasDbCallAfterAuth is true, the column name used to look up the user
    (e.g. "clerkId", "auth0Id", "userId", "externalId"). null if not applicable.

  summary: One sentence describing what this route does. Keep it factual and brief.

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "routes": [
    {{
      "method": "string",
      "path": "string or null",
      "isProtected": boolean,
      "authProvider": "string or null",
      "authMethod": "string or null",
      "hasRateLimit": boolean,
      "dbCallCount": number,
      "hasDbCallAfterAuth": boolean,
      "userIdColumn": "string or null",
      "summary": "string"
    }}
  ]
}}

If no routes found in this file, return {{ "routes": [] }}.

File path: {filePath}

Route file content:
{fileContent}`;

const routeExtractionChain = PromptTemplate.fromTemplate(ROUTE_EXTRACTION_PROMPT)
  .pipe(gpt4oMini)
  .pipe(new JsonOutputParser<LLMRouteResult>());

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // OpenAI / LangChain surface rate limits as status 429 or in the message
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

async function extractRoutesFromFile(
  filePath: string,
  fileContent: string,
  detectedFramework: string,
  detectedAuthProvider: string | null,
  derivedPath: string | null
): Promise<LLMRouteResult | null> {
  const vars = {
    filePath,
    fileContent,
    detectedFramework,
    detectedAuthProvider: detectedAuthProvider ?? "unknown",
    frameworkHint: getFrameworkHint(detectedFramework),
    derivedPath: derivedPath ?? "could not be derived from file path",
  };

  try {
    return await routeExtractionChain.invoke(vars);
  } catch (err) {
    if (!isRateLimitError(err)) {
      console.warn(`[getRouteMap] Non-retryable error for "${filePath}":`, err);
      return null;
    }

    // Rate limit — wait 5 s then retry once
    console.warn(`[getRouteMap] Rate limit hit for "${filePath}", retrying in 5 s…`);
    await new Promise((res) => setTimeout(res, 5_000));

    try {
      return await routeExtractionChain.invoke(vars);
    } catch (retryErr) {
      console.warn(`[getRouteMap] Retry also failed for "${filePath}":`, retryErr);
      return null;
    }
  }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Get Route Map
 * Receives route file paths from the agent, fetches them from GitHub,
 * and uses an LLM to extract a complete route map with auth status,
 * rate limiting, and DB call patterns.
 * Returns pure facts — no severity, no warnings, no scale analysis.
 * The agent handles file discovery and cross-references this output
 * with other tool outputs to draw its own conclusions.
 */
export const getRouteMapTool = tool(
  async (input): Promise<string> => {
    const { repositoryId, accessToken, routeFiles, detectedAuthProvider } = input as {
      repositoryId: string;
      accessToken: string;
      routeFiles: string[];
      detectedAuthProvider: string | null;
    };

    if (!routeFiles || routeFiles.length === 0) {
      return `Error: No route files provided. Agent must identify route files from the repo tree before calling this tool.`;
    }

    try {
      // 1. Read repository metadata from DB
      const repository = await prisma.repository.findUnique({
        where: { repositoryId },
        select: { fullName: true, defaultBranch: true, framework: true },
      });

      if (!repository) {
        return `Error: Repository with ID "${repositoryId}" not found in database. ` +
          `Ensure framework analysis has been run before calling this tool.`;
      }

      const [owner, repo] = repository.fullName.split("/");
      const branch = repository.defaultBranch ?? "main";
      const framework = repository.framework ?? "next";
      const routerType = detectRouterType(routeFiles, framework);
      const cache: FileCache = new Map();
      const skippedFiles: string[] = [];
      const allRoutes: RouteDefinition[] = [];

      // Cap at 30 files
      const filesToProcess = routeFiles.slice(0, MAX_ROUTE_FILES);

      console.log(`[getRouteMap] Analyzing ${filesToProcess.length} route files`);
      console.log(
        `[getRouteMap] Framework: ${framework}, ` +
        `Router type: ${routerType}, ` +
        `Auth provider: ${detectedAuthProvider ?? "unknown"}`
      );

      // 2. Fetch + LLM extraction per file
      for (const filePath of filesToProcess) {
        console.log(`[getRouteMap] Extracting routes from: ${filePath}`);

        const fileContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
        if (!fileContent) {
          skippedFiles.push(filePath);
          continue;
        }

        const derivedPath = derivePathFromFilePath(filePath);
        const llmResult = await extractRoutesFromFile(filePath, fileContent, routerType, detectedAuthProvider, derivedPath);
        if (!llmResult) {
          skippedFiles.push(filePath);
          continue;
        }

        // Attach file path to each route and add to collection
        for (const route of llmResult.routes ?? []) {
          allRoutes.push({
            file: filePath,
            method: route.method,
            path: route.path,
            isProtected: route.isProtected,
            authProvider: route.authProvider,
            authMethod: route.authMethod,
            hasRateLimit: route.hasRateLimit,
            dbCallCount: route.dbCallCount,
            hasDbCallAfterAuth: route.hasDbCallAfterAuth,
            userIdColumn: route.userIdColumn,
            summary: route.summary,
          });
        }
      }

      // 3. Detect unprotected sensitive routes (TypeScript logic, not LLM)
      const unprotectedSensitiveRoutes: UnprotectedSensitiveRoute[] = [];

      for (const route of allRoutes) {
        if (!route.isProtected && isSensitivePath(route.path)) {
          unprotectedSensitiveRoutes.push({
            file: route.file,
            path: route.path,
            method: route.method,
            reason: getSensitiveReason(route.path),
          });
        }
      }

      // ── Build summary ─────────────────────────────────────────────────────

      const protectedCount = allRoutes.filter((r) => r.isProtected).length;
      const unprotectedCount = allRoutes.filter((r) => !r.isProtected).length;
      const rateLimitCount = allRoutes.filter((r) => r.hasRateLimit).length;
      const dbAfterAuthCount = allRoutes.filter((r) => r.hasDbCallAfterAuth).length;

      console.log(
        `[getRouteMap] Complete: ${allRoutes.length} routes found, ${unprotectedSensitiveRoutes.length} unprotected sensitive routes flagged`
      );

      const result: RouteMapResult = {
        repository: repository.fullName,
        detectedFramework: framework,
        detectedRouterType: routerType,
        detectedAuthProvider,
        skippedFiles,
        summary: {
          totalRoutesFound: allRoutes.length,
          protectedRoutes: protectedCount,
          unprotectedRoutes: unprotectedCount,
          routesWithRateLimit: rateLimitCount,
          routesWithDbCallAfterAuth: dbAfterAuthCount,
          totalFilesAnalyzed: filesToProcess.length - skippedFiles.length,
        },
        routes: allRoutes,
        unprotectedSensitiveRoutes,
      };

      return JSON.stringify(result, null, 2);

    } catch (error) {
      return `Error extracting route map for repository "${repositoryId}": ${
        error instanceof Error ? error.message : "Unknown error occurred"
      }`;
    }
  },
  {
    name: "getRouteMap",
    description: "Analyze route files identified by the agent to extract a complete route map including HTTP methods, auth protection status, auth provider and method used, rate limiting presence, DB call count, and whether there is a direct DB lookup for the current user after auth. Framework is read automatically from the database — no need to pass it. Router type (App Router vs Pages Router) is detected automatically from the route file paths provided. Automatically flags unprotected routes with sensitive path segments. Returns raw facts only — the agent uses this to find auth gaps, missing rate limits, and per-request DB patterns that break at scale. Note: hasDbCallAfterAuth detects direct DB calls only — indirect patterns via helper functions may not be detected.",
    schema: z.object({
      repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
      accessToken: z.string().describe("GitHub access token for fetching files via the API"),
      routeFiles: z.array(z.string()).describe("File paths the agent has identified as route files (e.g. ['src/app/api/products/route.ts', 'src/pages/api/auth/[...nextauth].ts']). Framework and router type are detected automatically."),
      detectedAuthProvider: z.string().nullable().describe("Auth provider detected from getDependencies output — 'clerk' | 'nextauth' | 'auth0' | 'supabase' | 'jwt' | 'custom' | null"),
    }),
  }
);
