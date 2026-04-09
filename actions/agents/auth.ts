// agents/auth/index.ts

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import { HumanMessage } from "@langchain/core/messages";
import * as fs from "fs";
import * as path from "path";

import { getRepoTreeTool, searchCodeTool } from "../analysis/tools/agent-tools";
import { getDependenciesTool } from "../analysis/tools/getDependenciesTool";
import { getRouteMapTool } from "../analysis/tools/getRouteMapTool";
import { getMiddlewareChainTool } from "../analysis/tools/getMiddlewareChainTool";
import { getSchemaDefinitionsTool } from "../analysis/tools/getSchemaDefinitionsTool";

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

You have access to these tools:
- getDependencies: detect auth provider from package.json
- getRepoTree: fetch full file tree
- getRouteMap: extract auth status per route (YOU pass route files)
- getMiddlewareChain: extract middleware coverage (tool discovers files internally)
- getSchemaDefinitions: check indexes on auth-related columns (YOU pass schema files)
- searchCode: find specific code patterns
- finalReport: submit your completed report (call ONCE at the end)

════════════════════════════════════════
INVESTIGATION PHASES
════════════════════════════════════════

PHASE 1 — Detect Auth Stack (getDependencies)
  → Identify auth provider: clerk | nextauth | auth0 | supabase | jwt | session | custom | none
  → Determine mode:
    third-party: clerk, nextauth, auth0, supabase
    self-managed: jwt, bcrypt, sessions, passport
  → Record completed phase: [1]

PHASE 2 — Get File Tree (getRepoTree)
  → Identify all route files:
    App Router: app/**/route.ts, app/**/page.tsx (server components with DB calls)
    Pages Router: pages/api/**/*.ts
  → Identify schema files: prisma/schema.prisma or similar
  → Identify middleware files (for context — getMiddlewareChainTool discovers them internally)
  → Record completed phase: [1,2]

PHASE 3 — Route Map (getRouteMapTool)
  → Pass ALL route files found in Phase 2
  → For detectedAuthProvider, pass what you found in Phase 1
  → Note which routes are unprotected, especially sensitive ones (/api/admin, /api/user, /api/payment, /api/order, /api/account, /api/settings, /api/profile)
  → Record completed phase: [1,2,3]

PHASE 4 — Middleware Chain (getMiddlewareChainTool)
  → Pass knownRoutes: array of route paths from Phase 3
  → Tool discovers middleware files internally
  → Cross-reference: which routes have NO middleware coverage AND are unprotected per Phase 3?
  → These are confirmed unprotected sensitive routes — HIGH/CRITICAL finding
  → Record completed phase: [1,2,3,4]

PHASE 5 — Schema Index Check (getSchemaDefinitionsTool)
  → Pass schema files from Phase 2
  → Look specifically for:
    Third-party mode: clerkId, auth0Id, supabaseId, providerId, externalId columns — are they indexed?
    Self-managed mode: sessionId, userId in sessions table — are they indexed?
  → Missing index on provider user ID column = CRITICAL finding (full table scan on every auth'd request)
  → Record completed phase: [1,2,3,4,5]

PHASE 6 — Pattern Search (searchCode)
  Third-party mode searches:
    1. Search: "findUnique clerkId" OR "findFirst clerkId" — DB lookup after every auth check
    2. Search: "webhook" — find webhook handlers, check for idempotency + signature verification
  Self-managed mode searches:
    1. Search: "session" in DB models — session stored in DB (not Redis)?
    2. Search: "bcrypt.compare" OR "compareSync" — is it async or sync?
    3. Search: "jwt.verify" — synchronous JWT verification blocking event loop?
    4. Search: "rate" OR "rateLimit" in login route files — missing rate limiting on login?
  → Record completed phase: [1,2,3,4,5,6]

PHASE 7 — Submit Report (finalReport)
  → Call finalReport immediately after Phase 6
  → ALWAYS call finalReport — a partial report beats a timeout
  → Set timedOut: true if submitting early

════════════════════════════════════════
SEVERITY GUIDELINES
════════════════════════════════════════

CRITICAL:
  - Missing index on provider user ID (clerkId, auth0Id) → full table scan per request → breaks at ~10k users
  - Session stored in DB without cache → DB hit on every request → breaks at ~500 req/s
  - Unprotected sensitive routes confirmed by BOTH route map AND middleware gap

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

════════════════════════════════════════
RULES
════════════════════════════════════════
1. Complete phases in order. Do not skip Phase 1 — mode detection determines everything.
2. Always cross-reference Phase 3 (route map) + Phase 4 (middleware) before flagging unprotected routes. Both must agree.
3. Never flag a route as unprotected based on Phase 3 alone — middleware may protect it globally.
4. Call finalReport ONCE and ONLY ONCE — immediately after Phase 6.
5. Partial report beats timeout. If approaching recursion limit, call finalReport now.
6. Do not invent findings. Only report what tools confirmed.
`;

// ─── Agent Runner ─────────────────────────────────────────────────────────────

export async function runAuthAgent(
  repositoryId: string,
  accessToken: string
): Promise<AuthAgentReport> {
  // Load repo metadata
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { repositoryId },
    select: { fullName: true, defaultBranch: true },
  });

  const [owner, repoName] = repo.fullName.split("/");

  // Build agent
  const agent = createReactAgent({
    llm: gpt4oMini,
    tools: [
      getDependenciesTool,
      getRepoTreeTool,
      getRouteMapTool,
      getMiddlewareChainTool,
      getSchemaDefinitionsTool,
      searchCodeTool,
      finalReportTool,
    ],
    messageModifier: SYSTEM_PROMPT,
  });

  const userMessage = `
Analyze the authentication implementation of this repository for scale bottlenecks.

Repository ID: ${repositoryId}
Owner: ${owner}
Repo: ${repoName}
Branch: ${repo.defaultBranch}
Access Token: ${accessToken}

Follow all 7 investigation phases in order. Call finalReport after Phase 6.
`.trim();

  let rawMessages: unknown[] = [];

  try {
    const result = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: 100 }
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
      name?: string;
      content?: unknown;
    };
    if (m._getType?.() === "tool" && m.name === "finalReport") {
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