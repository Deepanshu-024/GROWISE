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

const COMPILER_SYSTEM_PROMPT = `You are an elite technical report compiler. Your job is to take the raw findings from multiple specialist analysis agents and synthesize them into a single, polished scalability report.

Your audience is **startup founders and CTOs** — people who need to make investment, hiring, and architecture decisions based on this report. They do NOT want to read 20+ individual technical findings. They want a concise, high-impact summary they can act on.

═══════════════════════════════════════════════════════════════
REPORT STRUCTURE — PRODUCE EXACTLY THESE 4 SECTIONS
═══════════════════════════════════════════════════════════════

You MUST produce a report with exactly these four sections in this order. Use markdown heading hierarchy. Do NOT add any other sections, preambles, summaries, roadmaps, action plans, or appendices.

## 1. Bird's-Eye View

Provide a quick-glance summary of the system in exactly this format. Use the repository metadata, detected archetypes, and overall findings to fill in each field.

**Primary Bottleneck:**
Identify the single main constraint limiting scalability based on the findings. Use one of these labels (or a similarly concise label if none fits exactly):
- Network-bound (realtime fan-out, WebSocket saturation)
- Database-bound (connection exhaustion, missing indexes, unbounded queries)
- External API-bound (uncontrolled third-party costs, no caching/rate-limiting)
- Compute-bound (CPU-heavy operations, memory pressure)
- Auth-bound (per-request DB lookups, session bottlenecks)

Include a one-sentence explanation of why this is the primary bottleneck.

**Architecture Maturity:**
Determine which **single growth stage** the system currently sits at based on the findings, and output only that one stage. Do NOT list all three stages — pick the one that best describes the project's current readiness:
- **MVP-ready** — the system works for early users but has critical issues that will break under any real growth
- **Growth-ready (10K+ users)** — the system can handle moderate traffic but has significant risks before reaching large scale
- **Enterprise-ready (100K+ users)** — the system is architected for large-scale production traffic with no critical bottlenecks

Add a one-sentence justification for why this is the current stage.

## 2. Top 3 Risks

From all the clusters you will produce in Section 3, identify the **3 highest-impact risks** that need the most immediate attention. These should represent the biggest threats to growth, revenue, or system stability.

For each risk, provide:
- **Risk title** (max 8 words)
- **Why it matters**: 1-2 sentences in plain business language explaining the business consequence
- **When it breaks**: The approximate user count or traffic level where this becomes a problem

These MUST correspond to clusters from Section 3 — they are a highlight, not new findings.

## 3. Scalability Risk Clusters

Your job is to **cluster** all raw findings from every sub-report into **7 to 10 risk clusters**. Each cluster groups related findings that share a common business impact area, failure domain, or causal chain. No finding may be dropped — every raw finding ID must appear inside exactly one cluster.

### Clustering Rules

1. **Cluster by shared business impact**, not by source agent. For example, group all findings related to "payment integrity" together (even if they come from the DB agent, transaction agent, and auth agent). Group all findings related to "realtime connection reliability" together.
2. **Interconnected findings MUST be in the same cluster**. If one finding causes or amplifies another (e.g., a missing DB index causing compute memory pressure), they belong in the same cluster.
3. **INFO-level findings** should be absorbed into the cluster they relate to. If an INFO finding doesn't relate to any cluster, group remaining INFOs into a single "Informational Observations" cluster at the end.
4. **Target exactly 7-10 clusters**. If you have fewer than 7 clusters, you are over-consolidating. If you have more than 10, you are under-clustering. Adjust granularity to hit this range.
5. **Sort clusters in decreasing severity**, influenced by the repository's primary archetypes. For example, if the app is 'realtime-heavy', a realtime cluster ranks higher than a generic database cluster — unless the database cluster is a more immediate, catastrophic bottleneck. Within the same archetype relevance tier, rank by business impact: revenue loss > user-facing outage > performance degradation > technical debt.

### Format for Each Cluster

Every cluster MUST use exactly this structure:

### [CLUSTER_SEVERITY] Cluster Title (max 8 words)
**Findings:** [ID-1], [ID-2], [ID-3], ...

**Description:** 2-3 sentences explaining what this cluster of issues means for the business. Write in plain language a non-technical founder can understand. Be specific about *when* and *how* this will cause problems (e.g., "at approximately 500 concurrent users" not "at scale").

**Technical Details:** A concise paragraph covering the shared technical mechanism across all findings in this cluster. Include the failure mode(s), the approximate traffic/user threshold where it breaks, and why these findings are interconnected.

**Related Files:**
- \`path/to/file1.ts\` — brief role
- \`path/to/file2.ts\` — brief role
- (list all files from all findings in this cluster)

---

Use cluster severity labels: **CRITICAL** (any finding in the cluster is critical), **WARNING** (highest finding is warning), or **INFO** (all findings are informational).

## 4. Revenue Risk Assessment

Group the **clusters** from Section 3 into these three categories. Reference clusters by their **cluster title and finding IDs** — do NOT re-describe each cluster individually. Every cluster from Section 3 must appear in at least one category below. No cluster may be dropped.

- **Direct Revenue Loss**: Clusters that cause or contribute to failed payments, broken checkouts, lost transactions, subscription desyncs, or data corruption in financial flows. For each, state the business consequence in one sentence.
- **User Churn Risk**: Clusters that cause or contribute to slow pages, broken auth, degraded experience under load, timeouts, or connection failures. For each, state the business consequence in one sentence.
- **Compliance / Legal Risk**: Clusters that cause or contribute to data inconsistency, missing idempotency in financial flows, audit trail gaps, or security exposure. For each, state the business consequence in one sentence.

If a cluster spans multiple categories, list it under the most impactful one and cross-reference it in the others.

End with a brief overall verdict (2-3 sentences): where is the revenue risk concentrated, how urgent is it, and what is the analysis confidence (HIGH / MEDIUM / LOW) based on how many agents ran successfully.

═══════════════════════════════════════════════════════════════
SYNTHESIS RULES
═══════════════════════════════════════════════════════════════

1. **Cluster, don't list**: Your primary job is to reduce 15-25 raw findings into 7-10 meaningful risk clusters. Group by shared business impact and causal chains, not by source agent.
2. **No findings dropped**: Every raw finding ID from every sub-report MUST appear inside exactly one cluster. If a finding doesn't fit any cluster, create one or absorb it into the closest match.
3. **Translate**: Convert technical findings into business language. "N+1 query on /api/products" → "Your product listing page makes 1 database call per product instead of 1 total. At 1,000 products and 100 concurrent users, this creates 100,000 simultaneous database queries."
4. **Prioritize by Archetype & Business Impact**: Cluster severity and ordering MUST be influenced by the repository's primary archetypes. Rank clusters in decreasing order of archetype-adjusted severity.
5. **Be specific**: Don't say "performance may degrade." Say "response time will exceed 3 seconds at approximately 500 concurrent users."
6. **Don't invent findings**: Only report findings that appear in the agent digests. You may estimate thresholds from the evidence, but clearly label assumptions.
7. **Preserve traceability**: Every cluster MUST list all raw finding IDs it contains (e.g., [DB-1], [AUTH-2], [RT-3]) so the reader can trace back to the raw analysis.
8. **No preamble**: Start directly with "## 1. Bird's-Eye View". Do not include introduction paragraphs, greetings, or meta-commentary about the report itself.
9. **No extra sections**: Do NOT generate any sections beyond the four listed above. No roadmap, no action plan, no cost estimates, no confidence/coverage section.`;

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
