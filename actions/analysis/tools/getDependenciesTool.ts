import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";

// Substring-match lists used in the first (cheap) pass.
// A package can appear in multiple categories (e.g. ioredis → database + cache).
const CATEGORY_PATTERNS: Record<string, string[]> = {
    database: [
        "prisma", "mongoose", "sequelize", "typeorm", "pg", "mysql2", "mysql",
        "sqlite3", "better-sqlite3", "knex", "drizzle-orm", "mongodb", "redis",
        "ioredis", "level", "nedb",
    ],
    realtime: [
        "socket.io", "ws", "sockjs", "pusher", "ably", "liveblocks",
        "supabase-realtime", "centrifuge", "actioncable",
    ],
    auth: [
        "passport", "next-auth", "jsonwebtoken", "jose", "@auth/",
        "clerk", "@clerk/", "lucia", "iron-session", "express-session",
        "bcrypt", "argon2", "crypto-js",
    ],
    payments: [
        "stripe", "@stripe/", "paypal", "braintree", "square",
        "adyen", "razorpay", "paddle",
    ],
    queues: [
        "bull", "bullmq", "bee-queue", "agenda", "kue",
        "pg-boss", "faktory", "rabbitmq",
    ],
    cache: [
        "ioredis", "redis", "lru-cache", "node-cache", "memcached",
        "keyv", "@keyv/",
    ],
    email: [
        "nodemailer", "sendgrid", "@sendgrid/", "resend", "postmark",
        "mailgun", "@mailchimp/", "ses",
    ],
    storage: [
        "@aws-sdk/", "aws-sdk", "minio", "@google-cloud/storage",
        "azure-storage", "multer", "formidable", "busboy",
        "uploadthing", "cloudinary",
    ],
    testing: [
        "jest", "vitest", "mocha", "chai", "jasmine",
        "cypress", "playwright", "@testing-library/",
        "supertest", "sinon",
    ],
    orm: [
        "prisma", "typeorm", "sequelize", "mongoose", "drizzle-orm",
        "objection", "bookshelf", "waterline",
    ],
};

export const VALID_CATEGORIES = [
    "database", "realtime", "auth", "payments", "queues",
    "cache", "email", "storage", "testing", "orm", "uncategorized",
] as const;

export type CategoryKey = typeof VALID_CATEGORIES[number];

interface PackageJson {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: unknown;
}

type CategoryBuckets = Record<CategoryKey, string[]>;

interface LLMCategorizationResult {
    categorized: Record<string, CategoryKey>;
}

// Pass 1: regex/substring — no LLM cost
function regexPass(allDeps: Record<string, string>): CategoryBuckets {
    const result = Object.fromEntries(
        VALID_CATEGORIES.map((k) => [k, [] as string[]])
    ) as CategoryBuckets;

    for (const [name, version] of Object.entries(allDeps)) {
        const entry = `${name}@${version}`;
        let categorised = false;

        for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
            if (patterns.some((p) => name.toLowerCase().includes(p.toLowerCase()))) {
                (result[category as CategoryKey] as string[]).push(entry);
                categorised = true;
            }
        }

        if (!categorised) result.uncategorized.push(entry);
    }

    return result;
}

// Pass 2: LangChain chain fallback for packages not matched by regex
const LLM_PROMPT_TEMPLATE = `You are a Node.js / npm dependency classifier.

You will receive a JSON array of npm package names.
Classify each into ONE of these categories:

  database  - ORMs, database drivers, query builders, migrations
  realtime  - WebSocket libs, SSE, live-sync, pub-sub transport
  auth      - authentication, authorization, session, crypto helpers
  payments  - payment gateways, billing, invoicing
  queues    - job queues, task schedulers, message brokers
  cache     - in-process / distributed caching
  email     - email sending / templating
  storage  - file storage, S3, cloud object stores, upload handlers
  testing   - test runners, assertions, mocking, E2E frameworks
  orm       - object-relational / object-document mappers
  uncategorized - anything that does not fit the above

Reply with ONLY valid JSON: { "categorized": { "<packageName>": "<category>", ... } }
Use the bare package name as the key (no version). JSON only, no explanation.

Packages to classify:
{packages}`;

