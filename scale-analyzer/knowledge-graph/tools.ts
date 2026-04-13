/**
 * LangChain tool wrappers for querying the code knowledge graph.
 *
 * These tools let agents query the graph instead of re-reading files.
 * Each tool returns JSON strings for LLM consumption.
 *
 * NOT connected to any existing agents — built as standalone tools
 * for token-cost comparison testing.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { GraphStore } from './graph-store';
import { BUILTIN_CALL_NAMES, DB_KEYWORDS } from './constants';

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
  // 7. Graph statistics
  // ─────────────────────────────────────────────────────────────────────
  const getGraphStats = tool(
    async () => {
      try {
        const stats = await store.getStats();
        return JSON.stringify(stats, null, 2);
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

  return [
    getRouteCallChain,
    getFunctionCallers,
    getFunctionCallees,
    getFileSummary,
    getCriticalFlows,
    getDbHeavyFunctions,
    getGraphStats,
  ];
}
