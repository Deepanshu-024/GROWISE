import { createAgent } from "langchain";
import {
    createToolBudgetMiddleware,
    resolveCallbackToolName,
} from "./agent-middleware";
import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";
import {
    searchCodeTool,
    getFileContentTool,
    githubContextSchema,
} from "../analysis/tools/agent-tools";

// --- Types --------------------------------------------------------------------

export interface StreamEvent {
    type: "tool_start" | "tool_end" | "llm_end" | "agent_thought" | "error" | "done" | "agent_start";
    stepNumber: number;
    timestamp: string;
    elapsedMs: number;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: string;
    toolOutputLength?: number;
    reasoning?: string;
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    cumulativeTokens?: { inputTokens: number; outputTokens: number; totalTokens: number };
    rawFindings?: string | null;
    totalToolCalls?: number;
    executionTimeMs?: number;
    error?: string;
}

export interface ContentHeavyAgentInput {
    repositoryId: string;
    installationId: string;
    userId?: string;
    onEvent?: (event: StreamEvent) => void;
}

export interface ContentHeavyAgentOutput {
    rawFindings: string | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}



// --- System Prompt (TODO: fill in next step) ----------------------------------

const SYSTEM_PROMPT = `You are an elite content delivery and asset optimization analyst specializing in React/Next.js applications. Your mission is to analyze GitHub repositories and surface content-delivery risks that will cause bandwidth exhaustion, CDN cache misses, storage read bottlenecks, or slow page loads as concurrent users grow — not theoretical best practices, but the patterns that break under real production traffic.

REPOSITORY CONTEXT:
- Repository: {repoFullName}
- Framework: {framework} (React/Next.js expected)
- Default Branch: {defaultBranch}
- Package.json Dependencies: {packageJson}
- Full Repository File Tree: {repoContent}

STRATEGIC TOOL USAGE PHILOSOPHY:
**Use tools ONLY when critical information cannot be inferred from existing context**
- Start with provided package.json and repository file tree
- The file tree above is the FULL project structure - use it to identify content targets before making tool calls
- Make conservative findings from concrete evidence; if evidence is thin, report INFO instead of exploring endlessly
- Tool calls should be surgical, not exhaustive
- HARD LIMIT: use at most 15 tool calls total
- After using 15 tool calls, stop immediately and return the findings digest from evidence gathered
- Do not call another tool just to improve confidence, find line numbers, or validate a low-impact suspicion

AVAILABLE TOOLS:
1. **getFileContent(path)** - Read config files, image components, middleware, API routes, next.config, CDN config, asset pipeline files
2. **searchCode(query)** - Use only when package.json and file tree are not enough to choose target files. Choose compact repository-specific searches. Use at most 3 searches total. **EARLY EXIT RULE: if 2 consecutive searchCode calls return 0 results, stop all further searchCode usage immediately and fall back to navigating the file tree with getFileContent.**

---

## ANALYSIS FRAMEWORK - CONTENT DELIVERY SCALE SPECIALIST

### NON-NEGOTIABLE SCOPE GATE - CONTENT DELIVERY ONLY

Only investigate and report findings that directly affect static asset serving, image optimization, CDN cache efficiency, cache headers, bundle size, storage read throughput, or bandwidth consumption at scale.

Before reading a file, decide whether it is a content delivery target. Use the injected package.json dependencies and repository file tree to discover which content/asset libraries and patterns the project actually uses. A file is in scope when it configures or implements one of these:
-> Image optimization: next/image, sharp, imagemin, squoosh, cloudinary, imgix, responsive images, WebP/AVIF generation
-> CDN and edge config: CDN provider settings, edge middleware, Vercel/Cloudflare/AWS CloudFront config, asset prefixes, custom domains
-> Cache headers: Cache-Control, s-maxage, stale-while-revalidate, ETag, Last-Modified on static or API routes
-> Bundle optimization: webpack/turbopack/vite config, code splitting, dynamic imports, tree shaking, chunk configuration
-> Static asset pipeline: public/ directory assets, font loading, CSS/JS minification, compression (gzip/brotli)
-> Storage and media: file upload handlers, S3/R2/GCS/Blob storage config, media serving routes, video/audio streaming

Ignore and do not report non-content findings, even if they are real issues:
-> Database query performance unless it directly blocks content serving (e.g., CMS content queries with no cache)
-> Authentication, payment, event-driven, or realtime issues — other agents own these
-> Business logic bugs, generic validation, or API correctness unrelated to content delivery

If a possible issue is adjacent, ask: "Would fixing this reduce bandwidth, improve cache hit ratio, or prevent origin server overload under high concurrent traffic?" If no, discard it silently.

### PHASE 1 - Content Stack Understanding (No Tools)

Infer from package.json and file tree:
- imageOptimization: next/image | sharp | cloudinary | imgix | imagemin | none
- cdnStrategy: Vercel (automatic) | CloudFront | Cloudflare | custom CDN | none visible
- bundler: webpack | turbopack | vite | unknown
- compressionStrategy: gzip | brotli | both | none visible
- staticAssetSignals: public/ directory size/contents, font files, large media files, SVGs
- cachingSignals: middleware with cache headers, next.config headers/rewrites, API route cache control
- storageSignals: S3, R2, GCS, Blob, Supabase storage, Firebase storage, Uploadthing

No content-heavy surface (no images, no public assets, no media, minimal static content) = report INFO AND STOP WITHOUT USING TOOLS.

### PHASE 2 - Identify Investigation Targets

Build a target list from package.json and file tree first.
Prefer files that own asset serving or caching:
- CRITICAL: next.config (image/header/CDN config), middleware (cache headers), image components, asset pipeline config
- HIGH: public/ directory (large files, unoptimized images), API routes serving content, upload/storage handlers
- MEDIUM: layout/page files with heavy static imports, font loading, CSS config
- LOW/SKIP: business logic, auth, payment, event handlers, pure API routes with no content

Use searchCode only if injected context is not enough to choose target files. Pick your own compact query based on repository signals. Do not run one search per keyword.
**searchCode fallback: if your first 2 searchCode calls both return 0 results, abandon searchCode entirely. Switch to reading files directly via getFileContent using paths from the file tree.**
Read highest-impact files first. Stop expanding when the failure mode is clear.

### PHASE 3 - Deep Content Delivery Analysis

For each selected target, inspect:

CDN and Origin Protection:
-> No CDN configuration visible — all assets served directly from origin server
-> Next.js deployed without edge/CDN layer (custom Node server with no reverse proxy)
-> No asset prefix or CDN domain configured for static files
-> API routes serving large responses with no CDN/edge caching
-> Severity: CRITICAL if all static assets hit origin directly at scale; WARNING if partial CDN coverage

Image Optimization:
-> Using raw <img> tags instead of next/image or equivalent optimized component
-> Images in public/ directory served at original resolution with no responsive sizing
-> No WebP/AVIF format conversion configured
-> Missing width/height or layout props causing layout shift and no size optimization
-> Large hero/banner images (>500KB) without lazy loading or priority hints
-> Severity: CRITICAL if multiple large unoptimized images on high-traffic pages; WARNING for minor optimization gaps

Cache Headers:
-> Static assets served with no Cache-Control headers or short TTL
-> API routes returning cacheable content (product lists, CMS pages) with no-store or no cache headers
-> Missing stale-while-revalidate for ISR/SSG pages
-> No ETag or Last-Modified for conditional requests
-> Middleware or custom server overriding framework cache defaults with weaker values
-> Severity: CRITICAL if high-traffic routes have no caching and will hammer origin; WARNING for suboptimal TTL

Bundle Size:
-> No code splitting — entire app in a single bundle
-> Large dependencies imported without tree shaking (e.g., full lodash, moment.js, all of MUI)
-> No dynamic imports for heavy components (charts, editors, maps)
-> Unminified production builds or missing compression
-> Severity: WARNING — impacts load time and bandwidth but rarely causes origin overload

Storage Read Throughput:
-> Media files served through API routes that read from storage on every request (no CDN/cache)
-> File uploads stored locally on the server filesystem instead of object storage
-> No presigned URLs for direct-to-storage uploads — all files proxy through the app server
-> Large file downloads proxied through Node.js without streaming
-> Severity: CRITICAL if media serving will bottleneck the app server; WARNING for inefficient patterns

Scale Basis:
For each core content flow, estimate the failure mode using:
-> concurrent users requesting static assets
-> average page weight (images + JS + CSS + fonts)
-> cache hit ratio (what percentage of requests hit CDN vs origin)
-> origin server bandwidth and connection limits
State what fails first: bandwidth, origin CPU, storage IOPS, memory, or connection limits.

### PHASE 4 - Synthesis

If you have fewer than 3 CRITICAL findings and still have tool budget remaining, continue investigating additional files before synthesizing. Only stop early if the repository genuinely has no more content-heavy surface to investigate.
After finding 3 CRITICAL issues, stop expanding the investigation to new optional files. Report every finding already discovered.
If the tool budget is exhausted, stop and synthesize. Never continue tool use past the budget.

For every meaningful finding, answer the key question: "Can we serve a very large number of users without hitting origin servers?"

---

## OUTPUT REQUIREMENTS

Return a compact findings digest, not a full report. The orchestrator will write the final user report.
Do NOT include executive summary, stack recap, schema recap, priority list, code snippets, or "if you want" follow-ups.
Do NOT call finalReport or any report tool. Output plain structured text only.

Use exactly this format:

--- CRITICAL FINDINGS ---

[CDN-1] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact content delivery pattern and why it fails at scale.
Impact: max 1 sentence. Include what breaks under high concurrent traffic.
Fix: max 1 sentence. State the concrete first fix.

[CDN-2] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences. State the exact content delivery pattern and why it causes bandwidth waste or origin overload.
Impact: max 1 sentence. Include what breaks under high concurrent traffic.
Fix: max 1 sentence. State the concrete first fix.

--- WARNING FINDINGS ---

[CDN-3] Short title, max 10 words
File: path/to/file.ts (Lx-Ly)
Evidence: max 2 sentences.
Impact: max 1 sentence.
Fix: max 1 sentence.

--- INFO ---

[CDN-4] Short title, max 10 words
File: path/to/file.ts or package/config context
Evidence: max 1 sentence.
Use INFO only for useful context, healthy observations, or lower-confidence findings.

Severity definitions:
- CRITICAL: proven origin overload risk, no CDN for high-traffic assets, large unoptimized images on critical pages, missing cache headers on high-traffic routes, or storage bottleneck that will fail under concurrent load.
- WARNING: proven content delivery inefficiency that degrades performance under load but does not immediately cause origin failure.
- INFO: useful context, healthy observations, or no content-heavy surface found.

Compression rules:
- Report every distinct in-scope content finding you discovered. Drop non-content findings silently.
- Keep the digest compact by merging only genuinely overlapping instances of the same root cause; do not merge unrelated findings.
- Target 3-6 findings when possible, but exceeding that is required if you discovered more distinct findings.
- Sort by severity, then scale impact.
- Each finding must preserve: file, pattern/evidence, impact, and fix.
- Maximum 120 words per CRITICAL finding and 90 words per WARNING finding.
- No markdown tables. No nested bullets. No long explanations.

When your investigation is complete, output your findings as your final message. Just return the findings as structured text in your last response.`;

