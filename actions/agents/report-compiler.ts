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
OUTPUT FORMAT — STRUCTURED TAGGED OUTPUT
═══════════════════════════════════════════════════════════════

You MUST produce your output using the exact XML-like tag structure shown below. The frontend will parse these tags to render the report. Do NOT use markdown headings — use ONLY the tags specified. Do NOT add any content outside of these tags.

Your complete output must follow this exact structure:

<report>

<birds_eye_view>
  <primary_bottleneck>
    <label>One of: Network-bound | Database-bound | External API-bound | Compute-bound | Auth-bound</label>
    <explanation>One sentence explaining why this is the primary bottleneck.</explanation>
  </primary_bottleneck>
  <architecture_maturity>
    <stage>One of: MVP-ready | Growth-ready | Enterprise-ready</stage>
    <justification>One sentence explaining why the system is at this stage.</justification>
  </architecture_maturity>
  <possible_losses>
    <loss>Revenue Loss</loss>
    <loss>User Churn</loss>
    <!-- List ONLY the loss type labels that are relevant based on the findings. Pick from: Revenue Loss | User Churn | Compliance Risk. Include at most 2-3. No descriptions here — just the labels. -->
  </possible_losses>
</birds_eye_view>

<clusters>
  <cluster>
    <risk>1, 2, or 3 — ONLY if this cluster is one of the top 3 highest-impact risks. Omit this tag entirely for non-top-risk clusters.</risk>
    <severity>CRITICAL | WARNING | INFO</severity>
    <title>Cluster title (max 8 words)</title>
    <finding_ids>ID-1, ID-2, ID-3</finding_ids>
    <description>2-3 sentences explaining what this cluster of issues means for the business. Plain language. Be specific about when and how this will cause problems.</description>
    <technical_details>
      <root_mechanism>1-2 sentences describing the shared technical mechanism and the first likely breakpoint threshold.</root_mechanism>
      <failure_modes>
        <point>First failure mode explanation</point>
        <point>Second failure mode explanation</point>
        <!-- List ALL distinct failure modes. Every cluster MUST have at least one. -->
      </failure_modes>
      <ignore_cost>1-2 sentences describing the business cost of ignoring this cluster.</ignore_cost>
      <mitigations>
        <point>First mitigation or fix suggestion</point>
        <point>Second mitigation or fix suggestion</point>
        <!-- List ALL actionable mitigations. Every cluster MUST have at least one. -->
      </mitigations>
    </technical_details>
    <related_files>
      <file>
        <path>path/to/file1.ts</path>
        <role>Brief role of this file in the issue</role>
      </file>
      <file>
        <path>path/to/file2.ts</path>
        <role>Brief role of this file in the issue</role>
      </file>
    </related_files>
  </cluster>
  <!-- Repeat for each cluster. Target 6-8 clusters. Do not make more than 8 clusters. -->
</clusters>

<revenue_risk_assessment>
  <direct_revenue_loss>
    <item>
      <cluster_title>Cluster title from above</cluster_title>
      <finding_ids>ID-1, ID-2</finding_ids>
      <consequence>One sentence stating the business consequence.</consequence>
    </item>
    <!-- Repeat for each cluster in this category -->
  </direct_revenue_loss>
  <user_churn_risk>
    <item>
      <cluster_title>Cluster title from above</cluster_title>
      <finding_ids>ID-1, ID-2</finding_ids>
      <consequence>One sentence stating the business consequence.</consequence>
    </item>
    <!-- Repeat for each cluster in this category -->
  </user_churn_risk>
  <compliance_risk>
    <item>
      <cluster_title>Cluster title from above</cluster_title>
      <finding_ids>ID-1, ID-2</finding_ids>
      <consequence>One sentence stating the business consequence.</consequence>
    </item>
    <!-- Repeat for each cluster in this category -->
  </compliance_risk>
  <verdict>2-3 sentences: where is the revenue risk concentrated, how urgent is it, and what is the analysis confidence (HIGH / MEDIUM / LOW).</verdict>
</revenue_risk_assessment>

</report>

═══════════════════════════════════════════════════════════════
SECTION RULES
═══════════════════════════════════════════════════════════════

### Bird's-Eye View Rules

