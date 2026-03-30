import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";

// ─── Types ────────────────────────────────────────────────────────────────────

type DepType = "runtime" | "dev" | "peer";

interface PackageJson {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    [key: string]: unknown;
}

export interface CategorizedPackage {
    name: string;
    version: string;
    type: string;       // e.g. "orm", "driver", "provider", "sdk", "runner", "unknown"
    depType: DepType;   // "runtime" | "dev" | "peer"
}

export interface DependenciesOutput {
    capabilities: Record<string, CategorizedPackage[]>;
    totalDeps: number;
    categorizedCount: number;
    uncategorizedCount: number;
}

// ─── Category Patterns (extensible config) ────────────────────────────────────

interface CategoryPatternEntry {
    /** Substring patterns to match against lowercased package name */
    patterns: string[];
    /** Default type tag for packages matched by this category */
    type: string;
}

const CATEGORY_PATTERNS: Record<string, CategoryPatternEntry> = {
    database: {
        patterns: [
            "prisma", "mongoose", "sequelize", "typeorm", "pg", "mysql2", "mysql",
            "sqlite3", "better-sqlite3", "knex", "drizzle-orm", "mongodb", "redis",
            "ioredis", "level", "nedb",
        ],
        type: "driver",
    },
    realtime: {
        patterns: [
            "socket.io", "ws", "sockjs", "pusher", "ably", "liveblocks",
            "supabase-realtime", "centrifuge", "actioncable",
        ],
        type: "sdk",
    },
    auth: {
        patterns: [
            "passport", "next-auth", "jsonwebtoken", "jose", "@auth/",
            "clerk", "@clerk/", "lucia", "iron-session", "express-session",
            "bcrypt", "argon2", "crypto-js",
        ],
        type: "provider",
    },
    payments: {
        patterns: [
            "stripe", "@stripe/", "paypal", "braintree", "square",
            "adyen", "razorpay", "paddle",
        ],
        type: "sdk",
    },
    queues: {
        patterns: [
            "bull", "bullmq", "bee-queue", "agenda", "kue",
            "pg-boss", "faktory", "rabbitmq",
        ],
        type: "sdk",
    },
    cache: {
        patterns: [
            "ioredis", "redis", "lru-cache", "node-cache", "memcached",
            "keyv", "@keyv/",
        ],
        type: "sdk",
    },
    email: {
        patterns: [
            "nodemailer", "sendgrid", "@sendgrid/", "resend", "postmark",
            "mailgun", "@mailchimp/", "ses",
        ],
        type: "sdk",
    },
    storage: {
        patterns: [
            "@aws-sdk/", "aws-sdk", "minio", "@google-cloud/storage",
            "azure-storage", "multer", "formidable", "busboy",
            "uploadthing", "cloudinary",
        ],
        type: "sdk",
    },
    testing: {
        patterns: [
            "jest", "vitest", "mocha", "chai", "jasmine",
            "cypress", "playwright", "@testing-library/",
            "supertest", "sinon",
        ],
        type: "runner",
    },
    orm: {
        patterns: [
            "prisma", "typeorm", "sequelize", "mongoose", "drizzle-orm",
            "objection", "bookshelf", "waterline",
        ],
        type: "orm",
    },
};

export const VALID_CATEGORIES = [
    "database", "realtime", "auth", "payments", "queues",
    "cache", "email", "storage", "testing", "orm", "uncategorized",
] as const;

export type CategoryKey = typeof VALID_CATEGORIES[number];

// ─── Scoped Package Parser ────────────────────────────────────────────────────
// Handles both regular (`prisma@6.10.1`) and scoped (`@clerk/nextjs@^6.0.0`)
// packages. Uses lastIndexOf("@") to find the version separator, which is
// always the LAST "@" (scoped packages start with "@" but the version
// separator is also "@").

