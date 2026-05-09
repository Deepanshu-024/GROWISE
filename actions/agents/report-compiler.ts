/* eslint-disable @typescript-eslint/no-explicit-any */

import { gpt5Mini } from "@/lib/llm";
import prisma from "@/lib/prisma";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReportCompilerStreamEvent {
    type:
        | "compiler_start"
        | "compiler_thinking"
        | "compiler_completed"
        | "compiler_failed";
    timestamp: string;
    elapsedMs: number;
    reasoning?: string;
    compiledReport?: string;
    error?: string;
    tokenUsage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}

export interface ReportCompilerInput {
    repositoryId: string; // Internal DB id (Repository.id)
    onEvent?: (event: ReportCompilerStreamEvent) => void;
}

export interface ReportCompilerOutput {
    compiledReport: string | null;
    executionTimeMs: number;
    error?: string;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const COMPILER_SYSTEM_PROMPT = `You are an elite technical report compiler. Your job is to take the raw findings from multiple specialist analysis agents and synthesize them into a single, polished, founder-optimized scalability report.

Your audience is **startup founders and CTOs** — people who need to make investment, hiring, and architecture decisions based on this report. They care about business impact, cost, revenue risk, and actionable next steps. They do NOT want raw technical jargon without context.

Your primary responsibility is preservation plus prioritization:
- Preserve every distinct issue from every completed sub-report. Do not drop lower-priority findings just because higher-priority findings exist.
- Deduplicate only when multiple agents describe the same root cause. When deduplicating, keep every source finding ID in the combined item.
- Translate each technical issue into founder language: what business function is threatened, when it is likely to break, what it costs to fix, and what it costs to ignore.
- Identify the **first likely breakpoint** for the product as it scales: the earliest user, traffic, data-volume, queue-depth, connection, or spend threshold where any important user-facing, revenue, or operational failure is likely to appear.

═══════════════════════════════════════════════════════════════
MANDATORY REPORT STRUCTURE — PRODUCE ALL 11 SECTIONS
═══════════════════════════════════════════════════════════════

You MUST produce a report with exactly these sections in this order. Use markdown heading hierarchy. If a section has no relevant findings, write a brief positive note (e.g., "No payment-related risks detected — this area is healthy.") rather than omitting the section.

## 1. Executive Verdict

- **Health Grade**: Assign a letter grade A / B / C / D / F based on the overall severity distribution:
  - A = No critical findings, few warnings → production-ready at current scale
  - B = No critical findings, moderate warnings → stable but needs attention before 10x growth
  - C = 1–2 critical findings → will experience outages at moderate scale without fixes
  - D = 3+ critical findings → significant risk of failure under real production traffic
  - F = Systemic critical failures across multiple layers → immediate engineering intervention required
- **Top 3 Risks**: Ranked by BUSINESS impact (revenue loss > user churn > performance degradation > technical debt). Summarize each in one sentence a non-technical founder can understand.
- **Estimated Scale Ceiling**: Based on the worst critical findings, state the approximate user count where the first outage or severe degradation will occur. Be specific: "~15,000 concurrent users" not "medium scale."
- **First Likely Breakpoint**: Name the single earliest scaling breakpoint across all sub-reports. Include the source finding ID(s), what breaks first, the approximate threshold, why this is the earliest blocker, and the fastest credible mitigation.

## 2. Cost to Scale

For each critical and high-priority warning finding:
- **What breaks**: One sentence describing the failure mode
- **When it breaks**: User count / traffic threshold
- **Fix effort**: T-shirt size (S = config change/1 day, M = code change/2-3 days, L = architectural change/1–2 weeks, XL = major rewrite/2+ weeks)
- **Estimated fix cost**: Use a practical founder-facing range in USD. Base the estimate on engineering time and likely infrastructure/vendor cost. If evidence is incomplete, provide a conservative range and label it as an estimate.
- **Tech debt tax**: What happens if you DON'T fix it (ongoing cost in engineering time, incident response, lost revenue)

Include a summary table at the end of this section with columns:
| Source | Issue | Breakpoint | Effort | Estimated fix cost | Cost if ignored |

## 3. Revenue Risk Assessment

Group findings into three categories:
- **Direct Revenue Loss**: Findings that cause failed payments, broken checkouts, lost transactions, subscription desyncs
- **User Churn Risk**: Findings that cause slow pages, broken auth, degraded experience under load, timeouts
- **Compliance / Legal Risk**: Data inconsistency, missing idempotency in financial flows, audit trail gaps

For each item, name the source finding (e.g., [PAY-1], [DB-3]) and explain the business consequence in plain language.

## 4. Scalability Roadmap

Present a phased plan:

**Phase 1 — Survive to 10K Users (Quick Wins)**
- List fixes that are S or M effort and prevent the most imminent failures
- These should be achievable in 1–2 sprint cycles

**Phase 2 — Scale to 100K Users (Architectural Improvements)**
- List fixes that require L effort and address scaling bottlenecks
- These typically need design review and may involve new infrastructure

**Phase 3 — Scale to 1M+ Users (Infrastructure Investment)**
- List fixes that require XL effort or new infrastructure (caching layers, worker queues, read replicas)
- Frame these as investment decisions with ROI context

## 5. Infrastructure & Architecture Health

Consolidate findings by layer. For each layer, provide a one-line verdict and then list relevant findings:
- **Database Layer**: Connection pooling, indexing, query patterns, schema design, caching
- **Compute Layer**: CPU-heavy operations, memory pressure, algorithm efficiency, worker architecture
- **Authentication Layer**: Session management, provider integration, route protection, rate limiting
- **Realtime Layer**: WebSocket/SSE scaling, connection management, pub/sub architecture
- **Event / Queue Layer**: Reliability, ordering, dead-letter handling, retry strategy

If a layer had no agent assigned (because the archetype was not detected), state: "Not analyzed — [archetype] was not detected in this repository."

## 6. Security & Trust Surface

Summarize security-relevant findings across all agents:
- Payment webhook signature verification status
- Auth token/session security posture
- Secret key exposure risks
- Data integrity guarantees (transaction wrapping, idempotency)
- Rate limiting on sensitive endpoints

## 7. AI/ML Operational Costs

If AI-related findings exist:
- Token consumption patterns and cost projections at scale
- Model latency impact on user experience
- Embedding storage and retrieval scaling
- Fallback/retry strategy adequacy

If no AI agent ran or no AI findings exist, write: "No AI/ML integration detected — this section is not applicable."

## 8. Content & Media Pipeline

If content-related findings exist:
- CDN and caching strategy assessment
- Image/video optimization status
- Upload/processing pipeline scaling risks

If no content agent ran or no content findings exist, write: "No significant content pipeline detected — this section is not applicable."

## 9. Cross-Cutting Concerns

Identify findings that span multiple agents or represent systemic issues:
- Missing caching that impacts both database and compute performance
- Shared utility functions with scaling issues used across multiple routes
- Dependency risks (outdated packages, single points of failure)
- Monitoring and observability gaps

Deduplicate: if the same root cause appears in multiple agent reports, consolidate it here and reference the original finding IDs.

## 10. Prioritized Action Plan

Produce a single, deduplicated, priority-ordered list. Each item must include:
- **#N**: Sequential number
- **Title**: Clear, actionable title
- **Urgency**: NOW (fix before next deploy) / SOON (fix within 2 sprints) / LATER (plan for next quarter)
- **Effort**: S / M / L / XL
- **Estimated fix cost**: Practical USD range, including engineering and likely infra/vendor spend when relevant
- **Impact**: What the fix prevents (outage, revenue loss, churn, degradation)
- **Source**: Which agent finding(s) this addresses (e.g., [DB-1], [PAY-2])

Sort by: NOW items first, then SOON, then LATER. Within each urgency tier, sort by business impact.

After the priority list, add a concise **Investment Summary** with:
- Total estimated cost to solve NOW items
- Total estimated cost to solve NOW + SOON items
- Highest ROI fix and why
- Biggest cost uncertainty and what data would reduce it

## 11. Confidence & Coverage

- List which agents ran successfully and which failed (with error if available)
- State overall analysis confidence: HIGH (most agents succeeded, strong evidence) / MEDIUM (some gaps) / LOW (significant agent failures)
- List areas NOT covered and why
- Include standard caveat: "This analysis is based on static code review. Runtime behavior, infrastructure configuration, and production traffic patterns may reveal additional issues not captured here."

═══════════════════════════════════════════════════════════════
SYNTHESIS RULES
═══════════════════════════════════════════════════════════════

1. **Deduplicate**: If two agents report the same root cause (e.g., DB agent and compute agent both flag missing caching), consolidate into one finding and reference both sources.
2. **Do not lose issues**: Every distinct source issue must appear at least once in the final report, either in the relevant layer section, cost table, revenue-risk section, cross-cutting section, or action plan. Lower severity issues can be brief, but they must not disappear.
3. **Translate**: Convert technical findings into business language. "N+1 query on /api/products" → "Your product listing page makes 1 database call per product instead of 1 total. At 1,000 products and 100 concurrent users, this creates 100,000 simultaneous database queries."
4. **Prioritize by business impact**: A payment webhook without signature verification (revenue risk) ranks higher than a missing database index on a low-traffic page.
5. **Find the earliest breakpoint**: Compare all reported breakpoints and identify the first plausible failure point. If reports use different units, normalize them in plain language and explain the assumption.
6. **Estimate cost pragmatically**: Use USD ranges, not false precision. Consider engineering effort, infrastructure changes, vendor costs, migration risk, and validation/testing time. Mark estimates as "rough estimate" when the sub-reports do not provide enough data.
7. **Be specific**: Don't say "performance may degrade." Say "response time will exceed 3 seconds at approximately 500 concurrent users."
8. **Don't invent findings**: Only report findings that appear in the agent digests. You may estimate breakpoint and fix cost from the evidence, but clearly label assumptions.
9. **Preserve traceability**: Always reference the original finding IDs (e.g., [DB-1], [AUTH-2]) so the reader can trace back to the raw analysis.
10. **Format for readability**: Use markdown tables where appropriate, bold key terms, and keep paragraphs short. The report should be scannable in 5 minutes but detailed enough for a 30-minute deep read.
11. **No preamble**: Start directly with "## 1. Executive Verdict". Do not include introduction paragraphs, greetings, or meta-commentary about the report itself.`;

// ─── Main Function ────────────────────────────────────────────────────────────

export async function runReportCompiler(
    input: ReportCompilerInput,
): Promise<ReportCompilerOutput> {
    const { repositoryId, onEvent } = input;
    const startTime = Date.now();

    const emit = (event: ReportCompilerStreamEvent) => {
        try {
            onEvent?.(event);
        } catch {
            /* ignore stream errors */
        }
    };

    console.log(`[reportCompiler] Starting compilation for repository: ${repositoryId}`);

    emit({
        type: "compiler_start",
        timestamp: new Date().toISOString(),
        elapsedMs: 0,
        reasoning: "Reading all completed agent reports from database...",
    });

    try {
        // ── 1. Fetch repository metadata ───────────────────────────────────

        const repository = await prisma.repository.findFirst({
            where: {
                OR: [{ id: repositoryId }, { repositoryId }],
            },
            select: {
                id: true,
                fullName: true,
                framework: true,
                archetypes: true,
                archClassificationConfidence: true,
                packageJson: true,
            },
        });

        if (!repository) {
            const errorMsg = `Repository "${repositoryId}" not found.`;
            emit({
                type: "compiler_failed",
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMsg,
            });
            return {
                compiledReport: null,
                executionTimeMs: Date.now() - startTime,
                error: errorMsg,
            };
        }

        // ── 2. Fetch all completed agent reports ───────────────────────────

        const agentReports = await prisma.agentReport.findMany({
            where: { repositoryId: repository.id },
            select: {
                archetype: true,
                status: true,
                rawFindings: true,
                totalToolCalls: true,
                executionTimeMs: true,
                error: true,
            },
            orderBy: { createdAt: "asc" },
        });

        if (agentReports.length === 0) {
            const errorMsg = "No agent reports found. Run the orchestrator first.";
            emit({
                type: "compiler_failed",
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMsg,
            });
            return {
                compiledReport: null,
                executionTimeMs: Date.now() - startTime,
                error: errorMsg,
            };
        }

        const completedReports = agentReports.filter(
            (r) => r.status === "completed" && r.rawFindings,
        );
        const failedReports = agentReports.filter((r) => r.status === "failed");

        console.log(
            `[reportCompiler] Found ${agentReports.length} reports: ` +
            `${completedReports.length} completed, ${failedReports.length} failed`,
        );

        if (completedReports.length === 0) {
            const errorMsg =
                "All agent reports failed — nothing to compile. Check individual agent errors.";
            emit({
                type: "compiler_failed",
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMsg,
            });
            return {
                compiledReport: null,
                executionTimeMs: Date.now() - startTime,
                error: errorMsg,
            };
        }

        // ── 3. Build the context for the LLM ──────────────────────────────

        // Archetypes summary
        const archetypes = Array.isArray(repository.archetypes)
            ? (repository.archetypes as { name: string; score: number }[])
            : [];

        const archetypeSummary = archetypes
            .map((a) => `  - ${a.name}: ${(a.score * 100).toFixed(0)}% match`)
            .join("\n");

        // Package.json summary (truncated for token efficiency)
        const pkgJson = repository.packageJson
            ? JSON.stringify(repository.packageJson).slice(0, 2000)
            : "Not available";

        // Build agent findings block
        const findingsBlocks = completedReports
            .map((r) => {
                return [
                    `════════════════════════════════════════════`,
                    `AGENT: ${r.archetype}`,
                    `Status: completed | Tool calls: ${r.totalToolCalls} | Execution: ${r.executionTimeMs}ms`,
                    `════════════════════════════════════════════`,
                    ``,
                    r.rawFindings,
                    ``,
                ].join("\n");
            })
            .join("\n");

        // Build failed agents block
        const failedBlock =
            failedReports.length > 0
                ? failedReports
                      .map((r) => `  - ${r.archetype}: FAILED — ${r.error ?? "Unknown error"}`)
                      .join("\n")
                : "  None — all agents completed successfully.";

        const userMessage = `Compile the final founder-optimized scalability report for the following repository.

═══════════════════════════════════════════════════════════════
REPOSITORY METADATA
═══════════════════════════════════════════════════════════════
- Repository: ${repository.fullName}
- Framework: ${repository.framework ?? "unknown"}
- Classification confidence: ${repository.archClassificationConfidence ?? "unknown"}
- Detected archetypes:
${archetypeSummary || "  None detected"}
- Package.json (summary): ${pkgJson}

═══════════════════════════════════════════════════════════════
AGENT EXECUTION SUMMARY
═══════════════════════════════════════════════════════════════
- Total agents dispatched: ${agentReports.length}
- Completed successfully: ${completedReports.length}
- Failed: ${failedReports.length}

Failed agents:
${failedBlock}

═══════════════════════════════════════════════════════════════
RAW AGENT FINDINGS (input for synthesis)
═══════════════════════════════════════════════════════════════

${findingsBlocks}

═══════════════════════════════════════════════════════════════
INSTRUCTIONS
═══════════════════════════════════════════════════════════════

Synthesize ALL the agent findings above into the 11-section founder-optimized report defined in your system prompt. Do not omit any section. Deduplicate cross-agent findings only when they share the same root cause. Translate technical jargon into business language. Preserve every distinct issue from every completed sub-report, and preserve all original finding IDs for traceability.

Founder-output requirements:
- Include the first likely breakpoint: the earliest threshold where the product is likely to break as it scales.
- Include estimated fix cost ranges in USD for each critical/high-priority issue and for each prioritized action item.
- Include the cost of ignoring each important issue.
- If you estimate a breakpoint or cost from incomplete evidence, label the assumption clearly instead of pretending it is certain.

Start your response directly with "## 1. Executive Verdict".`;

        emit({
            type: "compiler_thinking",
            timestamp: new Date().toISOString(),
            elapsedMs: Date.now() - startTime,
            reasoning: `Synthesizing ${completedReports.length} agent reports into founder-optimized report...`,
        });

        // ── 4. Invoke LLM ─────────────────────────────────────────────────

        console.log("[reportCompiler] Invoking LLM for synthesis...");

        const response = await gpt5Mini.invoke([
            { role: "system", content: COMPILER_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
        ]);

        const compiledReport =
            typeof response.content === "string"
                ? response.content
                : JSON.stringify(response.content);

        // Extract token usage
        const usageMeta = (response as any).usage_metadata ?? null;
        const inputTokens = usageMeta?.input_tokens ?? usageMeta?.inputTokens ?? 0;
        const outputTokens = usageMeta?.output_tokens ?? usageMeta?.outputTokens ?? 0;

        console.log(
            `[reportCompiler] LLM response received: ${compiledReport.length} chars, ` +
            `tokens: ${inputTokens} in / ${outputTokens} out`,
        );

        if (!compiledReport || compiledReport.trim().length === 0) {
            const errorMsg = "LLM returned empty response.";
            emit({
                type: "compiler_failed",
                timestamp: new Date().toISOString(),
                elapsedMs: Date.now() - startTime,
                error: errorMsg,
            });
            return {
                compiledReport: null,
                executionTimeMs: Date.now() - startTime,
                error: errorMsg,
            };
        }

        // ── 5. Persist to database ─────────────────────────────────────────

        await prisma.repository.update({
            where: { id: repository.id },
            data: {
                compiledReport,
                compiledReportAt: new Date(),
            },
        });

        console.log("[reportCompiler] Compiled report saved to database.");

        const executionTimeMs = Date.now() - startTime;

        emit({
            type: "compiler_completed",
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            compiledReport,
            tokenUsage: {
                inputTokens,
                outputTokens,
                totalTokens: inputTokens + outputTokens,
            },
        });

        console.log(`[reportCompiler] Done in ${executionTimeMs}ms.`);

        return {
            compiledReport,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const message =
            error instanceof Error ? error.message : "Unknown error occurred";

        console.error(`[reportCompiler] Error: ${message}`);

        emit({
            type: "compiler_failed",
            timestamp: new Date().toISOString(),
            elapsedMs: executionTimeMs,
            error: message,
        });

        return {
            compiledReport: null,
            executionTimeMs,
            error: message,
        };
    }
}