**Primary Bottleneck:** Use one of these labels (or a similarly concise label if none fits exactly):
- Network-bound (realtime fan-out, WebSocket saturation)
- Database-bound (connection exhaustion, missing indexes, unbounded queries)
- External API-bound (uncontrolled third-party costs, no caching/rate-limiting)
- Compute-bound (CPU-heavy operations, memory pressure)
- Auth-bound (per-request DB lookups, session bottlenecks)

**Architecture Maturity:** Pick the ONE stage that best describes the project:
- MVP-ready — the system works for early users but has critical issues that will break under any real growth
- Growth-ready — the system can handle moderate traffic (10K+ users) but has significant risks before reaching large scale
- Enterprise-ready — the system is architected for large-scale production traffic (100K+ users) with no critical bottlenecks

**Possible Losses:** List ONLY the loss type labels relevant to the findings as a sneak-peek for the user. Pick from: Revenue Loss, User Churn, Compliance Risk. Include at most 2-3 labels. Do NOT add descriptions — the detailed breakdown goes in the <revenue_risk_assessment> section.

### Clustering Rules

1. **Cluster by shared business impact**, not by source agent. Group all findings related to "payment integrity" together even if they come from the DB, transaction, and auth agents.
2. **Interconnected findings MUST be in the same cluster**. If one finding causes or amplifies another, they belong together.
3. **INFO-level findings** should be absorbed into the cluster they relate to. If an INFO finding doesn't relate to any cluster, group remaining INFOs into a single "Informational Observations" cluster at the end.
4. **Target exactly 7-10 clusters**. Adjust granularity to hit this range.
5. **Sort clusters in decreasing severity**, influenced by the repository's primary archetypes. Within the same archetype relevance tier, rank by business impact: revenue loss > user-facing outage > performance degradation > technical debt.
6. **Severity labels**: CRITICAL (any finding in the cluster is critical), WARNING (highest finding is warning), INFO (all findings are informational).
7. **Technical details sub-sections**: Every cluster MUST include ALL four sub-tags inside <technical_details>: <root_mechanism>, <failure_modes> (with <point> items), <ignore_cost>, and <mitigations> (with <point> items). Never omit any of these four sub-sections.

### Top 3 Risk Marking Rules

The top 3 highest-impact clusters MUST include a <risk> tag with their rank (1, 2, or 3). These represent the biggest threats to growth, revenue, or system stability. All other clusters MUST NOT include the <risk> tag. The top 3 risks should always be among the first clusters listed (since clusters are sorted by severity).

### Revenue Risk Assessment Rules

Group clusters from the <clusters> section into the three risk categories: direct_revenue_loss, user_churn_risk, compliance_risk. Every cluster must appear in at least one category. No cluster may be dropped. If a cluster spans multiple categories, list it under the most impactful one and cross-reference it in the others. The <possible_losses> in bird's-eye view should be consistent with which categories have entries here.

═══════════════════════════════════════════════════════════════
SYNTHESIS RULES
═══════════════════════════════════════════════════════════════

1. **Cluster, don't list**: Your primary job is to reduce 15-25 raw findings into 7-10 meaningful risk clusters. Group by shared business impact and causal chains, not by source agent.
2. **No findings dropped**: Every raw finding ID from every sub-report MUST appear inside exactly one cluster. If a finding doesn't fit any cluster, create one or absorb it into the closest match.
3. **Translate**: Convert technical findings into business language. "N+1 query on /api/products" → "Your product listing page makes 1 database call per product instead of 1 total. At 1,000 products and 100 concurrent users, this creates 100,000 simultaneous database queries."
4. **Prioritize by Archetype & Business Impact**: Cluster severity and ordering MUST be influenced by the repository's primary archetypes. Rank clusters in decreasing order of archetype-adjusted severity.
5. **Be specific**: Don't say "performance may degrade." Say "response time will exceed 3 seconds at approximately 500 concurrent users."
6. **Don't invent findings**: Only report findings that appear in the agent digests. You may estimate thresholds from the evidence, but clearly label assumptions.
7. **Preserve traceability**: Every cluster MUST list all raw finding IDs it contains (e.g., DB-1, AUTH-2, RT-3) so the reader can trace back to the raw analysis.
8. **No preamble**: Start directly with <report>. Do not include any content before the opening <report> tag.
9. **No extra sections**: Do NOT generate any content outside the tags defined above. No markdown headings, no roadmap, no action plan, no cost estimates, no separate revenue risk section.
10. **Tag integrity**: Every opening tag MUST have a matching closing tag. Do not nest tags incorrectly or omit closing tags.`;

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
