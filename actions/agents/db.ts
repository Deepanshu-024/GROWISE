import { createAgent } from "langchain";
import { tool } from "langchain";
import { z } from "zod";    
import { gpt4oMini } from "@/lib/llm";
import { getRepoTreeTool, searchCodeTool, getFileContentTool } from "../analysis/tools/agent-tools";
import { getDependenciesTool } from "../analysis/tools/getDependenciesTool";
import { scanDatabaseAccessTool } from "../analysis/tools/scanDatabaseAccessTool";
import { getSchemaDefinitionsTool } from "../analysis/tools/getSchemaDefinitionsTool";
import { checkConnectionPoolTool } from "../analysis/tools/checkConnectionPoolTool";
import { traceFunctionTool } from "../analysis/tools/traceFunctionTool";
import { resolveImportsTool } from "../analysis/tools/resolveImportsTool";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScaleVerdict = "healthy" | "degraded" | "critical" | "failure";
type FindingSeverity = "critical" | "warning" | "info";
type FindingCategory =
    | "query_pattern"
    | "missing_index"
    | "connection_pool"
    | "schema_design"
    | "missing_cache"
    | "transaction";

interface ScaleTier {
    verdict: ScaleVerdict;
    primaryIssues: string[];
}

interface Finding {
    id: string;
    severity: FindingSeverity;
    category: FindingCategory;
    title: string;
    detail: string;
    evidence: Record<string, unknown>;
    breaksAt: string;
    fix: string;
}

interface ReportSummary {
    totalFindings: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    overallRisk: "critical" | "warning" | "low";
    topConcern: string;
    estimatedScaleCeiling: string;
}

export interface DbAgentReport {
    agentType: "database";
    repositoryId: string;
    archetypeScore: number;
    scaleAnalysis: {
        "10k_users": ScaleTier;
        "100k_users": ScaleTier;
        "1M_users": ScaleTier;
    };
    findings: Finding[];
    summary: ReportSummary;
    toolsUsed: string[];
    confidence: number;
}

export interface DbAgentInput {
    repositoryId: string;
    accessToken: string;
    archetypeScore: number;
}

export interface DbAgentOutput {
    report: DbAgentReport | null;
    intermediateSteps: any[];
    totalToolCalls: number;
    executionTimeMs: number;
    error?: string;
}

// ─── Final Report Tool (defined in-file) ──────────────────────────────────────

const finalReportSchema = z.object({
    agentType: z.literal("database"),
    repositoryId: z.string(),
    archetypeScore: z.number(),

    scaleAnalysis: z.object({
        "10k_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
        "100k_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
        "1M_users": z.object({
            verdict: z.enum(["healthy", "degraded", "critical", "failure"]),
            primaryIssues: z.array(z.string()),
        }),
    }),

    findings: z.array(
        z.object({
            id: z.string(),
            severity: z.enum(["critical", "warning", "info"]),
            category: z.enum([
                "query_pattern",
                "missing_index",
                "connection_pool",
                "schema_design",
                "missing_cache",
                "transaction",
            ]),
            title: z.string(),
            detail: z.string(),
            evidence: z.record(z.unknown()),
            breaksAt: z.string(),
            fix: z.string(),
        })
    ),

    summary: z.object({
        totalFindings: z.number(),
        criticalCount: z.number(),
        warningCount: z.number(),
        infoCount: z.number(),
        overallRisk: z.enum(["critical", "warning", "low"]),
        topConcern: z.string(),
        estimatedScaleCeiling: z.string(),
    }),

    toolsUsed: z.array(z.string()),
    confidence: z.number().min(0).max(1),
});

