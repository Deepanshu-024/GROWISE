// agents/auth/index.ts

import { createAgent } from "langchain";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import * as fs from "fs";
import * as path from "path";

import {
  getRepoTreeTool,
  getFileContentTool,
  searchCodeTool,
  githubContextSchema,
} from "../analysis/tools/agent-tools";

// --- Output Types -------------------------------------------------------------

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
  scaleBreakpoint?: string;
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

export interface AuthAgentOutput {
  rawFindings: string | null;
  intermediateSteps: unknown[];
  totalToolCalls: number;
  executionTimeMs: number;
  error?: string;
}

interface AgentMessageLike {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  _getType?: () => string;
}

// --- System Prompt ------------------------------------------------------------

const SYSTEM_PROMPT = `You are an elite authentication scalability analyst specializing in React/Next.js applications. Your mission is to analyze GitHub repositories and surface auth-layer issues that will cause real failures as the business scales - not theoretical edge cases, but the patterns that break under traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify targets before making any tool calls
- Make educated assumptions based on React/Next.js auth patterns
- Tool calls should be surgical, not exhaustive
- Maximum 15 tool calls total across all phases - spend them wisely

AVAILABLE TOOLS (Use Sparingly - repo details are injected automatically via context):
1. **getRepoTree()** - No input needed. Returns full project file tree (only if the tree in context is incomplete or truncated)
2. **getFileContent(path)** - Just pass the file path. For reading middleware, route handlers, auth configs, schema files, and webhook handlers
3. **searchCode(query)** - Just pass the search query. For locating patterns: auth(), currentUser, getServerSession, clerkId, session, bcrypt, jwt.verify, webhook, rateLimit

---

## ANALYSIS FRAMEWORK - AUTH SCALE SPECIALIST

---

### PHASE 1 - Auth Stack & Project Understanding (No Tools)

Infer from package.json and file tree:
- authProvider: clerk | nextauth | auth0 | supabase | jwt | session | custom | none
- authMode: third-party | self-managed | unknown
- framework: Next.js App Router | Pages Router | mixed
- isServerless: true if Next.js/Vercel-style deployment is likely
- sessionStorage: jwt | database | redis | provider-managed | unknown
- cacheLayer: redis | memcached | NONE
- projectType: e-commerce | SaaS | social | API service | unknown

These shape severity:
-> DB-backed sessions without cache hit the database on every request
-> Missing indexes on provider IDs turn every auth lookup into table scans
-> Login, webhook, and protected dashboard routes become auth hotspots
-> Self-managed password/JWT flows need rate limits and non-blocking verification

### PHASE 2 - Identify Investigation Targets (Minimal Tools)

Infer architecture from the provided tree first:
- Middleware: middleware.ts or src/middleware.ts
- Auth config: auth.ts, auth.config.ts, [...nextauth], clerk middleware wrapper, supabase server client
- Sensitive routes: dashboard, account, profile, user, admin, billing, checkout, order, payment, settings, api
- Auth endpoints: login, signup, callback, session, logout, webhook, clerk, stripe, auth
- Schema files: prisma/schema.prisma, db/schema.ts, src/db/schema.ts, models

Only call **getRepoTree** if the tree in context is incomplete or ambiguous. Do not retry if it fails.
Build an investigation list of middleware/auth config, schema, webhook/auth endpoints, and top 3-4 sensitive routes. Maximum 8 items total.

### PHASE 3 - Middleware & Route Protection Analysis

Use **getFileContent** for middleware and selected route/action files.
Use **searchCode** only to validate provider-specific route checks:
- Clerk: auth(), currentUser, clerkMiddleware, auth.protect
- NextAuth: getServerSession, auth(), getToken
- Supabase: getSession, getUser, createServerClient
- Custom: verify, jwt.verify, session lookup, cookies()

Flag missing route protection only when both are true:
-> Middleware does not protect the sensitive route
-> The route/action does not perform its own auth check

Never flag a route as unprotected from file path alone; middleware may protect it globally.

### PHASE 4 - Schema & Auth Lookup Analysis

Always run this phase when a schema file is visible.
Use **getFileContent** to read the schema once.

Check:
- Third-party IDs: clerkId, auth0Id, supabaseId, providerId, externalId are unique or indexed
- Session tables: sessionToken, sessionId, userId, expires are indexed for lookup/cleanup patterns
- Account tables: provider + providerAccountId have a compound unique/index
- User lookup columns used in auth paths match schema indexes

Missing index on a provider/session lookup used during auth is CRITICAL or WARNING depending on traffic path.

### PHASE 5 - Deep Auth Pattern Analysis

Third-party auth checks:
-> DB lookup immediately after currentUser/auth() on every request with no cache
-> User sync or upsert in hot paths instead of webhook/background sync
-> Webhook handlers without signature verification or idempotency

Self-managed auth checks:
-> Database-backed sessions with no Redis/cache layer
-> bcrypt.compareSync or synchronous jwt.verify in request paths
-> Login/signup endpoints with no rate limiting
-> Logout that does not invalidate server-side session state

Severity assignment:
- CRITICAL: proven auth outage, full table scan per authenticated request, sensitive route exposed, webhook signature missing on a trust boundary, or DB-backed sessions guaranteed to overload a core path.
- WARNING: proven auth scaling limit that becomes painful with traffic/table growth, including uncached per-request user lookups, missing idempotency, missing login rate limits, or sync verification in hot paths.
- INFO: useful context, healthy observations, or lower-confidence findings only.

After finding 3 CRITICAL issues, stop expanding the investigation to new non-required files. Still complete required schema and auth infrastructure checks, and report every finding already discovered. Never omit a discovered finding just to hit a preferred finding count; compress wording instead.

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, route priority list, code snippets, or "if you want" follow-ups.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[AUTH-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact code pattern and why it fails.
Impact: max 1 sentence. Include scale trigger if known.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[AUTH-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[AUTH-3] Short title, max 10 words
File: path/to/file.ts or package/schema context
Evidence: max 1 sentence.
Use INFO only for useful context, healthy observations, or lower-confidence findings.

Severity definitions:
- CRITICAL: proven auth outage, sensitive data exposure, trust-boundary failure, session exhaustion, or severe auth DB overload on a core user path.
- WARNING: proven performance degradation or scaling limit that becomes painful with table/traffic growth but is not an immediate outage.
- INFO: context the orchestrator may optionally use; never include generic advice here.

Compression rules:
- Report every distinct finding you discovered. Do not drop, hide, or silently discard a discovered finding because of the output budget or preferred count.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause; do not merge unrelated findings.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then user impact.
- Each finding must preserve: file, pattern/evidence, scale impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding; if there are many findings, shorten each field rather than omitting findings.
- Prefer one consolidated missing-index finding over separate index bullets.
- Prefer one consolidated route-protection finding unless routes expose different sensitive surfaces.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// --- Tools --------------------------------------------------------------------

const authAgentTools = [
  getRepoTreeTool,
  getFileContentTool,
  searchCodeTool,
];

// --- Agent Runner -------------------------------------------------------------

export async function runAuthAgent(
  repositoryId: string,
  accessToken: string
): Promise<AuthAgentOutput> {
  const startTime = Date.now();

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

  const agent = createAgent({
    model: gpt5Mini,
    tools: authAgentTools,
    systemPrompt: SYSTEM_PROMPT,
    contextSchema: githubContextSchema,
  });

  const userMessage = `Analyze the repository ${repo.fullName} for authentication scalability risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **Auth Stack Detection** - Identify provider, mode, session strategy, and auth hotspots
