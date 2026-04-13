/**
 * Execution flow detection, BFS tracing, and scale-focused criticality scoring.
 *
 * Adapted from reference flows.py — modified for Next.js/React and
 * reweighted for scale/performance bottleneck analysis.
 */

import {
  FRAMEWORK_PATTERNS,
  ENTRY_NAME_PATTERNS,
  NEXTJS_API_PATTERN,
  NEXTJS_HANDLER_NAMES,
  DB_KEYWORDS,
} from './constants';
import type { GraphStore, GraphNode, GraphEdge, FlowData } from './graph-store';

// ═══════════════════════════════════════════════════════════════════════════
// Entry point detection
// ═══════════════════════════════════════════════════════════════════════════

/** Check if a node has framework decorators (e.g. @Get(), @Post()). */
function hasFrameworkDecorator(node: GraphNode): boolean {
  const decorators = (node.extra as Record<string, unknown>)?.decorators;
  if (!decorators) return false;
  const decList = Array.isArray(decorators) ? decorators : [decorators];
  for (const dec of decList) {
    if (typeof dec !== 'string') continue;
    for (const pat of FRAMEWORK_PATTERNS) {
      if (pat.test(dec)) return true;
    }
  }
  return false;
}

/** Check if a node matches entry-point naming conventions. */
function matchesEntryName(node: GraphNode): boolean {
  for (const pat of ENTRY_NAME_PATTERNS) {
    if (pat.test(node.name)) return true;
  }
  // Next.js API route handlers (GET, POST, etc. in app/api/ or pages/api/)
  if (
    NEXTJS_API_PATTERN.test(node.filePath) &&
    NEXTJS_HANDLER_NAMES.has(node.name)
  ) {
    return true;
  }
  return false;
}

/**
 * Find all functions that are entry points in the call graph.
 *
 * A function is an entry point if:
 *  1. Nobody calls it — not in getAllCallTargets()
 *  2. Has a framework decorator (@Get, app.post, etc.)
 *  3. Name matches conventional patterns (handler, GET, main, etc.)
 */
export async function detectEntryPoints(store: GraphStore): Promise<GraphNode[]> {
  const calledQnames = await store.getAllCallTargets();
  const candidateNodes = await store.getNodesByKind(['Function']);

  const entryPoints: GraphNode[] = [];
  const seenQn = new Set<string>();

  for (const node of candidateNodes) {
    let isEntry = false;

    // True root: nobody calls this function
    if (!calledQnames.has(node.qualifiedName)) {
      isEntry = true;
    }

    // Framework decorator
    if (hasFrameworkDecorator(node)) {
      isEntry = true;
    }

    // Conventional name
    if (matchesEntryName(node)) {
      isEntry = true;
    }

    if (isEntry && !seenQn.has(node.qualifiedName)) {
      entryPoints.push(node);
      seenQn.add(node.qualifiedName);
    }
  }

  return entryPoints;
}

// ═══════════════════════════════════════════════════════════════════════════
// BFS flow tracing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trace a single execution flow via BFS from an entry point.
 * Returns null for trivial single-node flows.
 */
async function traceSingleFlow(
  store: GraphStore,
  ep: GraphNode,
  maxDepth: number = 15,
): Promise<FlowData | null> {
  const pathQnames: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ qn: string; depth: number }> = [];

  // Seed with entry point
  queue.push({ qn: ep.qualifiedName, depth: 0 });
  visited.add(ep.qualifiedName);
  pathQnames.push(ep.qualifiedName);

  let actualDepth = 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > actualDepth) actualDepth = item.depth;
    if (item.depth >= maxDepth) continue;

    // Follow forward CALLS edges
    const edges = await store.getEdgesBySource(item.qn);
    for (const edge of edges) {
      if (edge.kind !== 'CALLS') continue;
      const targetQn = edge.targetQualified;
      if (visited.has(targetQn)) continue;

      // Only follow edges that resolve to known nodes
      const targetNode = await store.getNode(targetQn);
      if (!targetNode) continue;

      visited.add(targetQn);
      pathQnames.push(targetQn);
      queue.push({ qn: targetQn, depth: item.depth + 1 });
    }
  }

  // Skip trivial single-node flows
  if (pathQnames.length < 2) return null;

  // Collect files
  const fileSet = new Set<string>();
  for (const qn of pathQnames) {
    const node = await store.getNode(qn);
    if (node) fileSet.add(node.filePath);
  }
  const files = [...fileSet];

  const flow: FlowData = {
    name: ep.name,
    entryPointQn: ep.qualifiedName,
    depth: actualDepth,
    nodeCount: pathQnames.length,
    fileCount: files.length,
    criticality: 0.0,
    path: pathQnames,
    files,
  };

  // Score criticality
  flow.criticality = await computeScaleCriticality(flow, store);

  return flow;
}

