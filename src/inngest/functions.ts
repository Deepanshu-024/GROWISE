import { inngest } from "./client";
import { classifyBusinessContext } from "../../actions/analysis/business-classification";
import {
  resolveOrchestrationContext,
  runSingleAgent,
  AgentSummary,
} from "../../actions/agents/orchestrator";
import { runReportCompiler } from "../../actions/agents/report-compiler";
import prisma from "@/lib/prisma";

export const analyzeRepositoryWorkflow = inngest.createFunction(
  {
    id: "analyze-repository-workflow",
    name: "Analyze Repository Workflow",
    onFailure: async ({ event, error, step }) => {
      const originalEvent = event.data.event;
      const { repositoryId, clerkId } = originalEvent.data;

      console.error(`[Inngest Background Job] ❌ Background analysis failed for repository ${repositoryId}:`, error);

      await step.run("revert-compiling-state-on-failure", async () => {
        const user = await prisma.user.findUnique({
          where: { clerkId },
          select: { id: true },
        });

        if (user) {
          await prisma.repository.update({
            where: {
              userId_repositoryId: {
                userId: user.id,
                repositoryId: repositoryId,
              }
            },
            data: {
              compiledReport: null,
              compiledReportAt: null,
            },
          });
        }
      });
    },
  },
  { event: "workflow/trigger" },
  async ({ event, step }) => {
    const { repositoryId, clerkId } = event.data;

    console.log(`[Inngest Background Job] 🚀 Starting background analysis for repository ${repositoryId} (User Clerk ID: ${clerkId})`);

    // Step 1: Run business classification
    await step.run("classify-business-context", async () => {
      console.log(`[Inngest Background Job] 🏢 Running business classification...`);
      const classificationResult = await classifyBusinessContext(repositoryId, undefined, clerkId);
      if (classificationResult.error) {
        console.error(`[Inngest Background Job] ❌ Classification failed:`, classificationResult.error);
        throw new Error(classificationResult.error);
      }
      console.log(`[Inngest Background Job] ✅ Classification complete`);
      return classificationResult;
    });

    // Step 2: Resolve context & prep Database pending rows
    const context = await step.run("resolve-orchestration-context", async () => {
      console.log(`[Inngest Background Job] 🔍 Resolving orchestration context...`);
      const ctx = await resolveOrchestrationContext(repositoryId, clerkId);

      // Reset/upsert pending rows so UI updates instantly to show pending status
      for (const arch of ctx.archetypes) {
        await prisma.agentReport.upsert({
          where: {
            repositoryId_archetype: {
              repositoryId: ctx.repoDbId,
              archetype: arch.name,
            },
          },
          create: {
            repositoryId: ctx.repoDbId,
            archetype: arch.name,
            status: "pending",
          },
          update: {
            status: "pending",
            rawFindings: null,
            totalToolCalls: 0,
            executionTimeMs: 0,
            error: null,
          },
        });
      }

      return ctx;
    });

    const summaries: AgentSummary[] = [];

    // Step 3: Run each specialized agent in its own step
    for (const arch of context.archetypes) {
      const summary = await step.run(`agent-${arch.name}`, async () => {
        console.log(`[Inngest Background Job] 🤖 Running agent for archetype "${arch.name}"...`);
        return await runSingleAgent(
          context.repoDbId,
          context.userId,
          context.installationId,
          arch.name,
          arch.score,
        );
      });
      summaries.push(summary);
    }

    // Step 4: Compile report if there is at least one completed agent
    const completed = summaries.filter((s) => s.status === "completed").length;
    if (completed > 0) {
      await step.run("compile-report", async () => {
        console.log(`[Inngest Background Job] 📝 Compiling report...`);
        const compilerResult = await runReportCompiler({
          repositoryId: context.repoDbId,
          userId: context.userId,
        });
        if (compilerResult.error) {
          throw new Error(compilerResult.error);
        }
        return compilerResult;
      });
    }

    console.log(`[Inngest Background Job] 🎉 Background analysis successfully completed for ${repositoryId}`);
  }
);