2. **Route Protection** - Confirm sensitive routes are protected by middleware or route-level checks
3. **Auth Lookup Scaling** - Find per-request DB auth lookups, missing provider/session indexes, and uncached user sync patterns
4. **Webhook Safety** - Check auth/provider webhooks for signature verification and idempotency
5. **Self-Managed Auth Risk** - Check rate limiting, synchronous verification, and server-side session invalidation where applicable

**Analysis Approach:**
- Start with the package.json and file tree provided above - identify middleware, auth config, schema files, and sensitive routes immediately (Phase 1, no tools needed)
- Classify auth files and sensitive routes by traffic priority before reading any files
- Use getFileContent(path) strategically on high-priority targets only
- Use searchCode(query) to validate patterns (auth checks, provider IDs, webhook handlers, session lookups, rate limits)
- Read schema file once to cross-reference all auth lookup findings at once
- Tools already know the repo details - just pass the file path or search query

**Constraint:** Minimize tool usage - leverage the file tree and package.json above first, then make targeted tool calls only for confirmed high-traffic auth files.
**Reporting constraint:** If you discover a distinct finding, you must report it. Do not drop findings to satisfy a preferred count or budget; keep within budget by compressing wording and merging only genuinely overlapping duplicates.

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers.`;

  let rawMessages: unknown[] = [];

  try {
    const result = await agent.invoke(
      { messages: [{ role: "user", content: userMessage }] },
      {
        context: { owner, repo: repoName, branch, accessToken },
        recursionLimit: 40,
      }
    );
    rawMessages = result.messages ?? [];
  } catch (err) {
    const executionTimeMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : "Unknown error occurred";
    console.error("[AuthAgent] Agent invocation error:", err);

    return {
      rawFindings: null,
      intermediateSteps: rawMessages,
      totalToolCalls: 0,
      executionTimeMs,
      error: message,
    };
  }

  const toolMessages = rawMessages.filter((msg) => {
    const message = msg as AgentMessageLike;
    return message.role === "tool" || (message.tool_calls?.length ?? 0) > 0;
  });
  const totalToolCalls = toolMessages.length;

  const lastAiMessage = [...rawMessages]
    .reverse()
    .find((msg) => {
      const message = msg as AgentMessageLike;
      return message._getType?.() === "ai" || message.role === "assistant";
    }) as AgentMessageLike | undefined;

  const rawFindings =
    typeof lastAiMessage?.content === "string"
      ? lastAiMessage.content
      : JSON.stringify(lastAiMessage?.content ?? "");

  const executionTimeMs = Date.now() - startTime;

  try {
    const logDir = path.join(process.cwd(), "agent-logs");
    fs.mkdirSync(logDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(logDir, `auth-${repositoryId}-${timestamp}.json`);
    fs.writeFileSync(
      logPath,
      JSON.stringify({ rawFindings, messages: rawMessages }, null, 2)
    );
    console.log(`[AuthAgent] Log written to ${logPath}`);
  } catch (err) {
    console.error("[AuthAgent] Failed to write log file:", err);
  }

  if (!rawFindings || rawFindings.trim().length === 0) {
    return {
      rawFindings: null,
      intermediateSteps: rawMessages,
      totalToolCalls,
      executionTimeMs,
      error: "Agent completed without returning findings.",
    };
  }

  return {
    rawFindings,
    intermediateSteps: rawMessages,
    totalToolCalls,
    executionTimeMs,
  };
}
