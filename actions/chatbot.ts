"use server";

import { gpt5Mini } from "@/lib/llm";
import { PromptTemplate } from "@langchain/core/prompts";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { scaleChatbotPrompt } from "../prompts/scale-chatbot";
import { createGitHubIssue } from "./github/create-issue";
import type { StoredMessage } from "./chat";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMAnswerResponse {
    mode: "answer";
    content: string;
}

export interface LLMCreateIssueResponse {
    mode: "create_issue";
    title: string;
    body: string;
    labels: string[];
    message: string;
}

export interface LLMBuildPlanResponse {
    mode: "build_plan";
    content: string;
}

export interface LLMClarifyResponse {
    mode: "clarify";
    content: string;
}

export type LLMResponse =
    | LLMAnswerResponse
    | LLMCreateIssueResponse
    | LLMBuildPlanResponse
    | LLMClarifyResponse;

export interface ChatbotResult {
    assistantMsg: StoredMessage;
    response: {
        content: string;
        mode: string;
        issueNumber?: number;
        issueUrl?: string;
        issueCreated?: boolean;
    };
}


/**
 * Format stored messages into a simple conversation history string.
 */
export async function formatConversationHistory(messages: StoredMessage[]) {
    return messages
        .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
        .join("\n");
}

/**
 * Build the StoredMessage for the user's input.
 */
export async function buildUserMessage( message: string, referencedClusters?: string[],) {
    return {
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
        ...(Array.isArray(referencedClusters) && referencedClusters.length > 0
            ? { referencedClusters }
            : {}),
    };
}

// ─── LLM Chain ────────────────────────────────────────────────────────────────

/**
 * Invoke the ScaleBot LLM chain using a LangChain RunnableSequence.
 * Pattern: PromptTemplate → LLM → StringOutputParser
 */
export async function invokeScaleChatbot(
    compiledReport: string,
    conversationHistory: string,
    userInput: string,
) {
    const prompt = PromptTemplate.fromTemplate(scaleChatbotPrompt);
    const chain = prompt.pipe(gpt5Mini).pipe(new StringOutputParser());

    const result = await chain.invoke({
        compiledReport,
        conversationHistory,
        userInput,
    });

    console.log("[chatbot] Raw LLM response:", result.substring(0, 200));
    return result;
}

/**
 * Parse the LLM's raw text output as structured JSON.
 * Handles markdown fences and leading/trailing junk.
 */
export async function parseLLMResponse(raw: string) {
    let cleaned = raw.trim();

    // Strip markdown code fences if present
    if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Extract JSON object if there's surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        cleaned = jsonMatch[0];
    }

    const parsed = JSON.parse(cleaned);

    // Validate mode
    const validModes = ["answer", "create_issue", "build_plan", "clarify"];
    if (!parsed.mode || !validModes.includes(parsed.mode)) {
        throw new Error(`Invalid mode: ${parsed.mode}`);
    }

    return parsed as LLMResponse;
}

// ─── Mode Handlers ────────────────────────────────────────────────────────────

/**
 * Handle "create_issue" mode — creates GitHub issue and builds response payloads.
 */
export async function handleCreateIssueMode(
    parsed: LLMCreateIssueResponse,
    githubInstallationId: string | null,
    owner: string,
    repo: string,
) {
    let issueResult = null;

    if (githubInstallationId) {
        issueResult = await createGitHubIssue({
            installationId: githubInstallationId,
            owner,
            repo,
            title: parsed.title,
            body: parsed.body,
            labels: parsed.labels,
        });
    }

    const issueSuccess = issueResult?.success ?? false;
    const issueMessage = issueSuccess
        ? `${parsed.message}\n\n✅ Issue #${issueResult!.issueNumber} created: [View on GitHub](${issueResult!.issueUrl})`
        : githubInstallationId
            ? `${parsed.message}\n\n❌ Failed to create issue: ${issueResult?.error ?? "Unknown error"}`
            : `${parsed.message}\n\n⚠️ GitHub App not installed — issue was not created. Here's the payload:\n\n**${parsed.title}**\n\n${parsed.body}`;

    return {
        assistantMsg: {
            role: "assistant",
            content: issueMessage,
            mode: "create_issue",
            timestamp: new Date().toISOString(),
            ...(issueResult?.issueNumber ? { issueNumber: issueResult.issueNumber } : {}),
            ...(issueResult?.issueUrl ? { issueUrl: issueResult.issueUrl } : {}),
        },
        response: {
            content: issueMessage,
            mode: "create_issue",
            issueCreated: issueSuccess,
            issueNumber: issueResult?.issueNumber ?? undefined,
            issueUrl: issueResult?.issueUrl ?? undefined,
        },
    };
}

/**
 * Handle "answer", "build_plan", or "clarify" modes — all share { mode, content }.
 */
export async function handleContentMode(
    parsed: LLMAnswerResponse | LLMBuildPlanResponse | LLMClarifyResponse,
) {
    return {
        assistantMsg: {
            role: "assistant",
            content: parsed.content,
            mode: parsed.mode,
            timestamp: new Date().toISOString(),
        },
        response: {
            content: parsed.content,
            mode: parsed.mode,
        },
    };
}

// ─── Full Pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full chatbot pipeline:
 * 1. Format conversation history
 * 2. Invoke LLM chain
 * 3. Parse response
 * 4. Handle mode (create_issue or content)
 *
 * Returns the user message, assistant message, and SSE payload.
 */
export async function runChatbotPipeline(input: {
    compiledReport: string;
    existingMessages: StoredMessage[];
    userMessage: string;
    referencedClusters?: string[];
    githubInstallationId: string | null;
    repoOwner: string;
    repoName: string;
}) {
    const {
        compiledReport,
        existingMessages,
        userMessage,
        referencedClusters,
        githubInstallationId,
        repoOwner,
        repoName,
    } = input;

    // Format history + build user input
    const conversationHistoryStr = await formatConversationHistory(existingMessages);
    const clustersNote =
        Array.isArray(referencedClusters) && referencedClusters.length > 0
            ? `\n\n**Referenced Clusters:** ${referencedClusters.join(", ")}`
            : "";
    const userInput = userMessage + clustersNote;

    // Invoke LLM
    const rawResult = await invokeScaleChatbot(
        compiledReport,
        conversationHistoryStr as any,
        userInput,
    );

    // Parse response
    let parsed: LLMResponse;
    try {
        parsed = await parseLLMResponse(rawResult);
    } catch (parseErr) {
        console.error("[chatbot] JSON parse failed, falling back to answer mode:", parseErr);
        parsed = { mode: "answer", content: rawResult };
    }

    // Build messages
    const userMsg = await buildUserMessage(userMessage, referencedClusters);
    const { assistantMsg, response } =
        parsed.mode === "create_issue"
            ? await handleCreateIssueMode(parsed, githubInstallationId, repoOwner, repoName)
            : await handleContentMode(parsed as LLMAnswerResponse | LLMBuildPlanResponse | LLMClarifyResponse);

    return { userMsg, assistantMsg, response };
}