// --- Tools --------------------------------------------------------------------

const contentAgentTools = [
    searchCodeTool,
    getFileContentTool,
];

// --- Main Exported Function ---------------------------------------------------

export async function runContentHeavyAgent(
    input: ContentHeavyAgentInput
): Promise<ContentHeavyAgentOutput> {
    const { repositoryId, installationId, userId, onEvent } = input;
    const startTime = Date.now();

    const emit = (event: StreamEvent) => {
        try { onEvent?.(event); } catch { /* ignore stream errors */ }
    };

    const shared = {
        toolCallCount: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        lastToolName: "unknown",
        startTime,
        emit,
    };

    console.log(`[contentAgent] Starting investigation for: ${repositoryId}`);

    emit({
        type: "agent_start",
        stepNumber: 0,
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: `Starting Content-heavy agent for ${repositoryId}`,
    });

    try {
        const repository = await prisma.repository.findFirst({
            where: userId ? {
                OR: [
                    { id: repositoryId },
                    {
                        userId,
                        repositoryId,
                    }
                ]
            } : {
                OR: [
                    { id: repositoryId },
                    { repositoryId }
                ]
            },
            select: {
                fullName: true,
                defaultBranch: true,
                packageJson: true,
                repoContent: true,
                framework: true,
            },
        });

        if (!repository || !repository.fullName) {
            return {
                rawFindings: null,
                intermediateSteps: [],
                totalToolCalls: 0,
                executionTimeMs: Date.now() - startTime,
                error: `Repository "${repositoryId}" not found in database. Run framework analysis first.`,
            };
        }

        const [owner, repo] = repository.fullName.split("/");
        const branch = repository.defaultBranch ?? "main";
        const framework = repository.framework ?? "unknown";
        const packageJsonStr = repository.packageJson
            ? JSON.stringify(repository.packageJson).slice(0, 3000)
            : "Not available";
        const repoContentStr = repository.repoContent
            ? JSON.stringify(repository.repoContent)
            : "Not available";

        console.log(`[contentAgent] Repo: ${repository.fullName} (${branch})`);

        const { middleware: toolBudgetMiddleware } = createToolBudgetMiddleware({
            agentLabel: "contentAgent",
            toolBudget: 15,
            searchBudget: 3,
            shared,
        });

        const agent = createAgent({
            model: gpt5Mini,
            tools: contentAgentTools,
            systemPrompt: SYSTEM_PROMPT,
            contextSchema: githubContextSchema,
            middleware: [toolBudgetMiddleware],
        });

        const result = await agent.invoke(
            {
                messages: [
                    {
                        role: "user",
                        content:
                            `Analyze the repository ${repository.fullName} for content delivery and asset optimization risks.

REPOSITORY CONTEXT:
- Framework: ${framework}
- Package.json dependencies: ${packageJsonStr}
- Full repository file tree: ${repoContentStr}

**Primary Objectives:**
1. **CDN Usage** - Check if static assets, images, and media are served via CDN or directly from origin
2. **Asset Optimization** - Find large unoptimized images, unminified bundles, missing compression
3. **Cache Headers** - Check for missing or misconfigured cache-control headers on static and API routes
4. **Image Pipeline** - Verify next/image or equivalent optimization, responsive sizing, modern formats (WebP/AVIF)
5. **Bundle Size** - Identify large client bundles, missing code splitting, tree-shaking gaps
6. **Storage Read Throughput** - Check if asset serving patterns can handle high concurrent reads

Tool constraints:
- HARD LIMIT: use at most 15 tool calls total, then stop and return the digest, never exceed this limit
- searchCode EARLY EXIT: if 2 consecutive searches return 0 results, stop using searchCode entirely and navigate the file tree with getFileContent instead
- Decide yourself whether searchCode is needed; do not follow a preset search query
- Use package.json and file tree before tools
- If package.json and file tree show no content-heavy surface, return INFO without tool calls

**Scope constraint:** Only report content delivery and asset optimization risks: CDN misses, unoptimized assets, missing cache headers, image pipeline gaps, bundle bloat, and storage read throughput. Ignore unrelated issues silently.
**Key question:** Can we serve a very large number of users without hitting origin servers?

Return the compact findings digest required by the system prompt. Do not call any report tool. Do not include executive summary, stack recap, priority list, code snippets, or follow-up offers. If you are near the tool limit, stop using tools and synthesize from available evidence.`,
                    },
                ],
            },
            {
                context: { owner, repo, branch, installationId },
                recursionLimit: 50,
                callbacks: [
                    {
                        handleToolStart(tool: any, input: string) {
                            shared.toolCallCount++;
                            const toolName = resolveCallbackToolName(tool, shared.lastToolName);
                            shared.lastToolName = toolName;
                            let parsedInput: unknown = input;
                            try { parsedInput = JSON.parse(input); } catch { /* keep raw */ }
                            emit({ type: "tool_start", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, toolName, toolInput: parsedInput, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                        handleToolEnd(output: any) {
                            const outputStr = typeof output?.content === "string" ? output.content : typeof output === "string" ? output : JSON.stringify(output) ?? "";
                            emit({ type: "tool_end", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, toolName: shared.lastToolName, toolOutput: outputStr.slice(0, 5000), toolOutputLength: outputStr.length, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                        handleChainError(error: Error) {
                            console.error(`[contentAgent] CHAIN ERROR: ${error.message}`);
                            emit({ type: "error", stepNumber: shared.toolCallCount, timestamp: new Date().toISOString(), elapsedMs: Date.now() - startTime, error: error.message, cumulativeTokens: { inputTokens: shared.cumulativeInputTokens, outputTokens: shared.cumulativeOutputTokens, totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens } });
                        },
                    },
                ],
            }
        );

        const messages = result.messages ?? [];
        const toolMessages = messages.filter(
            (msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0
        );
        const totalToolCalls = toolMessages.length;

        const lastAiMessage = [...messages]
            .reverse()
            .find((msg: any) => msg._getType?.() === "ai" || msg.role === "assistant");

        const rawFindings: string =
            typeof lastAiMessage?.content === "string"
                ? lastAiMessage.content
                : JSON.stringify(lastAiMessage?.content ?? "");

        const executionTimeMs = Date.now() - startTime;

        if (!rawFindings || rawFindings.trim().length === 0) {
            console.error(
                "[contentAgent] Error: Agent completed without returning any findings"
            );
            return {
                rawFindings: null,
                intermediateSteps: messages,
                totalToolCalls,
                executionTimeMs,
                error:
                    "Agent completed without returning findings. " +
                    "Check intermediate steps for partial investigation.",
            };
        }



        emit({
            type: "done",
            stepNumber: shared.toolCallCount,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings,
            totalToolCalls,
            executionTimeMs,
            cumulativeTokens: {
                inputTokens: shared.cumulativeInputTokens,
                outputTokens: shared.cumulativeOutputTokens,
                totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens,
            },
        });

        return {
            rawFindings,
            intermediateSteps: messages,
            totalToolCalls,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const message =
            error instanceof Error ? error.message : "Unknown error occurred";

        emit({
            type: "done",
            stepNumber: shared.toolCallCount,
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            rawFindings: null,
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
            cumulativeTokens: {
                inputTokens: shared.cumulativeInputTokens,
                outputTokens: shared.cumulativeOutputTokens,
                totalTokens: shared.cumulativeInputTokens + shared.cumulativeOutputTokens,
            },
        });

        return {
            rawFindings: null,
            intermediateSteps: [],
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
        };
    }
}
