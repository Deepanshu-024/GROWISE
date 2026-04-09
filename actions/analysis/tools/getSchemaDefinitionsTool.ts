import { z } from "zod";
import { tool } from "langchain";
import { PromptTemplate } from "@langchain/core/prompts";
import { JsonOutputParser } from "@langchain/core/output_parsers";
import { gpt4oMini } from "@/lib/llm";
import prisma from "@/lib/prisma";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_SCHEMA_FILES = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

type RelationType = "one-to-one" | "one-to-many" | "many-to-many" | "many-to-one";

interface ColumnDefinition {
  name: string;
  type: string;
  isPrimary: boolean;
  isRequired: boolean;
  isUnique: boolean;
  isIndexed: boolean;
  isForeignKey: boolean;
  referencesTable: string | null;
}

interface IndexDefinition {
  columns: string[];
  isComposite: boolean;
  isUnique: boolean;
}

interface RelationDefinition {
  field: string;
  referencesTable: string;
  relationType: RelationType;
}

interface TableDefinition {
  name: string;
  sourceFile: string;
  columns: ColumnDefinition[];
  indexes: IndexDefinition[];
  relations: RelationDefinition[];
  // missingIndexWarnings removed — agent handles analysis
}

interface LLMSchemaResult {
  tables: TableDefinition[];
}

interface SchemaResult {
  repository: string;
  ormDetected: string;
  databaseDetected: string;
  schemaFiles: string[];
  skippedFiles: string[];
  summary: {
    totalTables: number;
    totalColumns: number;
    totalIndexes: number;
    totalRelations: number;
  };
  tables: TableDefinition[];
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

// ─── ORM-specific extraction hints ───────────────────────────────────────────

const ORM_HINTS: Record<string, string> = {
  prisma: `Pay attention to: @@index([]) for composite indexes, @unique for unique constraints, @relation for foreign keys, @id for primary keys, @default for default values.`,
  typeorm: `Pay attention to: @Entity() for table classes, @Column() for fields, @Index() for indexes, @PrimaryGeneratedColumn() for primary keys, @ManyToOne/@OneToMany/@ManyToMany for relations, @JoinColumn() for foreign key columns.`,
  mongoose: `Pay attention to: new Schema({}) for model definitions, index: true on field definitions for indexes, schema.index({}) calls for compound indexes, ref: for population/relations between collections, required: true for required fields.`,
  drizzle: `Pay attention to: pgTable/mysqlTable/sqliteTable for table definitions, .primaryKey() for primary keys, index() for indexes, references() for foreign keys, notNull() for required fields.`,
  sequelize: `Pay attention to: define() or Model.init() for model definitions, DataTypes for column types, indexes array for index definitions, references for foreign keys, allowNull for nullable fields.`,
  mikroorm: `Pay attention to: @Entity() for table classes, @Property() for fields, @Index() for indexes, @PrimaryKey() for primary keys, @ManyToOne/@OneToMany for relations.`,
  knex: `Pay attention to: createTable() for table definitions, table.increments() for primary keys, table.index() for indexes, table.foreign() for foreign keys, table.notNullable() for required fields.`,
  unknown: `Extract any database schema definitions you find regardless of the ORM or format used.`,
};

function getOrmHint(detectedOrm: string): string {
  return ORM_HINTS[detectedOrm.toLowerCase()] ?? ORM_HINTS.unknown;
}

// ─── LLM schema extraction chain ─────────────────────────────────────────────

const SCHEMA_EXTRACTION_PROMPT = `You are a database schema analyst.

This repository uses {detectedOrm} ORM with {detectedDatabase}.
Here is a schema definition file from this repository. Extract ALL table/model/collection definitions you find.

ORM-specific guidance:
{ormHint}

For each table/model/collection, extract:
- name: the table or model name
- sourceFile: exactly "{filePath}"
- columns: array of all fields/columns with:
    name: field name
    type: field type as written in the schema
    isPrimary: is this the primary key? (boolean)
    isRequired: is this required / not nullable? (boolean)
    isUnique: does this have a unique constraint? (boolean)
    isIndexed: does this field have any index?
               Set isIndexed: true if the column has ANY of these:
               - Is the primary key (@id, @PrimaryGeneratedColumn, primaryKey())
               - Has @unique or unique: true
               - Has an explicit @index decorator
               - Is included in a @@index([]) or composite index definition
               Set isIndexed: false only if NONE of the above apply.
    isForeignKey: is this a relation/reference to another table? (boolean)
    referencesTable: which table does it reference, or null
- indexes: array of ALL explicitly defined indexes with:
    columns: which columns are in this index (array of strings)
    isComposite: is this a multi-column index? (boolean)
    isUnique: is this a unique index? (boolean)
- relations: array of all relations/foreign keys with:
    field: the field name
    referencesTable: the referenced table name
    relationType: "one-to-one" | "one-to-many" | "many-to-many" | "many-to-one"

Return ONLY valid JSON, no markdown, no backticks, no explanation:
{{
  "tables": [
    {{
      "name": "string",
      "sourceFile": "string",
      "columns": [ {{ "name": "string", "type": "string", "isPrimary": boolean, "isRequired": boolean, "isUnique": boolean, "isIndexed": boolean, "isForeignKey": boolean, "referencesTable": "string or null" }} ],
      "indexes": [ {{ "columns": ["string"], "isComposite": boolean, "isUnique": boolean }} ],
      "relations": [ {{ "field": "string", "referencesTable": "string", "relationType": "string" }} ]
    }}
  ]
}}

If no schema definitions are found, return {{ "tables": [] }}.

File path: {filePath}

Schema file content:
{fileContent}`;

const schemaExtractionChain = PromptTemplate.fromTemplate(SCHEMA_EXTRACTION_PROMPT)
  .pipe(gpt4oMini)
  .pipe(new JsonOutputParser<LLMSchemaResult>());

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // OpenAI / LangChain surface rate limits as status 429 or in the message
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
  }
  return false;
}