function parsePackageEntry(entry: string): { name: string; version: string } {
    const lastAt = entry.lastIndexOf("@");

    // If "@" is at position 0, there's no version — the whole thing is a name
    // If no "@" found (-1), also treat entire string as the name
    if (lastAt <= 0) {
        return { name: entry, version: "unknown" };
    }

    return {
        name: entry.slice(0, lastAt),
        version: entry.slice(lastAt + 1),
    };
}

// ─── Dependency Merger with Type Tagging ──────────────────────────────────────

interface TaggedDep {
    name: string;
    version: string;
    depType: DepType;
}

function mergeAndTagDeps(packageJson: PackageJson): TaggedDep[] {
    const result: TaggedDep[] = [];
    const seen = new Set<string>();

    const addDeps = (deps: Record<string, string> | undefined, depType: DepType) => {
        if (!deps) return;
        for (const [name, version] of Object.entries(deps)) {
            // Guard: skip empty or whitespace-only names
            if (!name || !name.trim()) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            result.push({ name, version, depType });
        }
    };

    // runtime takes priority (added first → seen prevents dev/peer dupes)
    addDeps(packageJson.dependencies, "runtime");
    addDeps(packageJson.devDependencies, "dev");
    addDeps(packageJson.peerDependencies, "peer");

    return result;
}

// ─── Pass 1: Regex/Substring (no LLM cost) ───────────────────────────────────

type CategoryBuckets = Record<CategoryKey, CategorizedPackage[]>;

function regexPass(deps: TaggedDep[]): CategoryBuckets {
    const result = Object.fromEntries(
        VALID_CATEGORIES.map((k) => [k, [] as CategorizedPackage[]])
    ) as CategoryBuckets;

    for (const dep of deps) {
        const lowerName = dep.name.toLowerCase();
        let categorised = false;

        for (const [category, config] of Object.entries(CATEGORY_PATTERNS)) {
            if (config.patterns.some((p) => lowerName.includes(p.toLowerCase()))) {
                result[category as CategoryKey].push({
                    name: dep.name,
                    version: dep.version,
                    type: config.type,
                    depType: dep.depType,
                });
                categorised = true;
            }
        }

        if (!categorised) {
            result.uncategorized.push({
                name: dep.name,
                version: dep.version,
                type: "unknown",
                depType: dep.depType,
            });
        }
    }

    return result;
}

// ─── Pass 2: LLM Fallback for Uncategorized ──────────────────────────────────

interface LLMCategorizationResult {
    categorized: Record<string, CategoryKey>;
}

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

Reply with ONLY valid JSON: {{ "categorized": {{ "<packageName>": "<category>", ... }} }}
Use the bare package name as the key (no version). JSON only, no explanation.

