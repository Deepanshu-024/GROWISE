/**
 * Tree-sitter based code parser for JavaScript / TypeScript / TSX.
 *
 * Uses web-tree-sitter (WASM) so it works everywhere without native compilation.
 * Extracts structural nodes (File, Class, Function) and edges
 * (CALLS, IMPORTS_FROM, INHERITS, CONTAINS) from source files.
 *
 * Adapted from reference parser.py — scoped to JS/TS/React only.
 */

import * as path from 'path';
import {
  EXTENSION_TO_LANGUAGE,
  CLASS_TYPES,
  FUNCTION_TYPES,
  IMPORT_TYPES,
  CALL_TYPES,
  JS_FUNC_VALUE_TYPES,
  MAX_AST_DEPTH,
  WASM_FILES,
} from './constants';

// ─── Data models ────────────────────────────────────────────────────────────

export interface NodeInfo {
  kind: string;       // "File" | "Class" | "Function"
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  parentName?: string;
  params?: string;
  returnType?: string;
  extra: Record<string, unknown>;
}

export interface EdgeInfo {
  kind: string;       // "CALLS" | "IMPORTS_FROM" | "INHERITS" | "CONTAINS"
  source: string;     // qualified name
  target: string;     // qualified name or bare name
  filePath: string;
  line: number;
}

// ─── Parser context (passed through recursion) ─────────────────────────────
interface ExtractContext {
  enclosingClass?: string;
  enclosingFunc?: string;
  importMap: Map<string, string>;   // importedName → modulePath
  definedNames: Set<string>;        // file-scope function/class names
  depth: number;
}

// ─── tree-sitter types (web-tree-sitter has no bundled .d.ts) ───────────────
type TSParser = any;
type TSLanguage = any;
type TSTree = any;
type TSNode = any;

// ─── Grammar singleton cache ────────────────────────────────────────────────
let TreeSitterParser: any = null;
const languageCache: Map<string, TSLanguage> = new Map();

// Use native Node.js require to bypass Turbopack/Next.js bundling.
// Turbopack transforms import() and require() — eval('require') is the
// only reliable way to ensure the module is loaded natively at runtime,
// preserving the Emscripten internals that WASM loading depends on.
// eslint-disable-next-line no-eval
const nativeRequire = eval('require');

async function getParserModule(): Promise<any> {
  if (!TreeSitterParser) {
    // web-tree-sitter@0.20.8 CJS exports the Parser constructor directly
    TreeSitterParser = nativeRequire('web-tree-sitter');

    // Tell Emscripten where to find web-tree-sitter.wasm
    const moduleDir = path.resolve(
      process.cwd(), 'node_modules', 'web-tree-sitter',
    );
    await TreeSitterParser.init({
      locateFile: (fileName: string) => path.join(moduleDir, fileName),
    });
  }
  return TreeSitterParser;
}

async function loadLanguage(lang: string): Promise<TSLanguage> {
  if (languageCache.has(lang)) return languageCache.get(lang)!;

  const P = await getParserModule();
  const wasmFile = WASM_FILES[lang];
  if (!wasmFile) throw new Error(`No WASM grammar for language: ${lang}`);

  const wasmPath = path.resolve(
    process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', wasmFile,
  );
  const language = await P.Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}

// ═══════════════════════════════════════════════════════════════════════════
// CodeParser
// ═══════════════════════════════════════════════════════════════════════════

export class CodeParser {
  private knownFiles: Set<string>;