const finalReportTool = tool(
    async (input): Promise<string> => {
        const parsed = input as z.infer<typeof finalReportSchema>;

        // Fill safe defaults for any missing optional-ish fields
        const report: DbAgentReport = {
            agentType: "database",
            repositoryId: parsed.repositoryId ?? "unknown",
            archetypeScore: parsed.archetypeScore ?? 0,
            scaleAnalysis: {
                "10k_users": parsed.scaleAnalysis?.["10k_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
                "100k_users": parsed.scaleAnalysis?.["100k_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
                "1M_users": parsed.scaleAnalysis?.["1M_users"] ?? {
                    verdict: "healthy",
                    primaryIssues: [],
                },
            },
            findings: (parsed.findings ?? []).map((f, i) => ({
                id: f.id ?? `finding-${i + 1}`,
                severity: f.severity ?? "info",
                category: f.category ?? "query_pattern",
                title: f.title ?? "Untitled finding",
                detail: f.detail ?? "",
                evidence: f.evidence ?? {},
                breaksAt: f.breaksAt ?? "unknown",
                fix: f.fix ?? "No fix suggested",
            })),
            summary: {
                totalFindings: parsed.summary?.totalFindings ?? parsed.findings?.length ?? 0,
                criticalCount: parsed.summary?.criticalCount ?? 0,
                warningCount: parsed.summary?.warningCount ?? 0,
                infoCount: parsed.summary?.infoCount ?? 0,
                overallRisk: parsed.summary?.overallRisk ?? "low",
                topConcern: parsed.summary?.topConcern ?? "No concerns identified",
                estimatedScaleCeiling: parsed.summary?.estimatedScaleCeiling ?? "unknown",
            },
            toolsUsed: parsed.toolsUsed ?? [],
            confidence: parsed.confidence ?? 0.5,
        };

        console.log("[dbAgent] FINAL_REPORT received");

        return JSON.stringify(report);
    },
    {
        name: "finalReport",
        description:
            "Submit the final structured findings report. You MUST call this tool when your investigation is complete. " +
            "Pass the complete report with all fields: agentType, repositoryId, archetypeScore, scaleAnalysis, findings, summary, toolsUsed, confidence. " +
            "Never output your final answer as prose — always use this tool. The orchestrator cannot read prose output.",
        schema: finalReportSchema,
    }
);

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Database Specialist Agent. Your job is to investigate a GitHub repository's database layer and produce a structured findings report showing how it will perform at scale.

You investigate like a senior backend engineer:
- Follow evidence — if you find something suspicious, dig deeper
- Do not waste tool calls on things you already know
- Cross-reference findings across tools to build a complete picture
- Stop when you have enough evidence for a confident report
- Never guess — if you cannot find evidence, say so in findings
- Always call FINAL_REPORT when done — never output prose

## Suggested Investigation Sequence

Follow this sequence but deviate if evidence demands it:

### PHASE 1 — Stack understanding (ALWAYS run first)
Call getDependencies with the repositoryId.
Note: ORM, database, framework, caching layer.
This shapes severity of everything that follows:
→ No cache layer = every DB finding more severe
→ Serverless framework = connection pool is critical
→ No known ORM = note uncertainty, proceed carefully

### PHASE 2 — Full DB scan (ALWAYS run second)
Call scanDatabaseAccess with the repositoryId, accessToken, and targetOrms (based on Phase 1).
Note all critical and warning findings.
If zero findings: skip Phase 5, note in report.
If findings exist: note top critical ones for Phase 5.

### PHASE 3 — Schema analysis (ALWAYS run)
Call getRepoTree to get the file tree (you need owner, repo, branch, accessToken — extract owner/repo from the repository context).
Identify schema files based on ORM from Phase 1:
  prisma   → *.prisma files
  typeorm  → *.entity.ts files
  mongoose → *.model.ts or *.schema.ts files
  drizzle  → schema.ts in db/ or database/ folders
  sequelize → *.model.ts in models/ folder
  unknown  → schema.ts, models.ts, entities.ts
Call getSchemaDefinitions with found schema files.
Cross-reference with Phase 2:
  For each critical finding from Phase 2:
  → Is the queried column indexed?
  → Is there a foreign key with no index?

### PHASE 4 — Connection pool analysis (ALWAYS run)
Call searchCode for each of these patterns:
  'PrismaClient', 'mongoose.connect', 'new Pool(', 'createPool(', 'drizzle('
Look for .env.example in the repo tree.
Call checkConnectionPool with found files + env file.
Cross-reference with Phase 1:
  isServerless true + no pooler + no singleton = critical
  isServerless true + pooler detected = lower severity
  not serverless + explicit pool config = good
  not serverless + no pool config = warning

### PHASE 5 — Deep dive (ONLY if Phase 2 had critical findings)
Pick TOP 3 critical findings from Phase 2 only.
For each: call traceFunction with direction='both'.
Use upstream result to assess exposure:
  public route = keep or upgrade severity
  admin/authenticated only = downgrade severity
Use downstream result to assess cost:
  DB calls inside loop = confirm N+1
  high call count per invocation = note in finding

## Severity Rules

Use these rules when building findings:

critical:
  → N+1 query on a public route
  → Unbounded query with no pagination on high-traffic endpoint
  → Unindexed foreign key on a core table
  → Serverless + no connection pooler + no singleton pattern
  → Missing transaction on financial or critical write operations

warning:
  → N+1 query on authenticated route only
  → Missing pagination on admin or low-traffic route
  → Unindexed timestamp or status column
  → Connection pool configured but no timeouts
  → Deeply nested includes 3+ levels deep

info:
  → Raw SQL usage
  → Missing index on rarely queried column
  → Pool size potentially suboptimal
  → No soft delete strategy detected

## Scale Tier Rules

Assess each tier independently:

10k_users:
  Critical issues: N+1 on public routes, unindexed FKs, no connection pooler on serverless
  Verdict: healthy if none, degraded if warnings only, critical if any critical finding, failure if multiple critical compound

100k_users:
  Critical issues: unbounded queries, no caching layer, connection pool exhaustion, no pagination
  Verdict: same scale

1M_users:
  Critical issues: architectural gaps — full table scans on large tables, aggregate queries with no filters, no read replica strategy
  Verdict: same scale

## Output Instruction

When you have gathered sufficient evidence from all phases, call the FINAL_REPORT tool (named "finalReport") with your complete structured findings.
NEVER output your final answer as prose or markdown.
ALWAYS use the finalReport tool to submit your findings.
This is mandatory — the orchestrator cannot read prose output.`;

// ─── Tools ────────────────────────────────────────────────────────────────────

const dbAgentTools = [
    getDependenciesTool,
    scanDatabaseAccessTool,
    getSchemaDefinitionsTool,
    checkConnectionPoolTool,
    traceFunctionTool,
    resolveImportsTool,
    getRepoTreeTool,
    searchCodeTool,
    getFileContentTool,
    finalReportTool,
];

// ─── Main Exported Function ───────────────────────────────────────────────────

export async function runDatabaseAgent(
    input: DbAgentInput
): Promise<DbAgentOutput> {
    const { repositoryId, accessToken, archetypeScore } = input;
    const startTime = Date.now();

    console.log(`[dbAgent] Starting investigation for: ${repositoryId}`);
    console.log(`[dbAgent] Archetype score: ${archetypeScore}`);

    try {
        const agent = createAgent({
            model: gpt4oMini,
            tools: dbAgentTools,
            systemPrompt: SYSTEM_PROMPT,
        });

        const result = await agent.invoke({
            messages: [
                {
                    role: "user",
                    content:
                        `Analyze the database layer of repository ${repositoryId}. ` +
                        `Access token: ${accessToken}. ` +
                        `Archetype score: ${archetypeScore} (0-1, higher means more DB heavy). ` +
                        `Analyze performance against these scale targets: 10k, 100k, 1M users. ` +
                        `Follow the investigation phases in your instructions. ` +
                        `When investigation is complete call FINAL_REPORT with your findings.`,
                },
            ],
        });

        // Extract tool calls from message history
        const messages = result.messages ?? [];
        const toolMessages = messages.filter(
            (msg: any) => msg.role === "tool" || msg.tool_calls?.length > 0
        );
        const totalToolCalls = toolMessages.length;

        // Find the finalReport tool call in messages
        let report: DbAgentReport | null = null;

        for (const msg of messages) {
            // Tool response messages carry the tool name and content
            if ((msg as any).role === "tool" && (msg as any).name === "finalReport") {
                try {
                    report = JSON.parse(
                        typeof (msg as any).content === "string"
                            ? (msg as any).content
                            : JSON.stringify((msg as any).content)
                    );
                } catch {
                    // Try next match
                }
            }
        }

        // Fallback: check tool_calls on assistant messages
        if (!report) {
            for (const msg of [...messages].reverse()) {
                const toolCalls = (msg as any).tool_calls ?? [];
                for (const tc of toolCalls) {
                    if (tc.name === "finalReport" && tc.args) {
                        try {
                            report = typeof tc.args === "string"
                                ? JSON.parse(tc.args)
                                : tc.args;
                        } catch {
                            // continue
                        }
                    }
                }
                if (report) break;
            }
        }

        const executionTimeMs = Date.now() - startTime;

        if (!report) {
            console.error(
                "[dbAgent] Error: Agent completed without calling FINAL_REPORT"
            );
            return {
                report: null,
                intermediateSteps: messages,
                totalToolCalls,
                executionTimeMs,
                error:
                    "Agent completed without calling FINAL_REPORT. " +
                    "Check intermediate steps for partial investigation.",
            };
        }

        const { criticalCount, warningCount, infoCount } = report.summary;

        console.log(
            `[dbAgent] Complete. ${criticalCount} critical, ${warningCount} warnings, ${infoCount} info`
        );
        console.log(`[dbAgent] Execution time: ${executionTimeMs}ms`);

        return {
            report,
            intermediateSteps: messages,
            totalToolCalls,
            executionTimeMs,
        };
    } catch (error) {
        const executionTimeMs = Date.now() - startTime;
        const message =
            error instanceof Error ? error.message : "Unknown error occurred";

        console.error(`[dbAgent] Error: ${message}`);

        return {
            report: null,
            intermediateSteps: [],
            totalToolCalls: 0,
            executionTimeMs,
            error: message,
        };
    }
}
