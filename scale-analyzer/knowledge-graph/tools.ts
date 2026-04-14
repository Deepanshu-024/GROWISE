/**
 * LangChain tool wrappers for querying the code knowledge graph.
 *
 * These tools let agents query the graph instead of re-reading files.
 * Each tool returns JSON strings for LLM consumption.
 *
 * NOT connected to any existing agents — built as standalone tools
 * for token-cost comparison testing.
 *
 * Tools:
 *   1.  get_route_call_chain   — trace full call chain from a route/function
 *   2.  get_function_callers   — find all callers of a function
 *   3.  get_function_callees   — find all callees of a function
 *   4.  get_file_summary       — file structure without reading the file
 *   5.  get_critical_flows     — flows sorted by scale-risk score
 *   6.  get_db_heavy_functions — functions with the most DB calls
 *   7.  get_graph_stats        — aggregate graph statistics (mirrors list_graph_stats)
 *   8.  query_graph            — unified pattern query (callers_of, callees_of,
 *                                imports_of, importers_of, children_of,
 *                                inheritors_of, file_summary)
 *   9.  list_flows             — list all stored flows (mirrors list_flows)
 *   10. get_flow               — get single flow details by id or name
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GraphStore } from './graph-store';
import { BUILTIN_CALL_NAMES, DB_KEYWORDS } from './constants';

// ─── Internal helper: serialize node/edge to plain object ───────────────────

function nodeToDict(node: {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number | null;
  lineEnd: number | null;
  language: string | null;
  parentName: string | null;
  params: string | null;
  returnType: string | null;
}) {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    lineStart: node.lineStart,
    lineEnd: node.lineEnd,
    language: node.language,
    parentName: node.parentName,
    params: node.params,
    returnType: node.returnType,
  };
}

function edgeToDict(edge: {
  id: string;
  kind: string;
  sourceQualified: string;
  targetQualified: string;
  filePath: string;
  line: number;
}) {
  return {
    id: edge.id,
    kind: edge.kind,
    sourceQualified: edge.sourceQualified,
    targetQualified: edge.targetQualified,
    filePath: edge.filePath,
    line: edge.line,
  };
}

// ─── Query pattern registry (mirrors _QUERY_PATTERNS in query.py) ───────────

const QUERY_PATTERNS: Record<string, string> = {
  callers_of:   'Find all functions that call a given function',
  callees_of:   'Find all functions called by a given function',
  imports_of:   'Find all imports of a given file or module',
  importers_of: 'Find all files that import a given file or module',
  children_of:  'Find all nodes contained in a file or class',
  inheritors_of:'Find all classes that inherit from a given class',
  file_summary: 'Get a summary of all nodes in a file',
};

// ═══════════════════════════════════════════════════════════════════════════
// Tool factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create all knowledge graph tools for a specific repository.
 *
 * @param prisma  PrismaClient instance
 * @param repositoryId  Repository.id (internal UUID)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createKnowledgeGraphTools(prisma: any, repositoryId: string) {
  const store = new GraphStore(prisma, repositoryId);

  // ─────────────────────────────────────────────────────────────────────
  // 1. Trace the full call chain from a route / function
  // ─────────────────────────────────────────────────────────────────────
  const getRouteCallChain = tool(
    async ({ routeName }: { routeName: string }) => {
      try {
        const nodes = await store.searchNodes(routeName);
        const funcNodes = nodes.filter((n) => n.kind === 'Function');
        if (funcNodes.length === 0) {
          return `No function found matching "${routeName}"`;
        }

        const target = funcNodes[0];
        const visited = new Set<string>();
        const chain: Array<{ name: string; file: string; depth: number }> = [];
        const queue: Array<{ qn: string; depth: number }> = [
          { qn: target.qualifiedName, depth: 0 },
        ];
        visited.add(target.qualifiedName);

        while (queue.length > 0) {
          const { qn, depth } = queue.shift()!;
          const node = await store.getNode(qn);
          if (node) {
            chain.push({ name: node.name, file: node.filePath, depth });
          }
          if (depth >= 10) continue;

          const edges = await store.getEdgesBySource(qn);
          for (const edge of edges) {
            if (
              edge.kind === 'CALLS' &&
              !visited.has(edge.targetQualified)
            ) {
              const callee = await store.getNode(edge.targetQualified);
              if (callee) {
                visited.add(edge.targetQualified);
                queue.push({ qn: edge.targetQualified, depth: depth + 1 });
              }
            }
          }
        }

        return JSON.stringify(
          { route: routeName, callChain: chain, totalSteps: chain.length },
          null, 2,
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_route_call_chain',
      description:
        'Get the full call chain for an API route or function. ' +
        'Returns all functions called, their files, and call depth.',
      schema: z.object({
        routeName: z.string().describe('Name of the route handler or function to trace'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 2. Find callers of a function
  // ─────────────────────────────────────────────────────────────────────
  const getFunctionCallers = tool(
    async ({ functionName }: { functionName: string }) => {
      try {
        const nodes = await store.searchNodes(functionName);
        const funcNodes = nodes.filter((n) => n.kind === 'Function');
        if (funcNodes.length === 0) {
          return `No function found matching "${functionName}"`;
        }

        const results: Array<{ caller: string; file: string; line: number }> = [];
        for (const fn of funcNodes) {
          const edges = await store.getEdgesByTarget(fn.qualifiedName);
          for (const edge of edges) {
            if (edge.kind !== 'CALLS') continue;
            const sourceName = edge.sourceQualified.split('::').pop() ?? '';
            if (BUILTIN_CALL_NAMES.has(sourceName)) continue;
            results.push({
              caller: edge.sourceQualified,
              file: edge.filePath,
              line: edge.line,
            });
          }
        }

        return JSON.stringify(
          { function: functionName, callers: results, count: results.length },
          null, 2,
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_function_callers',
      description:
        'Find all functions that call the given function. ' +
        'Useful for understanding how widely a function is used.',
      schema: z.object({
        functionName: z.string().describe('Name of the function to find callers for'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 3. Find callees of a function
  // ─────────────────────────────────────────────────────────────────────
  const getFunctionCallees = tool(
    async ({ functionName }: { functionName: string }) => {
      try {
        const nodes = await store.searchNodes(functionName);
        const funcNodes = nodes.filter((n) => n.kind === 'Function');
        if (funcNodes.length === 0) {
          return `No function found matching "${functionName}"`;
        }

        const results: Array<{ callee: string; file: string; line: number }> = [];
        for (const fn of funcNodes) {
          const edges = await store.getEdgesBySource(fn.qualifiedName);
          for (const edge of edges) {
            if (edge.kind !== 'CALLS') continue;
            const calleeName =
              edge.targetQualified.split('::').pop()?.split('.').pop() ?? edge.targetQualified;
            if (BUILTIN_CALL_NAMES.has(calleeName)) continue;
            results.push({
              callee: edge.targetQualified,
              file: edge.filePath,
              line: edge.line,
            });
          }
        }

        return JSON.stringify(
          { function: functionName, callees: results, count: results.length },
          null, 2,
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_function_callees',
      description:
        "Find all functions called by the given function. " +
        "Useful for understanding a function's dependencies.",
      schema: z.object({
        functionName: z.string().describe('Name of the function to find callees for'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 4. File summary (replaces reading the file)
  // ─────────────────────────────────────────────────────────────────────
  const getFileSummary = tool(
    async ({ filePath }: { filePath: string }) => {
      try {
        let nodes = await store.getNodesByFile(filePath);

        // Fallback: try partial match on filename
        if (nodes.length === 0) {
          const basename = filePath.split('/').pop() ?? filePath;
          nodes = await store.searchNodes(basename);
        }

        const functions = nodes.filter((n) => n.kind === 'Function');
        const classes = nodes.filter((n) => n.kind === 'Class');

        // Get imports for this file
        const fileNode = nodes.find((n) => n.kind === 'File');
        let imports: Array<{ target: string; line: number }> = [];
        if (fileNode) {
          const edges = await store.getEdgesBySource(fileNode.qualifiedName);
          imports = edges
            .filter((e) => e.kind === 'IMPORTS_FROM')
            .map((e) => ({ target: e.targetQualified, line: e.line }));
        }

        return JSON.stringify({
          file: filePath,
          functions: functions.map((f) => ({
            name: f.name,
            line: f.lineStart,
            params: f.params,
            returnType: f.returnType,
          })),
          classes: classes.map((c) => ({
            name: c.name,
            line: c.lineStart,
          })),
          imports,
          totalFunctions: functions.length,
          totalClasses: classes.length,
          totalImports: imports.length,
        }, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_file_summary',
      description:
        'Get all functions, classes, and imports in a file WITHOUT reading the file. ' +
        'Much cheaper than reading the entire file content.',
      schema: z.object({
        filePath: z.string().describe('Path of the file to summarize'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 5. Critical flows (sorted by scale-risk)
  // ─────────────────────────────────────────────────────────────────────
  const getCriticalFlows = tool(
    async ({ limit }: { limit?: number }) => {
      try {
        const flows = await store.getFlows('criticality', limit ?? 10);
        return JSON.stringify({
          flows: flows.map((f: any) => ({
            name: f.name,
            entryPoint: f.entryPointQn,
            depth: f.depth,
            nodeCount: f.nodeCount,
            fileCount: f.fileCount,
            criticality: f.criticality,
            files: f.filesJson,
          })),
          total: flows.length,
        }, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_critical_flows',
      description:
        'Get the most critical execution flows sorted by scale-risk score. ' +
        'Each flow shows the entry point, call depth, and files touched.',
      schema: z.object({
        limit: z.number().optional().default(10).describe('Maximum number of flows to return'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 6. DB-heavy functions
  // ─────────────────────────────────────────────────────────────────────
  const getDbHeavyFunctions = tool(
    async () => {
      try {
        const allEdges = await store.getEdgesByKind('CALLS');

        // Count DB calls per source function
        const dbCallCounts = new Map<string, number>();
        for (const edge of allEdges) {
          const targetName =
            edge.targetQualified.split('::').pop()?.split('.').pop() ?? '';
          if (DB_KEYWORDS.has(targetName)) {
            const count = dbCallCounts.get(edge.sourceQualified) ?? 0;
            dbCallCounts.set(edge.sourceQualified, count + 1);
          }
        }

        // Sort by count
        const sorted = [...dbCallCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20);

        const results = [];
        for (const [qn, count] of sorted) {
          const node = await store.getNode(qn);
          results.push({
            function: qn,
            name: node?.name ?? qn.split('::').pop(),
            file: node?.filePath,
            dbCallCount: count,
          });
        }

        return JSON.stringify(
          { dbHeavyFunctions: results, total: results.length },
          null, 2,
        );
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_db_heavy_functions',
      description:
        'Find functions that make the most database calls. ' +
        'These are prime candidates for N+1 query issues at scale.',
      schema: z.object({}),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 7. Graph statistics  (mirrors list_graph_stats in query.py)
  // ─────────────────────────────────────────────────────────────────────
  const getGraphStats = tool(
    async () => {
      try {
        const stats = await store.getStats();

        const summaryParts = [
          `Graph statistics:`,
          `  Files: ${stats.filesCount}`,
          `  Total nodes: ${stats.totalNodes}`,
          `  Total edges: ${stats.totalEdges}`,
          `  Total flows: ${stats.totalFlows}`,
          `  Languages: ${stats.languages.length > 0 ? stats.languages.join(', ') : 'none'}`,
          '',
          'Nodes by kind:',
          ...Object.entries(stats.nodesByKind)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, count]) => `  ${kind}: ${count}`),
          '',
          'Edges by kind:',
          ...Object.entries(stats.edgesByKind)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([kind, count]) => `  ${kind}: ${count}`),
        ];

        return JSON.stringify({
          status: 'ok',
          summary: summaryParts.join('\n'),
          totalNodes: stats.totalNodes,
          totalEdges: stats.totalEdges,
          totalFlows: stats.totalFlows,
          nodesByKind: stats.nodesByKind,
          edgesByKind: stats.edgesByKind,
          languages: stats.languages,
          filesCount: stats.filesCount,
        }, null, 2);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: 'get_graph_stats',
      description: 'Get summary statistics about the code knowledge graph.',
      schema: z.object({}),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 8. query_graph — unified pattern query  (mirrors query_graph in query.py)
  //
  //    Patterns: callers_of, callees_of, imports_of, importers_of,
  //              children_of, inheritors_of, file_summary
  // ─────────────────────────────────────────────────────────────────────
  const queryGraph = tool(
    async ({
      pattern,
      target,
      detailLevel = 'standard',
    }: {
      pattern: string;
      target: string;
      detailLevel?: string;
    }) => {
      try {
        // Validate pattern
        if (!(pattern in QUERY_PATTERNS)) {
          return JSON.stringify({
            status: 'error',
            error: `Unknown pattern '${pattern}'. Available: ${Object.keys(QUERY_PATTERNS).join(', ')}`,
          }, null, 2);
        }

        const results: object[] = [];
        const edgesOut: object[] = [];

        // ── callers_of: skip common builtins (bare names only) ──
        // Mirrors _BUILTIN_CALL_NAMES guard in query.py
        if (
          pattern === 'callers_of' &&
          BUILTIN_CALL_NAMES.has(target) &&
          !target.includes('::')
        ) {
          return JSON.stringify({
            status: 'ok',
            pattern,
            target,
            description: QUERY_PATTERNS[pattern],
            summary: `'${target}' is a common builtin — callers_of skipped to avoid noise.`,
            results: [],
            edges: [],
          }, null, 2);
        }

        // ── Resolve target node ──
        // Try exact qualified name first, then search by name (mirrors query.py resolution)
        let node = await store.getNode(target);
        if (!node) {
          const candidates = await store.searchNodes(target, 5);
          if (candidates.length === 1) {
            node = candidates[0];
            target = node.qualifiedName;
          } else if (candidates.length > 1) {
            return JSON.stringify({
              status: 'ambiguous',
              summary: `Multiple matches for '${target}'. Please use a qualified name.`,
              candidates: candidates.map(nodeToDict),
            }, null, 2);
          }
        }

        if (!node && pattern !== 'file_summary') {
          return JSON.stringify({
            status: 'not_found',
            summary: `No node found matching '${target}'.`,
          }, null, 2);
        }

        const qn = node?.qualifiedName ?? target;

        // ── Execute pattern ──

        if (pattern === 'callers_of') {
          const edges = await store.getEdgesByTarget(qn);
          for (const e of edges) {
            if (e.kind !== 'CALLS') continue;
            const caller = await store.getNode(e.sourceQualified);
            if (caller) results.push(nodeToDict(caller));
            edgesOut.push(edgeToDict(e));
          }
          // Fallback: search by plain name (CALLS edges may store unqualified names)
          if (results.length === 0 && node) {
            const nameEdges = await store.getEdgesByTarget(node.name);
            for (const e of nameEdges) {
              if (e.kind !== 'CALLS') continue;
              const caller = await store.getNode(e.sourceQualified);
              if (caller) results.push(nodeToDict(caller));
              edgesOut.push(edgeToDict(e));
            }
          }

        } else if (pattern === 'callees_of') {
          const edges = await store.getEdgesBySource(qn);
          for (const e of edges) {
            if (e.kind !== 'CALLS') continue;
            const callee = await store.getNode(e.targetQualified);
            if (callee) results.push(nodeToDict(callee));
            edgesOut.push(edgeToDict(e));
          }

        } else if (pattern === 'imports_of') {
          const edges = await store.getEdgesBySource(qn);
          for (const e of edges) {
            if (e.kind !== 'IMPORTS_FROM') continue;
            results.push({ importTarget: e.targetQualified });
            edgesOut.push(edgeToDict(e));
          }

        } else if (pattern === 'importers_of') {
          // Find edges where targetQualified matches this file path
          const fileTarget = node?.filePath ?? target;
          const edges = await store.getEdgesByTarget(fileTarget);
          for (const e of edges) {
            if (e.kind !== 'IMPORTS_FROM') continue;
            results.push({ importer: e.sourceQualified, file: e.filePath });
            edgesOut.push(edgeToDict(e));
          }

        } else if (pattern === 'children_of') {
          const edges = await store.getEdgesBySource(qn);
          for (const e of edges) {
            if (e.kind !== 'CONTAINS') continue;
            const child = await store.getNode(e.targetQualified);
            if (child) results.push(nodeToDict(child));
          }

        } else if (pattern === 'inheritors_of') {
          const edges = await store.getEdgesByTarget(qn);
          for (const e of edges) {
            if (e.kind !== 'INHERITS' && e.kind !== 'IMPLEMENTS') continue;
            const child = await store.getNode(e.sourceQualified);
            if (child) results.push(nodeToDict(child));
            edgesOut.push(edgeToDict(e));
          }

        } else if (pattern === 'file_summary') {
          // Use the target as a file path, fall back to search
          let fileNodes = await store.getNodesByFile(target);
          if (fileNodes.length === 0) {
            const basename = target.split('/').pop() ?? target;
            fileNodes = await store.searchNodes(basename);
          }
          for (const n of fileNodes) {
            results.push(nodeToDict(n));
          }
        }

        const summary = `Found ${results.length} result(s) for ${pattern}('${target}')`;

        if (detailLevel === 'minimal') {
          const minimalResults = results.slice(0, 5).map((r: any) => ({
            name: r.name,
            kind: r.kind,
            filePath: r.filePath,
          }));
          return JSON.stringify({
            status: 'ok',
            pattern,
            target,
            description: QUERY_PATTERNS[pattern],
            summary,
            resultCount: results.length,
            results: minimalResults,
          }, null, 2);
        }

        return JSON.stringify({
          status: 'ok',
          pattern,
          target,
          description: QUERY_PATTERNS[pattern],
          summary,
          results,
          edges: edgesOut,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }, null, 2);
      }
    },
    {
      name: 'query_graph',
      description:
        'Run a predefined graph query. Pattern must be one of: ' +
        'callers_of (who calls a function), ' +
        'callees_of (what does a function call), ' +
        'imports_of (what does a file import), ' +
        'importers_of (who imports a file), ' +
        'children_of (nodes contained in a file/class), ' +
        'inheritors_of (classes that extend/implement a class), ' +
        'file_summary (all nodes in a file).',
      schema: z.object({
        pattern: z.string().describe(
          'Query pattern: callers_of | callees_of | imports_of | importers_of | ' +
          'children_of | inheritors_of | file_summary',
        ),
        target: z.string().describe(
          'The node name, qualified name, or file path to query about',
        ),
        detailLevel: z.enum(['standard', 'minimal']).optional().default('standard').describe(
          '"standard" returns full results; "minimal" returns only name/kind/file for the top 5',
        ),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 9. list_flows  (mirrors list_flows in flows_tools.py)
  //    Returns stored flows sorted by criticality, with optional kind filter
  //    and detail_level support.
  // ─────────────────────────────────────────────────────────────────────
  const listFlows = tool(
    async ({
      sortBy = 'criticality',
      limit = 50,
      kind,
      detailLevel = 'standard',
    }: {
      sortBy?: string;
      limit?: number;
      kind?: string;
      detailLevel?: string;
    }) => {
      try {
        // Fetch more when filtering by kind so we have enough after filtering
        const fetchLimit = kind ? limit * 10 : limit;
        const validSort = ['criticality', 'depth', 'nodeCount'].includes(sortBy)
          ? (sortBy as 'criticality' | 'depth' | 'nodeCount')
          : 'criticality';

        let flows: any[] = await store.getFlows(validSort, fetchLimit);

        // Filter by entry point kind if requested
        if (kind) {
          const filtered: any[] = [];
          for (const f of flows) {
            if (f.entryPointQn) {
              const epNode = await store.getNode(f.entryPointQn);
              if (epNode && epNode.kind === kind) {
                filtered.push(f);
              }
            }
            if (filtered.length >= limit) break;
          }
          flows = filtered;
        }

        // Normalize flow shape (Prisma returns camelCase)
        const normalizedFlows = flows.map((f: any) => ({
          id: f.id,
          name: f.name,
          entryPointQn: f.entryPointQn,
          depth: f.depth,
          nodeCount: f.nodeCount,
          fileCount: f.fileCount,
          criticality: f.criticality,
          files: f.filesJson ?? [],
          path: f.pathJson ?? [],
        }));

        // Apply detail_level
        const outputFlows = detailLevel === 'minimal'
          ? normalizedFlows.map((f) => ({
            name: f.name,
            criticality: f.criticality,
            nodeCount: f.nodeCount,
          }))
          : normalizedFlows;

        return JSON.stringify({
          status: 'ok',
          summary: `Found ${outputFlows.length} execution flow(s)`,
          flows: outputFlows,
          total: outputFlows.length,
        }, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }, null, 2);
      }
    },
    {
      name: 'list_flows',
      description:
        'List execution flows in the codebase sorted by criticality. ' +
        'Each flow represents a call chain starting from an entry point ' +
        '(e.g. HTTP handler, CLI command). ' +
        'Use detailLevel="minimal" for a lightweight summary.',
      schema: z.object({
        sortBy: z.enum(['criticality', 'depth', 'nodeCount'])
          .optional().default('criticality')
          .describe('Column to sort by'),
        limit: z.number().optional().default(50)
          .describe('Maximum flows to return'),
        kind: z.string().optional()
          .describe('Filter by entry point kind, e.g. "Function"'),
        detailLevel: z.enum(['standard', 'minimal']).optional().default('standard')
          .describe('"standard" returns full flow data; "minimal" returns name/criticality/nodeCount only'),
      }),
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // 10. get_flow  (mirrors get_flow in flows_tools.py)
  //     Returns full path details for a single flow including each step.
  //     Lookup by ID or partial name match.
  // ─────────────────────────────────────────────────────────────────────
  const getFlow = tool(
    async ({
      flowId,
      flowName,
    }: {
      flowId?: string;
      flowName?: string;
    }) => {
      try {
        if (!flowId && !flowName) {
          return JSON.stringify({
            status: 'error',
            error: 'Provide either flowId or flowName',
          }, null, 2);
        }

        let flow: any = null;

        if (flowId) {
          // Look up by ID directly
          flow = await store.getFlowById(flowId);
        } else if (flowName) {
          // Search by partial name match directly in Postgres (no JS-side scan limit)
          const nameMatches = await store.searchFlowsByName(flowName, 5);
          if (nameMatches.length > 0) {
            // nameMatches already ordered by criticality desc — take the best
            flow = nameMatches[0];
          } else {
            // Fallback: search by entryPointQn containing the name
            const allFlows: any[] = await store.getFlows('criticality', 500);
            const match = allFlows.find(
              (f: any) =>
                f.name.toLowerCase().includes(flowName!.toLowerCase()) ||
                f.entryPointQn.toLowerCase().includes(flowName!.toLowerCase()),
            );
            if (match) flow = match;
          }
        }

        if (!flow) {
          return JSON.stringify({
            status: 'not_found',
            summary: 'No flow found matching the given criteria.',
          }, null, 2);
        }

        // Build detailed step info (resolve each node in the path)
        const pathQnames: string[] = flow.pathJson ?? [];
        const steps: object[] = [];
        for (const qn of pathQnames) {
          const node = await store.getNode(qn);
          if (node) {
            steps.push({
              qualifiedName: node.qualifiedName,
              name: node.name,
              kind: node.kind,
              file: node.filePath,
              lineStart: node.lineStart,
              lineEnd: node.lineEnd,
            });
          }
        }

        const result = {
          status: 'ok',
          summary: `Flow '${flow.name}': ${flow.nodeCount} nodes, depth ${flow.depth}, criticality ${Number(flow.criticality).toFixed(4)}`,
          flow: {
            id: flow.id,
            name: flow.name,
            entryPointQn: flow.entryPointQn,
            depth: flow.depth,
            nodeCount: flow.nodeCount,
            fileCount: flow.fileCount,
            criticality: flow.criticality,
            files: flow.filesJson ?? [],
            path: pathQnames,
            steps,
          },
        };

        return JSON.stringify(result, null, 2);
      } catch (err) {
        return JSON.stringify({
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        }, null, 2);
      }
    },
    {
      name: 'get_flow',
      description:
        'Get full details of a single execution flow including every step in the call path. ' +
        'Provide flowId (exact ID from list_flows) or flowName (partial match).',
      schema: z.object({
        flowId: z.string().optional().describe('Exact flow ID (from list_flows)'),
        flowName: z.string().optional().describe('Partial name to search for'),
      }),
    },
  );

  return [
    getRouteCallChain,
    getFunctionCallers,
    getFunctionCallees,
    getFileSummary,
    getCriticalFlows,
    getDbHeavyFunctions,
    getGraphStats,
    queryGraph,
    listFlows,
    getFlow,
  ];
}