  constructor(knownFiles?: Set<string>) {
    this.knownFiles = knownFiles ?? new Set();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Detect language from file extension. */
  detectLanguage(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_TO_LANGUAGE[ext] ?? null;
  }

  /** Parse source code and extract nodes + edges. */
  async parseSource(
    filePath: string,
    source: string,
  ): Promise<{ nodes: NodeInfo[]; edges: EdgeInfo[] }> {
    const language = this.detectLanguage(filePath);
    if (!language) return { nodes: [], edges: [] };

    // Load grammar & parse
    const grammar = await loadLanguage(language);
    const P = await getParserModule();
    const parser = new P();
    parser.setLanguage(grammar);
    const tree: TSTree = parser.parse(source);
    const root: TSNode = tree.rootNode;

    const nodes: NodeInfo[] = [];
    const edges: EdgeInfo[] = [];

    // File node
    const lineCount = source.split('\n').length;
    nodes.push({
      kind: 'File',
      name: filePath,
      filePath,
      lineStart: 1,
      lineEnd: lineCount,
      language,
      extra: {},
    });

    // Pre-scan for import map + defined names
    const { importMap, definedNames } = this.collectFileScope(root, language);

    // Recursive AST walk
    this.extractFromTree(root, source, language, filePath, nodes, edges, {
      importMap,
      definedNames,
      depth: 0,
    });

    // Post-process: resolve bare call targets
    const resolvedEdges = this.resolveCallTargets(nodes, edges, filePath);

    parser.delete();
    tree.delete();

    return { nodes, edges: resolvedEdges };
  }

  // ─── File scope pre-scan ────────────────────────────────────────────────

  private collectFileScope(
    root: TSNode,
    language: string,
  ): { importMap: Map<string, string>; definedNames: Set<string> } {
    const importMap = new Map<string, string>();
    const definedNames = new Set<string>();

    const funcTypes = new Set(FUNCTION_TYPES[language] ?? []);
    const classTypes = new Set(CLASS_TYPES[language] ?? []);
    const importTypes = new Set(IMPORT_TYPES[language] ?? []);

    for (let i = 0; i < root.childCount; i++) {
      const child: TSNode = root.child(i);
      if (!child) continue;
      let target = child;

      // Unwrap export statements
      if (child.type === 'export_statement') {
        for (let j = 0; j < child.childCount; j++) {
          const inner: TSNode = child.child(j);
          if (!inner) continue;
          if (
            funcTypes.has(inner.type) ||
            classTypes.has(inner.type) ||
            inner.type === 'lexical_declaration' ||
            inner.type === 'variable_declaration'
          ) {
            target = inner;
            break;
          }
        }
      }

      // Collect defined function/class names
      if (funcTypes.has(target.type) || classTypes.has(target.type)) {
        const name = this.getName(target);
        if (name) definedNames.add(name);
      }

      // Variable-assigned functions
      if (
        target.type === 'lexical_declaration' ||
        target.type === 'variable_declaration'
      ) {
        for (let j = 0; j < target.childCount; j++) {
          const decl: TSNode = target.child(j);
          if (!decl || decl.type !== 'variable_declarator') continue;
          const varName = this.getIdentifierChild(decl);
          let hasFunc = false;
          for (let k = 0; k < decl.childCount; k++) {
            const sub: TSNode = decl.child(k);
            if (sub && JS_FUNC_VALUE_TYPES.has(sub.type)) {
              hasFunc = true;
              break;
            }
          }
          if (varName && hasFunc) definedNames.add(varName);
        }
      }

      // Collect import names
      if (importTypes.has(child.type)) {
        this.collectImportNames(child, importMap);
      }
    }

    return { importMap, definedNames };
  }

  /** Extract imported names → module path mappings from an import statement. */
  private collectImportNames(
    node: TSNode,
    importMap: Map<string, string>,
  ): void {
    let modulePath: string | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && child.type === 'string') {
        modulePath = child.text.replace(/['"]/g, '');
        break;
      }
    }
    if (!modulePath) return;

    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && child.type === 'import_clause') {
        this.collectJsImportNames(child, modulePath, importMap);
      }
    }
  }

  private collectJsImportNames(
    clauseNode: TSNode,
    modulePath: string,
    importMap: Map<string, string>,
  ): void {
    for (let i = 0; i < clauseNode.childCount; i++) {
      const child: TSNode = clauseNode.child(i);
      if (!child) continue;

      if (child.type === 'identifier') {
        // Default import
        importMap.set(child.text, modulePath);
      } else if (child.type === 'named_imports') {
        for (let j = 0; j < child.childCount; j++) {
          const spec: TSNode = child.child(j);
          if (!spec || spec.type !== 'import_specifier') continue;
          const names: string[] = [];
          for (let k = 0; k < spec.childCount; k++) {
            const s: TSNode = spec.child(k);
            if (s && (s.type === 'identifier' || s.type === 'property_identifier')) {
              names.push(s.text);
            }
          }
          // Last identifier is the local name (handles `import { A as B }`)
          if (names.length > 0) {
            importMap.set(names[names.length - 1], modulePath);
          }
        }
      } else if (child.type === 'namespace_import') {
        // import * as NS from '...'
        for (let j = 0; j < child.childCount; j++) {
          const sub: TSNode = child.child(j);
          if (sub && sub.type === 'identifier') {
            importMap.set(sub.text, modulePath);
          }
        }
      }
    }
  }

  // ─── Recursive AST walker ──────────────────────────────────────────────

  private extractFromTree(
    root: TSNode,
    source: string,
    language: string,
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): void {
    if (ctx.depth > MAX_AST_DEPTH) return;

    const classTypes = new Set(CLASS_TYPES[language] ?? []);
    const funcTypes = new Set(FUNCTION_TYPES[language] ?? []);
    const importTypes = new Set(IMPORT_TYPES[language] ?? []);
    const callTypes = new Set(CALL_TYPES[language] ?? []);

    for (let i = 0; i < root.childCount; i++) {
      const child: TSNode = root.child(i);
      if (!child) continue;
      const nodeType: string = child.type;

      // ── Variable-assigned functions: const foo = () => {} ──
      if (
        (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration') &&
        this.extractJsVarFunctions(child, source, language, filePath, nodes, edges, ctx)
      ) {
        continue;
      }

      // ── Classes ──
      if (classTypes.has(nodeType)) {
        if (this.extractClasses(child, source, language, filePath, nodes, edges, ctx)) {
          continue;
        }
      }

      // ── Class field arrow functions: handler = (e) => {} ──
      if (
        nodeType === 'public_field_definition' &&
        this.extractJsFieldFunction(child, source, language, filePath, nodes, edges, ctx)
      ) {
        continue;
      }

      // ── Functions / methods ──
      if (funcTypes.has(nodeType)) {
        if (this.extractFunctions(child, source, language, filePath, nodes, edges, ctx)) {
          continue;
        }
      }

      // ── Imports ──
      if (importTypes.has(nodeType)) {
        this.extractImports(child, filePath, edges);
        continue;
      }

      // ── Calls ──
      if (callTypes.has(nodeType)) {
        this.extractCalls(child, filePath, edges, ctx);
        // Don't continue — still need to recurse into call arguments
      }

      // ── Default: recurse ──
      this.extractFromTree(child, source, language, filePath, nodes, edges, {
        ...ctx,
        depth: ctx.depth + 1,
      });
    }
  }

  // ─── Extractors ─────────────────────────────────────────────────────────

  /**
   * Handle variable-assigned functions:
   *   const foo = () => { ... }
   *   export const bar = async function() { ... }
   */
  private extractJsVarFunctions(
    child: TSNode,
    source: string,
    language: string,
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): boolean {
    let handled = false;

    for (let i = 0; i < child.childCount; i++) {
      const declarator: TSNode = child.child(i);
      if (!declarator || declarator.type !== 'variable_declarator') continue;

      let varName: string | null = null;
      let funcNode: TSNode | null = null;

      for (let j = 0; j < declarator.childCount; j++) {
        const sub: TSNode = declarator.child(j);
        if (!sub) continue;
        if (sub.type === 'identifier' && !varName) {
          varName = sub.text;
        } else if (JS_FUNC_VALUE_TYPES.has(sub.type)) {
          funcNode = sub;
        }
      }

      if (!varName || !funcNode) continue;

      const qualified = this.qualify(varName, filePath, ctx.enclosingClass);
      const params = this.getParams(funcNode);
      const returnType = this.getReturnType(funcNode);

      nodes.push({
        kind: 'Function',
        name: varName,
        filePath,
        lineStart: child.startPosition.row + 1,
        lineEnd: child.endPosition.row + 1,
        language,
        parentName: ctx.enclosingClass,
        params: params ?? undefined,
        returnType: returnType ?? undefined,
        extra: {},
      });

      // CONTAINS edge
      const container = ctx.enclosingClass
        ? this.qualify(ctx.enclosingClass, filePath)
        : filePath;
      edges.push({
        kind: 'CONTAINS',
        source: container,
        target: qualified,
        filePath,
        line: child.startPosition.row + 1,
      });

      // Recurse into the function body
      this.extractFromTree(funcNode, source, language, filePath, nodes, edges, {
        ...ctx,
        enclosingFunc: varName,
        depth: ctx.depth + 1,
      });

      handled = true;
    }

    return handled;
  }

  /** Extract class definitions. */
  private extractClasses(
    child: TSNode,
    source: string,
    language: string,
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): boolean {
    const name = this.getName(child);
    if (!name) return false;

    nodes.push({
      kind: 'Class',
      name,
      filePath,
      lineStart: child.startPosition.row + 1,
      lineEnd: child.endPosition.row + 1,
      language,
      parentName: ctx.enclosingClass,
      extra: {},
    });

    // CONTAINS edge from file
    edges.push({
      kind: 'CONTAINS',
      source: filePath,
      target: this.qualify(name, filePath, ctx.enclosingClass),
      filePath,
      line: child.startPosition.row + 1,
    });

    // INHERITS edges
    const bases = this.getBases(child);
    for (const base of bases) {
      edges.push({
        kind: 'INHERITS',
        source: this.qualify(name, filePath, ctx.enclosingClass),
        target: base,
        filePath,
        line: child.startPosition.row + 1,
      });
    }

    // Recurse into class body
    this.extractFromTree(child, source, language, filePath, nodes, edges, {
      ...ctx,
      enclosingClass: name,
      enclosingFunc: undefined,
      depth: ctx.depth + 1,
    });

    return true;
  }

  /** Handle class field arrow functions: handler = (e) => { ... } */
  private extractJsFieldFunction(
    child: TSNode,
    source: string,
    language: string,
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): boolean {
    let propName: string | null = null;
    let funcNode: TSNode | null = null;

    for (let i = 0; i < child.childCount; i++) {
      const sub: TSNode = child.child(i);
      if (!sub) continue;
      if (sub.type === 'property_identifier' && !propName) {
        propName = sub.text;
      } else if (JS_FUNC_VALUE_TYPES.has(sub.type)) {
        funcNode = sub;
      }
    }

    if (!propName || !funcNode) return false;

    const qualified = this.qualify(propName, filePath, ctx.enclosingClass);
    const params = this.getParams(funcNode);

    nodes.push({
      kind: 'Function',
      name: propName,
      filePath,
      lineStart: child.startPosition.row + 1,
      lineEnd: child.endPosition.row + 1,
      language,
      parentName: ctx.enclosingClass,
      params: params ?? undefined,
      extra: {},
    });

    const container = ctx.enclosingClass
      ? this.qualify(ctx.enclosingClass, filePath)
      : filePath;
    edges.push({
      kind: 'CONTAINS',
      source: container,
      target: qualified,
      filePath,
      line: child.startPosition.row + 1,
    });

    // Recurse into function body
    this.extractFromTree(funcNode, source, language, filePath, nodes, edges, {
      ...ctx,
      enclosingFunc: propName,
      depth: ctx.depth + 1,
    });

    return true;
  }

  /** Extract function / method definitions. */
  private extractFunctions(
    child: TSNode,
    source: string,
    language: string,
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): boolean {
    const name = this.getName(child);
    if (!name) return false;

    const qualified = this.qualify(name, filePath, ctx.enclosingClass);
    const params = this.getParams(child);
    const returnType = this.getReturnType(child);

    // Extract decorators — stored in extra for entry-point detection
    const decorators: string[] = [];
    for (let i = 0; i < child.childCount; i++) {
      const sub: TSNode = child.child(i);
      if (sub && sub.type === 'decorator') {
        decorators.push(sub.text);
      }
    }

    nodes.push({
      kind: 'Function',
      name,
      filePath,
      lineStart: child.startPosition.row + 1,
      lineEnd: child.endPosition.row + 1,
      language,
      parentName: ctx.enclosingClass,
      params: params ?? undefined,
      returnType: returnType ?? undefined,
      extra: decorators.length > 0 ? { decorators } : {},
    });

    // CONTAINS edge
    const container = ctx.enclosingClass
      ? this.qualify(ctx.enclosingClass, filePath)
      : filePath;
    edges.push({
      kind: 'CONTAINS',
      source: container,
      target: qualified,
      filePath,
      line: child.startPosition.row + 1,
    });

    // Recurse into function body for calls
    this.extractFromTree(child, source, language, filePath, nodes, edges, {
      ...ctx,
      enclosingFunc: name,
      depth: ctx.depth + 1,
    });

    return true;
  }

  /** Extract import edges. */
  private extractImports(
    child: TSNode,
    filePath: string,
    edges: EdgeInfo[],
  ): void {
    let modulePath: string | null = null;
    for (let i = 0; i < child.childCount; i++) {
      const sub: TSNode = child.child(i);
      if (sub && sub.type === 'string') {
        modulePath = sub.text.replace(/['"]/g, '');
        break;
      }
    }
    if (!modulePath) return;

    const resolved = this.resolveModulePath(modulePath, filePath);
    edges.push({
      kind: 'IMPORTS_FROM',
      source: filePath,
      target: resolved ?? modulePath,
      filePath,
      line: child.startPosition.row + 1,
    });
  }

  /** Extract call expressions → CALLS edges. */
  private extractCalls(
    child: TSNode,
    filePath: string,
    edges: EdgeInfo[],
    ctx: ExtractContext,
  ): void {
    if (!ctx.enclosingFunc) return;

    const callName = this.getCallName(child);
    if (!callName) return;

    const caller = this.qualify(ctx.enclosingFunc, filePath, ctx.enclosingClass);

    // Resolve inline
    const target = this.resolveCallTarget(
      callName, filePath, ctx.importMap, ctx.definedNames,
    );

    edges.push({
      kind: 'CALLS',
      source: caller,
      target,
      filePath,
      line: child.startPosition.row + 1,
    });
  }

  // ─── Post-processing: resolve bare call targets ────────────────────────

  private resolveCallTargets(
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    filePath: string,
  ): EdgeInfo[] {
    // Build symbol table: bare_name → qualified_name
    const symbols = new Map<string, string>();
    for (const node of nodes) {
      if (node.kind === 'Function' || node.kind === 'Class') {
        const qualified = this.qualify(node.name, filePath, node.parentName);
        if (!symbols.has(node.name)) {
          symbols.set(node.name, qualified);
        }
      }
    }

    return edges.map(edge => {
      if (edge.kind === 'CALLS' && !edge.target.includes('::')) {
        const resolved = symbols.get(edge.target);
        if (resolved) {
          return { ...edge, target: resolved };
        }
      }
      return edge;
    });
  }

  /** Resolve a bare call name to a qualified target (inline during extraction). */
  private resolveCallTarget(
    callName: string,
    filePath: string,
    importMap: Map<string, string>,
    definedNames: Set<string>,
  ): string {
    // Defined in same file
    if (definedNames.has(callName)) {
      return this.qualify(callName, filePath);
    }
    // Imported
    if (importMap.has(callName)) {
      const modulePath = importMap.get(callName)!;
      const resolved = this.resolveModulePath(modulePath, filePath);
      if (resolved) {
        return this.qualify(callName, resolved);
      }
    }
    // Leave as bare name
    return callName;
  }

  /** Resolve a module import path to a known file path. */
  private resolveModulePath(modulePath: string, fromFile: string): string | null {
    if (!modulePath.startsWith('.')) return null; // package import

    const dir = path.dirname(fromFile);
    const base = path.join(dir, modulePath).replace(/\\/g, '/');

    // Try exact path
    if (this.knownFiles.has(base)) return base;

    // Try extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (this.knownFiles.has(candidate)) return candidate;
    }

    // Try index files
    for (const ext of extensions) {
      const candidate = `${base}/index${ext}`;
      if (this.knownFiles.has(candidate)) return candidate;
    }

    return null;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** Create a qualified name: filePath::ClassName.name or filePath::name */
  qualify(name: string, filePath: string, enclosingClass?: string): string {
    if (enclosingClass) {
      return `${filePath}::${enclosingClass}.${name}`;
    }
    return `${filePath}::${name}`;
  }

  /** Extract the name from a class/function definition node. */
  private getName(node: TSNode): string | null {
    const nameTypes = new Set([
      'identifier', 'type_identifier', 'property_identifier', 'name',
    ]);
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && nameTypes.has(child.type)) {
        return child.text;
      }
    }
    return null;
  }

  /** Get the first identifier child's text. */
  private getIdentifierChild(node: TSNode): string | null {
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && child.type === 'identifier') return child.text;
    }
    return null;
  }

  /** Extract parameter list as a string. */
  private getParams(node: TSNode): string | null {
    const paramTypes = new Set(['parameters', 'formal_parameters']);
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && paramTypes.has(child.type)) {
        return child.text;
      }
    }
    return null;
  }

  /** Extract return type annotation. */
  private getReturnType(node: TSNode): string | null {
    const retTypes = new Set(['type_annotation', 'return_type']);
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (child && retTypes.has(child.type)) {
        return child.text;
      }
    }
    return null;
  }

  /** Extract the function/method name being called. */
  private getCallName(node: TSNode): string | null {
    const first: TSNode = node.child(0);
    if (!first) return null;

    // Direct function call: foo()
    if (first.type === 'identifier') {
      return first.text;
    }

    // Method call: obj.method()
    if (first.type === 'member_expression') {
      // Get the rightmost property_identifier
      for (let i = first.childCount - 1; i >= 0; i--) {
        const sub: TSNode = first.child(i);
        if (sub && sub.type === 'property_identifier') {
          return sub.text;
        }
      }
    }

    // new Constructor()
    if (node.type === 'new_expression' && first.type === 'identifier') {
      return first.text;
    }

    return null;
  }

  /** Extract base class names from class heritage / extends. */
  private getBases(node: TSNode): string[] {
    const bases: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child: TSNode = node.child(i);
      if (!child) continue;
      if (child.type === 'class_heritage' || child.type === 'extends_clause') {
        for (let j = 0; j < child.childCount; j++) {
          const sub: TSNode = child.child(j);
          if (!sub) continue;
          if (sub.type === 'identifier' || sub.type === 'type_identifier') {
            bases.push(sub.text);
          } else if (sub.type === 'extends_clause') {
            // Nested
            for (let k = 0; k < sub.childCount; k++) {
              const inner: TSNode = sub.child(k);
              if (inner && (inner.type === 'identifier' || inner.type === 'type_identifier')) {
                bases.push(inner.text);
              }
            }
          }
        }
      }
    }
    return bases;
  }
}
