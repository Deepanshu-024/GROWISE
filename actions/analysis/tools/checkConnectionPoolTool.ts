import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_CONNECTION_FILES = 10;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectionSetup {
  fileFound: boolean;
  setupFile: string | null;
  clientType: string | null;
}

interface PoolConfiguration {
  isExplicitlyConfigured: boolean;
  maxConnections: number | null;
  minConnections: number | null;
  connectionTimeoutMs: number | null;
  idleTimeoutMs: number | null;
  acquireTimeoutMs: number | null;
}

interface DatabaseUrl {
  found: boolean;
  hasConnectionLimit: boolean;
  hasPgBouncerMode: boolean;
  hasPoolTimeout: boolean;
  hasSSLMode: boolean;
  format: string | null;
}

interface PoolerConfiguration {
  externalPoolerDetected: boolean;
  poolerType: string | null;
  poolerHandlesConnections: boolean;
}

interface ServerlessPatterns {
  usesGlobalSingleton: boolean;
  createsNewConnectionPerRequest: boolean;
  hasWarmStartOptimization: boolean;
}

interface LLMPoolResult {
  connectionSetup: ConnectionSetup;
  poolConfiguration: PoolConfiguration;
  databaseUrl: DatabaseUrl;
  poolerConfiguration: PoolerConfiguration;
  serverlessPatterns: ServerlessPatterns;
}

interface ConnectionPoolResult {
  repository: string;
  detectedOrm: string;
  detectedFramework: string;
  isServerless: boolean;
  detectedPooler: string | null;
  skippedFiles: string[];
  connectionSetup: ConnectionSetup;
  poolConfiguration: PoolConfiguration;
  databaseUrl: DatabaseUrl;
  poolerConfiguration: PoolerConfiguration;
  serverlessPatterns: ServerlessPatterns;
}

// ─── In-memory file cache ─────────────────────────────────────────────────────

type FileCache = Map<string, string>;

// ─── GitHub file fetch helper (same pattern as scanDatabaseAccessTool) ────────

async function fetchFileContent(
  owner: string,
  repo: string,
  filePath: string,
  branch: string,
  accessToken: string,
  cache: FileCache
): Promise<string | null> {
  const cacheKey = `${owner}/${repo}/${branch}/${filePath}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const url =
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}` +
    `?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3.raw",
      "User-Agent": "DevilDev-Agent",
    },
  });

  if (!response.ok) return null;

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) return null;

  const content = await response.text();
  if (content.length > MAX_FILE_SIZE) return null;

  cache.set(cacheKey, content);
  return content;
}


// ─── LLM pool extraction chain ────────────────────────────────────────────────

const POOL_EXTRACTION_PROMPT = `You are analyzing database connection configuration.
This repository uses {detectedOrm} with {detectedFramework}.
Serverless environment: {isServerless}.
External pooler detected in dependencies: {detectedPooler}.

Extract ONLY raw configuration facts from these files.
Do NOT make recommendations.
Do NOT judge whether the configuration is good or bad.
Do NOT infer values that are not explicitly set — use null.
If a value comes from an environment variable with no default, set the field to null.

Extract the following fields:

connectionSetup:
  fileFound: boolean — was a DB connection setup found?
  setupFile: string | null — which file has the connection setup?
  clientType: string | null — exact client used (e.g. "pg.Pool", "mongoose", "PrismaClient", "drizzle", "mysql2.createPool", "knex")

poolConfiguration:
  isExplicitlyConfigured: boolean — true ONLY if pool settings are explicitly set in code, false if using library defaults
  maxConnections: number | null — the max/poolSize value if explicitly set, null if not set
  minConnections: number | null — the min connections if set, null if not set
  connectionTimeoutMs: number | null — connectionTimeoutMillis or connectTimeout if set, null if not
  idleTimeoutMs: number | null — idleTimeoutMillis or similar if set, null if not
  acquireTimeoutMs: number | null — acquire timeout if set, null if not

databaseUrl:
  found: boolean — was DATABASE_URL or similar found?
  hasConnectionLimit: boolean — true if URL contains connection_limit= parameter
  hasPgBouncerMode: boolean — true if URL contains pgbouncer=true
  hasPoolTimeout: boolean — true if URL contains pool_timeout= parameter
  hasSSLMode: boolean — true if URL contains sslmode= parameter
  format: string | null — the URL format pattern with credentials redacted (e.g. "postgresql://***:***@host/db?connection_limit=10")

poolerConfiguration:
  externalPoolerDetected: boolean — true if @prisma/accelerate URL, @vercel/postgres, @neondatabase/serverless, or pgbouncer detected
  poolerType: string | null — "prisma-accelerate" | "vercel-postgres" | "neon-serverless" | "pgbouncer" | null
  poolerHandlesConnections: boolean — true if the detected pooler manages connections externally

serverlessPatterns:
  usesGlobalSingleton: boolean — true if connection is cached in a global variable to survive function warm starts (e.g. "global.prisma" or "globalThis.db" pattern)
  createsNewConnectionPerRequest: boolean — true if connection setup is inside a request handler or inside an exported function with no global caching
  hasWarmStartOptimization: boolean — true if code checks for existing connection before creating a new one

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "connectionSetup": {{
    "fileFound": boolean,
    "setupFile": "string or null",
    "clientType": "string or null"
  }},
  "poolConfiguration": {{
    "isExplicitlyConfigured": boolean,
    "maxConnections": number_or_null,
    "minConnections": number_or_null,
    "connectionTimeoutMs": number_or_null,
    "idleTimeoutMs": number_or_null,
    "acquireTimeoutMs": number_or_null
  }},
  "databaseUrl": {{
    "found": boolean,
    "hasConnectionLimit": boolean,
    "hasPgBouncerMode": boolean,
    "hasPoolTimeout": boolean,
    "hasSSLMode": boolean,
    "format": "string or null"
  }},
  "poolerConfiguration": {{
    "externalPoolerDetected": boolean,
    "poolerType": "string or null",
    "poolerHandlesConnections": boolean
  }},
  "serverlessPatterns": {{
    "usesGlobalSingleton": boolean,
    "createsNewConnectionPerRequest": boolean,
    "hasWarmStartOptimization": boolean
  }}
}}

