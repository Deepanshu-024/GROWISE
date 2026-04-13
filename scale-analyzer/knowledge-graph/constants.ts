/**
 * Shared constants for the knowledge graph system.
 * Scoped to JavaScript/TypeScript/TSX (Next.js & React projects).
 */

// ---------------------------------------------------------------------------
// File extension → tree-sitter language mapping
// ---------------------------------------------------------------------------

export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
};

// ---------------------------------------------------------------------------
// AST node types per language — from tree-sitter grammars
// ---------------------------------------------------------------------------

export const CLASS_TYPES: Record<string, string[]> = {
  javascript: ['class_declaration', 'class'],
  typescript: ['class_declaration', 'class'],
  tsx: ['class_declaration', 'class'],
};

export const FUNCTION_TYPES: Record<string, string[]> = {
  javascript: ['function_declaration', 'method_definition'],
  typescript: ['function_declaration', 'method_definition'],
  tsx: ['function_declaration', 'method_definition'],
};

export const IMPORT_TYPES: Record<string, string[]> = {
  javascript: ['import_statement'],
  typescript: ['import_statement'],
  tsx: ['import_statement'],
};

export const CALL_TYPES: Record<string, string[]> = {
  javascript: ['call_expression', 'new_expression'],
  typescript: ['call_expression', 'new_expression'],
  tsx: ['call_expression', 'new_expression'],
};

// Arrow / function-expression types used in variable-assigned functions
export const JS_FUNC_VALUE_TYPES = new Set([
  'arrow_function',
  'function_expression',
  'function',
]);

// ---------------------------------------------------------------------------
// Filtering — builtins to exclude from CALLS query results (not from storage)
// ---------------------------------------------------------------------------

export const BUILTIN_CALL_NAMES = new Set([
  // Array methods
  'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every',
  'push', 'pop', 'shift', 'splice', 'slice', 'concat', 'join', 'flat', 'flatMap',
  // String methods
  'trim', 'split', 'replace', 'toLowerCase', 'toUpperCase',
  'startsWith', 'endsWith', 'includes', 'indexOf', 'match',
  // Promise methods
  'then', 'catch', 'finally', 'resolve', 'reject',
  // JSON
  'parse', 'stringify',
  // Console
  'log', 'warn', 'error', 'info', 'debug',
  // Object statics
  'keys', 'values', 'entries', 'assign', 'freeze', 'create',
  // Misc
  'toString', 'valueOf', 'require', 'fetch',
  // Test runners  (we skip test nodes but calls might still appear)
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
]);

// ---------------------------------------------------------------------------
// DB keywords — for scale-criticality scoring
// ---------------------------------------------------------------------------

export const DB_KEYWORDS = new Set([
  // Prisma ORM
  'query', 'find', 'select', 'insert', 'update', 'delete',
  'findMany', 'findUnique', 'findFirst', 'aggregate',
  'createMany', 'updateMany', 'deleteMany', 'upsert',
  'execute', 'raw', 'transaction',
  // Sequelize / TypeORM / generic
  'save', 'remove', 'count', 'findOne', 'findAll',
  'findAndCountAll', 'bulkCreate', 'destroy',
  // Mongoose
  'findById', 'findByIdAndUpdate', 'findByIdAndDelete',
  'findOneAndUpdate', 'findOneAndDelete', 'populate',
  // Raw SQL
  '$queryRaw', '$executeRaw', '$queryRawUnsafe',
]);

// ---------------------------------------------------------------------------
// Framework entry point patterns
// ---------------------------------------------------------------------------

export const FRAMEWORK_PATTERNS: RegExp[] = [
  /app\.(get|post|put|delete|patch|use|route)/i,
  /router\.(get|post|put|delete|patch|use|route)/i,
  /@(Get|Post|Put|Delete|Patch|RequestMapping)/i,
];

// Next.js-specific entry point detection
export const NEXTJS_API_PATTERN = /(?:app|pages)\/api\/.*\.(ts|tsx|js|jsx)$/;
export const NEXTJS_PAGE_PATTERN = /(?:app|pages)\/.*\.(ts|tsx|js|jsx)$/;
export const NEXTJS_HANDLER_NAMES = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

// General entry point name patterns
export const ENTRY_NAME_PATTERNS: RegExp[] = [
  /^main$/, /^handler$/, /^default$/, /^on[A-Z]/, /^handle[A-Z]/,
];

// ---------------------------------------------------------------------------
// Directories and files to skip
// ---------------------------------------------------------------------------

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '.turbo', '.vercel', 'out', '__tests__', '__mocks__',
  '.husky', '.github', '.vscode',
]);

export const SKIP_FILE_PATTERNS: RegExp[] = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /\.d\.ts$/,
  /\.config\.(ts|js|mjs|cjs)$/,
  /\.stories\.(ts|tsx|js|jsx)$/,
];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const MAX_AST_DEPTH = 150;

// WASM grammar file names
export const WASM_FILES: Record<string, string> = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
};
