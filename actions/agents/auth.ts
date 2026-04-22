// agents/auth/index.ts

import { tool } from "langchain";
import { createAgent } from "langchain";
import { z } from "zod";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import * as fs from "fs";
import * as path from "path";

import {
  getRepoTreeTool,
  getFileContentTool,
  searchCodeTool,
  getCodeBlockTool,
  githubContextSchema,
} from "../analysis/tools/agent-tools";

// ─── Output Types ────────────────────────────────────────────────────────────

export type AuthMode = "third-party" | "self-managed" | "unknown";

export type AuthProvider =
  | "clerk"
  | "nextauth"
  | "auth0"
  | "supabase"
  | "jwt"
  | "session"
  | "custom"
  | "none";

export interface AuthFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  category:
    | "missing-index"
    | "db-lookup-on-every-request"
    | "missing-route-protection"
    | "no-rate-limit"
    | "session-in-db"
    | "sync-jwt-verify"
    | "webhook-no-idempotency"
    | "webhook-no-signature"
    | "session-not-invalidated"
    | "other";
  title: string;
  description: string;
  affectedFiles: string[];
  scaleBreakpoint?: string; // e.g. "~10k users", "~500 req/s"
  recommendation: string;
}

export interface AuthScaleAnalysis {
  overallRisk: "critical" | "high" | "medium" | "low";
  estimatedBreakpoint: string;
  bottlenecks: string[];
}

export interface AuthAgentReport {
  repositoryId: string;
  authMode: AuthMode;
  authProvider: AuthProvider;
  findings: AuthFinding[];
  scaleAnalysis: AuthScaleAnalysis;
  summary: string;
  completedPhases: number[];
  timedOut: boolean;
}

// ─── Final Report Tool ────────────────────────────────────────────────────────

const finalReportTool = tool(
  async (input): Promise<string> => {
    return JSON.stringify({ status: "report_submitted", report: input });
  },
  {
    name: "finalReport",
    description:
      "Submit the completed auth analysis report. Call this exactly once after all investigation phases are complete, or immediately if a timeout is likely. A partial report is always better than no report.",
    schema: z.object({
      authMode: z
        .enum(["third-party", "self-managed", "unknown"])
        .describe("Detected authentication mode"),
      authProvider: z
        .enum([
          "clerk",
          "nextauth",
          "auth0",
          "supabase",
          "jwt",
          "session",
          "custom",
          "none",
        ])
        .describe("Specific auth provider or mechanism detected"),
      findings: z
        .array(
          z.object({
            id: z.string(),
            severity: z.enum(["critical", "high", "medium", "low"]),
            category: z.enum([
              "missing-index",
              "db-lookup-on-every-request",
              "missing-route-protection",
              "no-rate-limit",
              "session-in-db",
              "sync-jwt-verify",
              "webhook-no-idempotency",
              "webhook-no-signature",
              "session-not-invalidated",
              "other",
            ]),
            title: z.string(),
            description: z.string(),
            affectedFiles: z.array(z.string()),
            scaleBreakpoint: z.string().optional(),
            recommendation: z.string(),
          })
        )
        .describe("List of auth scale findings"),
      scaleAnalysis: z.object({
        overallRisk: z.enum(["critical", "high", "medium", "low"]),
        estimatedBreakpoint: z
          .string()
          .describe(
            "Estimated scale at which auth will become the bottleneck, e.g. '~10k users'"
          ),
        bottlenecks: z
          .array(z.string())
          .describe("Ordered list of auth bottlenecks by severity"),
      }),
      summary: z
        .string()
        .describe(
          "2-3 sentence plain-English summary of auth scale risk for this repo"
        ),
      completedPhases: z
        .array(z.number())
        .describe("Which investigation phases were completed, e.g. [1,2,3,4]"),
      timedOut: z
        .boolean()
        .describe(
          "True if agent is submitting a partial report due to time/recursion constraints"
        ),
    }),
  }
);

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an Auth Specialist Agent. Your job is to analyze a GitHub repository's authentication implementation and identify scale bottlenecks — issues that will cause performance degradation or failures under load.

AVAILABLE TOOLS (repo details are injected automatically via context — just pass the relevant parameters):
1. **getRepoTree()** — No input needed. Returns full project file tree.
2. **getFileContent(path)** — Just pass the file path. For reading middleware, route handlers, auth configs, schema files.
3. **searchCode(query)** — Just pass the search query. For locating patterns: clerkId, session, bcrypt, jwt.verify, webhook, rateLimit.
4. **getCodeBlock(filePath, lineStart, lineEnd)** — Read a specific line range from a file. More efficient than getFileContent when you only need a section.
5. **finalReport(...)** — Submit your completed report. Call ONCE at the end.

═══════════════════════════════════════════
INVESTIGATION PHASES
═══════════════════════════════════════════