/**
 * Trace execution flows from every detected entry point.
 * Returns flows sorted by criticality (descending).
 *
 * Pre-loads all nodes and edges into memory to avoid O(n²) DB queries.
 */
export async function traceFlows(
  store: GraphStore,
  maxDepth: number = 15,
): Promise<FlowData[]> {
  const entryPoints = await detectEntryPoints(store);

  // ── Pre-load all data into memory for fast BFS ──
  const allNodes = await store.getNodesByKind(['Function', 'Class', 'File']);
  const nodeMap = new Map<string, GraphNode>();
  for (const n of allNodes) nodeMap.set(n.qualifiedName, n);

  const allEdges = await store.getEdgesByKind('CALLS');
  // Build adjacency list: source → [edge, ...]
  const adjacency = new Map<string, GraphEdge[]>();
  for (const e of allEdges) {
    if (!adjacency.has(e.sourceQualified)) adjacency.set(e.sourceQualified, []);
    adjacency.get(e.sourceQualified)!.push(e);
  }

  // Also build a full edge index for criticality scoring
  const allEdgesBySource = new Map<string, GraphEdge[]>();
  // Re-use the CALLS adjacency, but we also need ALL edge kinds for scoring
  const allEdgesAll = await store.getEdgesByKind('CALLS');
  for (const e of allEdgesAll) {
    if (!allEdgesBySource.has(e.sourceQualified)) allEdgesBySource.set(e.sourceQualified, []);
    allEdgesBySource.get(e.sourceQualified)!.push(e);
  }

  const flows: FlowData[] = [];

  for (const ep of entryPoints) {
    const flow = traceSingleFlowInMemory(ep, nodeMap, adjacency, allEdgesBySource, maxDepth);
    if (flow) flows.push(flow);
  }

  // Sort by criticality descending
  flows.sort((a, b) => b.criticality - a.criticality);
  return flows;
}

/**
 * In-memory BFS flow tracing — no DB queries during traversal.
 */
