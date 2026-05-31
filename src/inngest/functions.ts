import { inngest } from "./client";
import { classifyBusinessContext } from "../../actions/analysis/business-classification";
import { orchestrateAgents } from "../../actions/agents/orchestrator";

export const analyzeRepositoryWorkflow = inngest.createFunction(
  { id: "analyze-repository-workflow", name: "Analyze Repository Workflow" },
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

    // Step 2: Run agent orchestration + compilation
    await step.run("orchestrate-agents", async () => {
      console.log(`[Inngest Background Job] 🤖 Running agent orchestration...`);
      const orchestrationResult = await orchestrateAgents(repositoryId, clerkId);
      console.log(`[Inngest Background Job] ✅ Agent orchestration complete`);
      return orchestrationResult;
    });

    console.log(`[Inngest Background Job] 🎉 Background analysis successfully completed for ${repositoryId}`);
  }
);