PHASE 1 — Detect Auth Stack (from package.json + root structure provided in context)
  → Infer auth provider from dependencies: clerk, nextauth, auth0, supabase, passport, jwt, bcrypt, etc.
  → Determine mode:
    third-party: @clerk/nextjs, next-auth, @auth0/nextjs-auth0, @supabase/ssr
    self-managed: jsonwebtoken, bcrypt, express-session, passport
  → Record completed phase: [1]

PHASE 2 — Get File Tree (getRepoTree)
  → Only call if the root structure provided in context is insufficient
  → Identify key files:
    Route files: app/**/route.ts, pages/api/**/*.ts
    Middleware: middleware.ts or src/middleware.ts
    Schema: prisma/schema.prisma or equivalent
    Auth config: auth.ts, [...nextauth], clerk middleware wrapper
  → Record completed phase: [1,2]

PHASE 3 — Middleware & Route Protection Analysis (getFileContent + searchCode)
  → Read the middleware file (middleware.ts) with getFileContent to understand:
    - Which routes are protected by the middleware matcher
    - Which auth provider is used in middleware (clerk, nextauth, etc.)
    - Whether there are public route exclusions
  → Use searchCode to find route handlers that do their own auth checks:
    - searchCode("auth()") or searchCode("currentUser") for clerk
    - searchCode("getServerSession") for nextauth
    - searchCode("getSession") for supabase
  → Cross-reference: routes NOT covered by middleware AND NOT doing their own auth checks = unprotected
  → Only flag as unprotected if BOTH checks confirm it — middleware may protect globally
  → Record completed phase: [1,2,3]