async function llmPass(uncategorizedEntries: string[]): Promise<Record<string, CategoryKey>> {
    if (uncategorizedEntries.length === 0) return {};

    const names = uncategorizedEntries.map((e) => e.split("@")[0]);

    const prompt = PromptTemplate.fromTemplate(LLM_PROMPT_TEMPLATE);
    const chain = prompt.pipe(gpt4oMini).pipe(new JsonOutputParser<LLMCategorizationResult>());

    let parsed: LLMCategorizationResult;
    try {
        parsed = await chain.invoke({ packages: JSON.stringify(names, null, 2) });
    } catch (err) {
        console.warn("[getDependenciesTool] LLM chain failed, keeping as uncategorized:", err);
        return {};
    }

    const safe: Record<string, CategoryKey> = {};
    for (const [pkg, cat] of Object.entries(parsed.categorized ?? {})) {
        safe[pkg] = VALID_CATEGORIES.includes(cat as CategoryKey)
            ? (cat as CategoryKey)
            : "uncategorized";
    }
    return safe;
}

function applyLLMResults(categories: CategoryBuckets, llmMap: Record<string, CategoryKey>): void {
    const stillUncategorized: string[] = [];
    for (const entry of categories.uncategorized) {
        const name = entry.split("@")[0];
        const resolved = llmMap[name];
        if (resolved && resolved !== "uncategorized") {
            (categories[resolved] as string[]).push(entry);
        } else {
            stillUncategorized.push(entry);
        }
    }
    categories.uncategorized = stillUncategorized;
}

/**
 * Tool: Get Dependencies
 * Reads the already-stored packageJson from the database (no GitHub API call),
 * then runs a two-pass classifier:
 *  1. Fast regex/substring pass for known libraries.
 *  2. LLM fallback (gpt-4o-mini) for anything unrecognised in pass 1.
 *
 * Call this FIRST before exploring source code — the installed libraries
 * completely change what patterns each specialist agent should look for.
 */
export const getDependenciesTool = tool(
    async (input): Promise<string> => {
        const { repositoryId } = input as { repositoryId: string };

        try {
            // 1. Read packageJson from the database
            const repository = await prisma.repository.findUnique({
                where: { repositoryId },
                select: {
                    fullName: true,
                    packageJson: true,
                    defaultBranch: true,
                },
            });

            if (!repository) {
                return `Error: Repository with ID "${repositoryId}" not found in database. ` +
                    `Ensure framework analysis has been run before calling this tool.`;
            }

            if (!repository.packageJson) {
                return `Error: No package.json stored for repository "${repository.fullName}". ` +
                    `Ensure package.json ingestion has been run before calling this tool.`;
            }

            const packageJson = repository.packageJson as PackageJson;

            // 2. Merge all dep types
            const allDeps: Record<string, string> = {
                ...(packageJson.dependencies ?? {}),
                ...(packageJson.devDependencies ?? {}),
                ...(packageJson.peerDependencies ?? {}),
            };

            // 3. Pass 1 — regex/substring
            const categories = regexPass(allDeps);

            // 4. Pass 2 — LLM for unknowns
            if (categories.uncategorized.length > 0) {
                console.log(`[getDependenciesTool] ${categories.uncategorized.length} packages unrecognised after regex pass — calling LLM...`);
                const llmMap = await llmPass(categories.uncategorized);
                applyLLMResults(categories, llmMap);
                console.log(`[getDependenciesTool] ${categories.uncategorized.length} remain uncategorized after LLM pass.`);
            }

            // 5. Build output — categorized list only
            const lines = VALID_CATEGORIES
                .filter((k) => categories[k].length > 0)
                .map((k) => `${k}: ${categories[k].join(", ")}`);

            return lines.join("\n") || "No dependencies found.";

        } catch (error) {
            return `Error reading dependencies for repository "${repositoryId}": ${error instanceof Error ? error.message : "Unknown error occurred"
                }`;
        }
    },
    {
        name: "getDependencies",
        description: "Read and categorize the dependencies stored in the database for a repository. Uses a fast regex pass for known libraries, then an LLM (gpt-4o-mini) for anything unrecognised. Returns libraries grouped by specialist domain (database, auth, payments, realtime, queues, etc.) so each agent knows exactly which frameworks and patterns to look for. Call this FIRST before exploring any source code.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID (repositoryId field) as stored in the database"),
        }),
    }
);