Packages to classify:
{packages}`;

async function llmPass(uncategorizedPackages: CategorizedPackage[]): Promise<Record<string, CategoryKey>> {
    if (uncategorizedPackages.length === 0) return {};

    // Extract just the names — scoped packages are already correct here
    const names = uncategorizedPackages.map((p) => p.name).filter(Boolean);
    if (names.length === 0) return {};

    const prompt = PromptTemplate.fromTemplate(LLM_PROMPT_TEMPLATE);
    const chain = prompt.pipe(gpt4oMini).pipe(new JsonOutputParser<LLMCategorizationResult>());

    let parsed: LLMCategorizationResult;
    try {
        parsed = await chain.invoke({ packages: JSON.stringify(names, null, 2) });
    } catch (err) {
        console.warn("[getDependenciesTool] LLM chain failed, keeping as uncategorized:", err);
        return {};
    }

    // Strict validation: ensure parsed has the expected shape
    if (!parsed || typeof parsed !== "object" || !parsed.categorized || typeof parsed.categorized !== "object") {
        console.warn("[getDependenciesTool] LLM returned invalid shape, keeping as uncategorized");
        return {};
    }

    const safe: Record<string, CategoryKey> = {};
    for (const [pkg, cat] of Object.entries(parsed.categorized)) {
        if (typeof pkg !== "string" || !pkg.trim()) continue;
        if (typeof cat !== "string") continue;

        safe[pkg] = VALID_CATEGORIES.includes(cat as CategoryKey)
            ? (cat as CategoryKey)
            : "uncategorized";
    }
    return safe;
}

// ─── Apply LLM Results Back into Buckets ──────────────────────────────────────

function applyLLMResults(categories: CategoryBuckets, llmMap: Record<string, CategoryKey>): void {
    const stillUncategorized: CategorizedPackage[] = [];

    for (const pkg of categories.uncategorized) {
        const resolved = llmMap[pkg.name];
        if (resolved && resolved !== "uncategorized") {
            const targetType = CATEGORY_PATTERNS[resolved]?.type ?? "unknown";
            categories[resolved].push({
                ...pkg,
                type: targetType,
            });
        } else {
            stillUncategorized.push(pkg);
        }
    }

    categories.uncategorized = stillUncategorized;
}

// ─── Build Structured Output ──────────────────────────────────────────────────

function buildOutput(categories: CategoryBuckets, totalDeps: number): DependenciesOutput {
    const capabilities: Record<string, CategorizedPackage[]> = {};

    for (const category of VALID_CATEGORIES) {
        if (categories[category].length > 0) {
            capabilities[category] = categories[category];
        }
    }

    const uncategorizedCount = categories.uncategorized.length;
    const categorizedCount = totalDeps - uncategorizedCount;

    return {
        capabilities,
        totalDeps,
        categorizedCount,
        uncategorizedCount,
    };
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Get Dependencies
 * Reads the already-stored packageJson from the database (no GitHub API call),
 * then runs a two-pass classifier:
 *  1. Fast regex/substring pass for known libraries.
 *  2. LLM fallback (gpt-4o-mini) for anything unrecognised in pass 1.
 *
 * Returns structured JSON with capabilities grouped by category, each package
 * tagged with its type (orm, driver, sdk, etc.) and dependency source
 * (runtime, dev, peer).
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

            // 2. Merge all dep types with source tagging
            const taggedDeps = mergeAndTagDeps(packageJson);

            if (taggedDeps.length === 0) {
                return JSON.stringify({
                    capabilities: {},
                    totalDeps: 0,
                    categorizedCount: 0,
                    uncategorizedCount: 0,
                } satisfies DependenciesOutput);
            }

            // 3. Pass 1 — regex/substring
            const categories = regexPass(taggedDeps);

            // 4. Pass 2 — LLM for unknowns
            if (categories.uncategorized.length > 0) {
                console.log(`[getDependenciesTool] ${categories.uncategorized.length} packages unrecognised after regex pass — calling LLM...`);
                const llmMap = await llmPass(categories.uncategorized);
                applyLLMResults(categories, llmMap);
                console.log(`[getDependenciesTool] ${categories.uncategorized.length} remain uncategorized after LLM pass.`);
            }

            // 5. Build structured output
            const output = buildOutput(categories, taggedDeps.length);
            return JSON.stringify(output, null, 2);

        } catch (error) {
            return `Error reading dependencies for repository "${repositoryId}": ${error instanceof Error ? error.message : "Unknown error occurred"
                }`;
        }
    },
    {
        name: "getDependencies",
        description: "Read and categorize all dependencies for a repository from the database. Returns structured JSON with packages grouped by category: database (ORM, drivers), auth, payments, realtime, queues, storage, email, testing, and framework. Each package includes its name, version, type (orm/driver/sdk/provider), and dependency source (runtime/dev/peer). Call this FIRST — the output tells you which ORM is in use, whether a caching layer exists, which payment providers are integrated, and whether the framework is serverless. These facts shape the severity of every subsequent finding.",
        schema: z.object({
            repositoryId: z.string().describe("The GitHub repository ID (repositoryId field) as stored in the database"),
        }),
    }
);