PHASE 4 — Schema & Index Check (getFileContent on schema file)
  → Read the schema file (e.g. prisma/schema.prisma) with getFileContent
  → Look specifically for:
    Third-party mode: clerkId, auth0Id, supabaseId, providerId, externalId columns — are they indexed?
    Self-managed mode: sessionId, userId in sessions table — are they indexed?
  → Missing index on provider user ID column = CRITICAL finding (full table scan on every auth'd request)
  → Record completed phase: [1,2,3,4]

PHASE 5 — Deep Pattern Analysis (searchCode + getFileContent)
  Third-party mode searches:
    1. searchCode("findUnique") or searchCode("findFirst") near auth lookups — DB lookup after every auth check
    2. searchCode("webhook") — find webhook handlers, then read them with getFileContent to check for:
       - Signature verification (svix, crypto.createHmac, stripe.webhooks.constructEvent)
       - Idempotency checks (checking if event already processed)
  Self-managed mode searches:
    1. searchCode("session") in DB models — session stored in DB (not Redis)?
    2. searchCode("bcrypt.compare") or searchCode("compareSync") — is it async or sync?
    3. searchCode("jwt.verify") — synchronous JWT verification blocking event loop?
    4. searchCode("rateLimit") or searchCode("rate-limit") — missing rate limiting on login?
  → Record completed phase: [1,2,3,4,5]

PHASE 6 — Submit Report (finalReport)
  → Call finalReport immediately after Phase 5
  → ALWAYS call finalReport — a partial report beats a timeout
  → Set timedOut: true if submitting early

═══════════════════════════════════════════
SEVERITY GUIDELINES
═══════════════════════════════════════════

CRITICAL:
  - Missing index on provider user ID (clerkId, auth0Id) → full table scan per request → breaks at ~10k users
  - Session stored in DB without cache → DB hit on every request → breaks at ~500 req/s
  - Unprotected sensitive routes confirmed by BOTH middleware analysis AND route-level check

HIGH:
  - DB lookup after every auth check (user sync pattern with no caching)
  - Webhook handler missing signature verification → security + reliability risk at scale
  - No rate limiting on login/auth endpoints → brute force = DB overload

MEDIUM:
  - Synchronous bcrypt.compare or jwt.verify → event loop blocking under load
  - Webhook handler missing idempotency → duplicate processing under retry load
  - Session not invalidated on logout → stale sessions accumulate in DB

LOW:
  - Unprotected non-sensitive routes
  - Missing indexes on rarely-queried auth columns

═══════════════════════════════════════════
RULES
═══════════════════════════════════════════
1. Complete phases in order. Do not skip Phase 1 — mode detection determines everything.
2. Always cross-reference middleware + route-level checks before flagging unprotected routes.
3. Never flag a route as unprotected based on a single check — middleware may protect it globally.
4. Call finalReport ONCE and ONLY ONCE — immediately after Phase 5.
5. Partial report beats timeout. If approaching recursion limit, call finalReport now.
6. Do not invent findings. Only report what you confirmed by reading actual code.
7. Tools already know the repo — just pass file paths or search queries, not owner/repo/branch/token.
`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const authAgentTools = [
  getRepoTreeTool,
  getFileContentTool,
  searchCodeTool,
  getCodeBlockTool,
  finalReportTool,
];

// ─── Agent Runner ─────────────────────────────────────────────────────────────

export async function runAuthAgent(
  repositoryId: string,
  accessToken: string
): Promise<AuthAgentReport> {
  // Load repo metadata
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { repositoryId },
    select: {
      fullName: true,
      defaultBranch: true,
      packageJson: true,
      repoContent: true,
      framework: true,
    },
  });

  const [owner, repoName] = repo.fullName.split("/");
  const branch = repo.defaultBranch ?? "main";
  const framework = repo.framework ?? "unknown";
  const packageJsonStr = repo.packageJson
    ? JSON.stringify(repo.packageJson).slice(0, 3000)
    : "Not available";
  const repoContentStr = repo.repoContent
    ? JSON.stringify(repo.repoContent)
    : "Not available";

  console.log(`[AuthAgent] Repo: ${repo.fullName} (${branch})`);

  // Build agent with context schema
  const agent = createAgent({
    model: gpt5Mini,
    tools: authAgentTools,
    systemPrompt: SYSTEM_PROMPT,
    contextSchema: githubContextSchema,
  });

  const userMessage = `Analyze the authentication implementation of ${repo.fullName} for scale bottlenecks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Root directory structure: ${repoContentStr}

Start with Phase 1: infer the auth provider from the package.json above (no tool call needed).
Then proceed through the remaining phases using tools.
Call finalReport after Phase 5.`;

  let rawMessages: unknown[] = [];

  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: userMessage }] },
      {
        context: { owner, repo: repoName, branch, accessToken },
        recursionLimit: 100,
      }
    );
    rawMessages = result.messages ?? [];
  } catch (err) {
    console.error("[AuthAgent] Agent invocation error:", err);
  }

  // ─── Extract finalReport from tool messages ──────────────────────────────
  let report: AuthAgentReport | null = null;

  for (const msg of rawMessages) {
    const m = msg as {
      _getType?: () => string;
      role?: string;
      name?: string;
      content?: unknown;
      tool_calls?: Array<{ name: string; args: unknown }>;
    };

    // Check tool response messages
    if (
      (m._getType?.() === "tool" || m.role === "tool") &&
      m.name === "finalReport"
    ) {
      try {
        const parsed =
          typeof m.content === "string" ? JSON.parse(m.content) : m.content;
        const inner = parsed?.report ?? parsed;
        report = {
          repositoryId,
          authMode: inner.authMode ?? "unknown",
          authProvider: inner.authProvider ?? "none",
          findings: inner.findings ?? [],
          scaleAnalysis: inner.scaleAnalysis ?? {
            overallRisk: "low",
            estimatedBreakpoint: "unknown",
            bottlenecks: [],
          },
          summary: inner.summary ?? "",
          completedPhases: inner.completedPhases ?? [],
          timedOut: inner.timedOut ?? false,
        };
      } catch {
        console.error("[AuthAgent] Failed to parse finalReport content");
      }
    }

    // Fallback: check tool_calls on assistant messages
    if (!report && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.name === "finalReport" && tc.args) {
          try {
            const inner =
              typeof tc.args === "string" ? JSON.parse(tc.args) : tc.args;
            report = {
              repositoryId,
              authMode: (inner as any).authMode ?? "unknown",
              authProvider: (inner as any).authProvider ?? "none",
              findings: (inner as any).findings ?? [],
              scaleAnalysis: (inner as any).scaleAnalysis ?? {
                overallRisk: "low",
                estimatedBreakpoint: "unknown",
                bottlenecks: [],
              },
              summary: (inner as any).summary ?? "",
              completedPhases: (inner as any).completedPhases ?? [],
              timedOut: (inner as any).timedOut ?? false,
            };
          } catch {
            // continue
          }
        }
      }
    }
  }

  // ─── Fallback if agent never called finalReport ──────────────────────────
  if (!report) {
    console.warn("[AuthAgent] finalReport never called — returning empty report");
    report = {
      repositoryId,
      authMode: "unknown",
      authProvider: "none",
      findings: [],
      scaleAnalysis: {
        overallRisk: "low",
        estimatedBreakpoint: "unknown",
        bottlenecks: [],
      },
      summary: "Agent did not complete analysis.",
      completedPhases: [],
      timedOut: true,
    };
  }

  // ─── Write log file ──────────────────────────────────────────────────────
  try {
    const logDir = path.join(process.cwd(), "agent-logs");
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(logDir, `auth-${repositoryId}-${timestamp}.json`);
    fs.writeFileSync(
      logPath,
      JSON.stringify({ report, messages: rawMessages }, null, 2)
    );
    console.log(`[AuthAgent] Log written to ${logPath}`);
  } catch (err) {
    console.error("[AuthAgent] Failed to write log file:", err);
  }

  return report;
}