function traceSingleFlowInMemory(
  ep: GraphNode,
  nodeMap: Map<string, GraphNode>,
  adjacency: Map<string, GraphEdge[]>,
  edgesBySource: Map<string, GraphEdge[]>,
  maxDepth: number,
): FlowData | null {
  const pathQnames: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ qn: string; depth: number }> = [];

  queue.push({ qn: ep.qualifiedName, depth: 0 });
  visited.add(ep.qualifiedName);
  pathQnames.push(ep.qualifiedName);

  let actualDepth = 0;

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth > actualDepth) actualDepth = item.depth;
    if (item.depth >= maxDepth) continue;

    const edges = adjacency.get(item.qn) ?? [];
    for (const edge of edges) {
      const targetQn = edge.targetQualified;
      if (visited.has(targetQn)) continue;
      if (!nodeMap.has(targetQn)) continue;

      visited.add(targetQn);
      pathQnames.push(targetQn);
      queue.push({ qn: targetQn, depth: item.depth + 1 });
    }
  }

  if (pathQnames.length < 2) return null;

  const fileSet = new Set<string>();
  for (const qn of pathQnames) {
    const node = nodeMap.get(qn);
    if (node) fileSet.add(node.filePath);
  }
  const files = [...fileSet];

  // ── Criticality scoring (in-memory) ──
  const nodes = pathQnames.map(qn => nodeMap.get(qn)).filter(Boolean) as GraphNode[];

  let dbCalls = 0;
  let maxFanOut = 0;
  let externalCount = 0;

  for (const node of nodes) {
    const edges = edgesBySource.get(node.qualifiedName) ?? [];
    let callCount = 0;
    for (const edge of edges) {
      callCount++;
      const targetName = edge.targetQualified.split('::').pop()?.split('.').pop() ?? '';
      if (DB_KEYWORDS.has(targetName)) dbCalls++;
      if (!nodeMap.has(edge.targetQualified)) externalCount++;
    }
    maxFanOut = Math.max(maxFanOut, callCount);
  }

  const dbRatio = Math.min(dbCalls / 5, 1.0);
  const fanOutRatio = Math.min(maxFanOut / 10, 1.0);
  const fileRatio = Math.min(files.length / 10, 1.0);
  const externalRatio = Math.min(externalCount / 8, 1.0);
  const depthRatio = Math.min(actualDepth / 10, 1.0);

  const criticality = Math.round(
    Math.min(Math.max(
      dbRatio * 0.3 + fanOutRatio * 0.25 + fileRatio * 0.15 +
      externalRatio * 0.15 + depthRatio * 0.15, 0.0), 1.0) * 10000
  ) / 10000;

  return {
    name: ep.name,
    entryPointQn: ep.qualifiedName,
    depth: actualDepth,
    nodeCount: pathQnames.length,
    fileCount: files.length,
    criticality,
    path: pathQnames,
    files,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Scale-focused criticality scoring
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score how critical a flow is from a SCALE / PERFORMANCE perspective.
 * Returns a value between 0.0 and 1.0.
 *
 * Weights:
 *   DB operation density:   0.30  ← N+1 queries are the #1 bottleneck
 *   Fan-out ratio:          0.25  ← catches N+1 and concurrency issues
 *   File spread:            0.15  ← cross-module = harder to optimize
 *   External calls:         0.15  ← network calls = bottleneck at scale
 *   Call depth:             0.15  ← deep chains = latency
 */
export async function computeScaleCriticality(
  flow: FlowData,
  store: GraphStore,
): Promise<number> {
  const pathQnames = flow.path;
  if (pathQnames.length === 0) return 0.0;

  // Resolve all nodes in the flow
  const nodes: GraphNode[] = [];
  for (const qn of pathQnames) {
    const node = await store.getNode(qn);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return 0.0;

  // ── 1. DB operation density ──
  let dbCalls = 0;
  for (const node of nodes) {
    const edges = await store.getEdgesBySource(node.qualifiedName);
    for (const edge of edges) {
      if (edge.kind === 'CALLS') {
        const targetName =
          edge.targetQualified.split('::').pop()?.split('.').pop() ?? '';
        if (DB_KEYWORDS.has(targetName)) {
          dbCalls++;
        }
      }
    }
  }
  const dbRatio = Math.min(dbCalls / 5, 1.0);

  // ── 2. Fan-out ratio (max outgoing calls from any single node) ──
  let maxFanOut = 0;
  for (const node of nodes) {
    const edges = await store.getEdgesBySource(node.qualifiedName);
    const callCount = edges.filter((e) => e.kind === 'CALLS').length;
    maxFanOut = Math.max(maxFanOut, callCount);
  }
  const fanOutRatio = Math.min(maxFanOut / 10, 1.0);

  // ── 3. File spread ──
  const fileRatio = Math.min(flow.fileCount / 10, 1.0);

  // ── 4. External calls (targets not in the graph = library / network) ──
  let externalCount = 0;
  for (const node of nodes) {
    const edges = await store.getEdgesBySource(node.qualifiedName);
    for (const edge of edges) {
      if (edge.kind === 'CALLS') {
        const target = await store.getNode(edge.targetQualified);
        if (!target) externalCount++;
      }
    }
  }
  const externalRatio = Math.min(externalCount / 8, 1.0);

  // ── 5. Call depth ──
  const depthRatio = Math.min(flow.depth / 10, 1.0);

  // ── Weighted sum ──
  const criticality =
    dbRatio * 0.3 +
    fanOutRatio * 0.25 +
    fileRatio * 0.15 +
    externalRatio * 0.15 +
    depthRatio * 0.15;

  // Clamp and round to 4 decimal places
  return Math.round(Math.min(Math.max(criticality, 0.0), 1.0) * 10000) / 10000;
}