async function extractSchemaFromFile(
  filePath: string,
  fileContent: string,
  detectedOrm: string,
  detectedDatabase: string
): Promise<LLMSchemaResult | null> {
  const vars = {
    filePath,
    fileContent,
    detectedOrm,
    detectedDatabase,
    ormHint: getOrmHint(detectedOrm),
  };

  try {
    return await schemaExtractionChain.invoke(vars);
  } catch (err) {
    if (!isRateLimitError(err)) {
      console.warn(`[getSchemaDefinitions] Non-retryable error for "${filePath}":`, err);
      return null;
    }

    // Rate limit — wait 5 s then retry once
    console.warn(`[getSchemaDefinitions] Rate limit hit for "${filePath}", retrying in 5 s…`);
    await new Promise((res) => setTimeout(res, 5_000));

    try {
      return await schemaExtractionChain.invoke(vars);
    } catch (retryErr) {
      console.warn(`[getSchemaDefinitions] Retry also failed for "${filePath}":`, retryErr);
      return null;
    }
  }
}

// ─── Tool Definition ──────────────────────────────────────────────────────────

/**
 * Tool: Get Schema Definitions
 * Receives schema file paths from the agent, fetches them from GitHub,
 * and uses an LLM to extract raw table/model definitions.
 * Returns pure facts — no severity, no warnings, no scale analysis.
 * The agent handles file discovery and cross-references this output
 * with query pattern findings to draw its own conclusions.
 */
export const getSchemaDefinitionsTool = tool(
  async (input): Promise<string> => {
    const { repositoryId, accessToken, schemaFiles, detectedOrm, detectedDatabase } = input as {
      repositoryId: string;
      accessToken: string;
      schemaFiles: string[];
      detectedOrm: string;
      detectedDatabase: string;
    };

    if (!schemaFiles || schemaFiles.length === 0) {
      return `Error: No schema files provided. The agent must identify and pass schema file paths before calling this tool.`;
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
      const allTables: TableDefinition[] = [];

      // Cap at 20 files
      const filesToProcess = schemaFiles.slice(0, MAX_SCHEMA_FILES);

      console.log(`[getSchemaDefinitions] Fetching ${filesToProcess.length} schema files`);
      console.log(`[getSchemaDefinitions] ORM: ${detectedOrm}, Database: ${detectedDatabase}`);

      // 2. Fetch + LLM extraction per file
      for (const filePath of filesToProcess) {
        console.log(`[getSchemaDefinitions] Extracting schema from: ${filePath}`);

        const fileContent = await fetchFileContent(owner, repo, filePath, branch, accessToken, cache);
        if (!fileContent) {
          skippedFiles.push(filePath);
          continue;
        }

        const llmResult = await extractSchemaFromFile(filePath, fileContent, detectedOrm, detectedDatabase);
        if (!llmResult) {
          skippedFiles.push(filePath);
          continue;
        }

        allTables.push(...(llmResult.tables ?? []));
      }

      // ── Build summary ─────────────────────────────────────────────────────

      const totalColumns = allTables.reduce((s, t) => s + t.columns.length, 0);
      const totalIndexes = allTables.reduce((s, t) => s + t.indexes.length, 0);

      console.log(
        `[getSchemaDefinitions] Complete: ${allTables.length} tables, ${totalColumns} columns, ${totalIndexes} indexes`
      );

      const result: SchemaResult = {
        repository: repository.fullName,
        ormDetected: detectedOrm,
        databaseDetected: detectedDatabase,
        schemaFiles: filesToProcess,
        skippedFiles,
        summary: {
          totalTables: allTables.length,
          totalColumns,
          totalIndexes,
          totalRelations: allTables.reduce((s, t) => s + t.relations.length, 0),
        },
        tables: allTables,
      };

      return JSON.stringify(result, null, 2);

    } catch (error) {
      return `Error extracting schema definitions for repository "${repositoryId}": ${
        error instanceof Error ? error.message : "Unknown error occurred"
      }`;
    }
  },
  {
    name: "getSchemaDefinitions",
    description: "Fetch schema files identified by the agent from GitHub and extract all table/model/collection definitions as raw structured data. Supports all major ORMs (Prisma, TypeORM, Mongoose, Drizzle, Sequelize, MikroORM, Knex) and raw SQL. Returns table names, column definitions with type metadata (isPrimary, isRequired, isUnique, isIndexed, isForeignKey), explicitly defined indexes, and relations between tables. Returns raw facts only — no severity judgments or scale analysis. The agent cross-references this output with query pattern findings to draw its own conclusions.",
    schema: z.object({
      repositoryId: z.string().describe("The GitHub repository ID as stored in the database"),
      accessToken: z.string().describe("GitHub access token for fetching files via the API"),
      schemaFiles: z.array(z.string()).describe("File paths the agent has identified as schema definitions (e.g. ['prisma/schema.prisma', 'src/models/user.model.ts'])"),
      detectedOrm: z.string().describe("ORM in use — passed by agent from getDependenciesTool output (e.g. 'prisma', 'typeorm', 'mongoose', 'drizzle', 'sequelize', 'mikroorm', 'knex', 'unknown')"),
      detectedDatabase: z.string().describe("Database in use — passed by agent from getDependenciesTool output (e.g. 'postgresql', 'mysql', 'sqlite', 'mongodb', 'unknown')"),
    }),
  }
);
