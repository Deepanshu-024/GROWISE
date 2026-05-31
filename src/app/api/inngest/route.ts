import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { analyzeRepositoryWorkflow } from "@/inngest/functions";

// Create an API that serves registered functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    analyzeRepositoryWorkflow,
  ],
});