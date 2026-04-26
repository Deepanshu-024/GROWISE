import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// Initialize the LLM
export const gpt4oMini = new ChatOpenAI({
  modelName: "gpt-4o-mini",
  temperature: 0,
  openAIApiKey: process.env.OPENAI_API_KEY,
});

export const gpt5Mini = new ChatOpenAI({
  modelName: "gpt-5-mini-2025-08-07",
  openAIApiKey: process.env.OPENAI_API_KEY,
});

export const geminiPro = new ChatGoogleGenerativeAI({
  model: "gemini-3-pro-preview",
  maxOutputTokens: 2048,
  apiKey: process.env.GEMINI_API_KEY,
});