Files to analyze:
{fileContents}`;

const poolExtractionChain = PromptTemplate.fromTemplate(POOL_EXTRACTION_PROMPT)
  .pipe(gpt4oMini)
  .pipe(new JsonOutputParser<LLMPoolResult>());

async function extractPoolConfiguration(
  detectedOrm: string,
  detectedFramework: string,
  isServerless: boolean,
  detectedPooler: string | null,
  fileContents: string
): Promise<LLMPoolResult | null> {
  const vars = {
    detectedOrm,
    detectedFramework,
    isServerless: String(isServerless),
    detectedPooler: detectedPooler ?? "none",
    fileContents,
  };
  try {
    return await poolExtractionChain.invoke(vars);
  } catch {
    try {
      return await poolExtractionChain.invoke(vars);
    } catch {
      return null;
    }
  }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Check Connection Pool
 * Receives connection file paths from the agent, fetches them from GitHub,
 * and uses an LLM to extract raw connection pool configuration facts.
 * Returns pure facts — no severity, no warnings, no recommendations.
 * The agent handles file discovery and cross-references this output
 * with other tool outputs to draw its own conclusions.
 */
export const checkConnectionPoolTool = tool(
  async (input): Promise<string> => {
    const {
      repositoryId,
      accessToken,
      connectionFiles,
      envFile,
      detectedOrm,
      detectedFramework,
      isServerless,
      detectedPooler,
    } = input as {
      repositoryId: string;
      accessToken: string;
      connectionFiles: string[];
      envFile: string | null;
      detectedOrm: string;
      detectedFramework: string;
      isServerless: boolean;
      detectedPooler: string | null;
    };

    console.log(`[checkConnectionPool] ORM: ${detectedOrm}`);
    console.log(`[checkConnectionPool] Framework: ${detectedFramework}`);
    console.log(`[checkConnectionPool] Serverless: ${isServerless}`);
    console.log(`[checkConnectionPool] Pooler detected: ${detectedPooler ?? "none"}`);

    if (!connectionFiles || connectionFiles.length === 0) {
      return `Error: No connection files provided. Agent must identify connection setup files via searchCodeTool before calling this tool.`;
    }

    try {
      // 1. Read repository metadata from DB
      const repository = await prisma.repository.findUnique({
        where: { repositoryId },
        select: { fullName: true, defaultBranch: true },
      });

      if (!repository) {
        return `Error: Repository with ID "${repositoryId}" not found in database. ` +
          `Ensure framework analysis has been run before calling this tool.`;
      }

      const [owner, repo] = repository.fullName.split("/");
      const branch = repository.defaultBranch ?? "main";
      const cache: FileCache = new Map();
      const skippedFiles: string[] = [];

      // Cap at 10 files
      const filesToProcess = connectionFiles.slice(0, MAX_CONNECTION_FILES);

      console.log(`[checkConnectionPool] Fetching ${filesToProcess.length} connection files`);
      console.log(`[checkConnectionPool] Fetching env file: ${envFile ?? "none provided"}`);

      // 2. Fetch connection files
      const fetchedFileSections: string[] = [];

      for (const filePath of filesToProcess) {
        const fileContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
        if (!fileContent) {
          skippedFiles.push(filePath);
          continue;
        }
        fetchedFileSections.push(`=== FILE: ${filePath} ===\n${fileContent}`);
      }

      // Fetch env file if provided
      let envContent: string | null = null;
      if (envFile) {
        envContent = await fetchFileContent(owner, repo, envFile, branch, accessToken, cache);
        if (envContent) {
          fetchedFileSections.push(`=== FILE: ${envFile} ===\n${envContent}`);
        }
      }

      if (fetchedFileSections.length === 0) {
        return `Error: All connection files failed to fetch for repository "${repositoryId}". ` +
          `Skipped files: ${skippedFiles.join(", ")}`;
      }

      const fileContents = fetchedFileSections.join("\n\n");

      // 3. Single LLM call for all files combined
      console.log(`[checkConnectionPool] Running LLM extraction`);

      const llmResult = await extractPoolConfiguration(
        detectedOrm,
        detectedFramework,
        isServerless,
        detectedPooler,
        fileContents
      );

      if (!llmResult) {
        return `Error: LLM extraction failed for repository "${repositoryId}". ` +
          `Unable to parse connection pool configuration from the provided files.`;
      }

      console.log(`[checkConnectionPool] Complete`);

      const result: ConnectionPoolResult = {
        repository: repository.fullName,
        detectedOrm,
        detectedFramework,
        isServerless,
        detectedPooler,
        skippedFiles,
        connectionSetup: llmResult.connectionSetup,
        poolConfiguration: llmResult.poolConfiguration,
        databaseUrl: llmResult.databaseUrl,
        poolerConfiguration: llmResult.poolerConfiguration,
        serverlessPatterns: llmResult.serverlessPatterns,
      };

      return JSON.stringify(result, null, 2);

    } catch (error) {
      return `Error checking connection pool for repository "${repositoryId}": ${
        error instanceof Error ? error.message : "Unknown error occurred"
      }`;
    }
  },
  {
    name: "checkConnectionPool",
    description: "Fetch connection setup files identified by the agent from GitHub and extract raw database connection pool configuration facts. Accepts ORM, framework, serverless, and pooler info directly from the agent — these come from getDependenciesTool output, no internal package detection needed. Analyzes connection client type, explicit pool settings (max/min connections, timeouts), DATABASE_URL parameters, external pooler detection (Prisma Accelerate, Vercel Postgres, Neon, PgBouncer), and serverless singleton patterns. Returns raw facts only — no severity judgments, no recommendations. The agent cross-references this output with other tool outputs to draw its own conclusions.",
    schema: z.object({
      repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
      accessToken: z.string().describe("GitHub access token for fetching files via the API"),
      connectionFiles: z.array(z.string()).describe("File paths the agent has identified as connection setup files via searchCodeTool (e.g. ['src/lib/db.ts', 'src/config/database.ts'])"),
      envFile: z.string().nullable().describe("Path to .env.example or .env.local if the agent found one (e.g. '.env.example'). Pass null if not found."),
      detectedOrm: z.string().describe("ORM in use — passed by agent from getDependenciesTool output (e.g. 'prisma' | 'mongoose' | 'typeorm' | 'drizzle' | 'unknown')"),
      detectedFramework: z.string().describe("Framework in use — passed by agent from getDependenciesTool output (e.g. 'next' | 'express' | 'fastify' | 'unknown')"),
      isServerless: z.boolean().describe("Whether the app runs in a serverless environment — agent determines this from getDependenciesTool output. true for: next, nuxt, remix, astro, vercel, aws-lambda, netlify. false for: express, fastify, nestjs, hono, koa"),
      detectedPooler: z.string().nullable().describe("External connection pooler if detected by agent from getDependenciesTool output (e.g. 'prisma-accelerate' | 'vercel-postgres' | 'neon-serverless' | 'pgbouncer' | null)"),
    }),
  }
);
