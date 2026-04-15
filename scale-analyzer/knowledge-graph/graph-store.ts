/**
 * Prisma-backed storage for the code knowledge graph.
 * All operations are scoped by repositoryId.
 *
 * Adapted from reference graph.py — uses PostgreSQL via Prisma
 * instead of SQLite for production multi-user persistence.
 */

import type { NodeInfo, EdgeInfo } from './parser';

// ─── Query result types ─────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  repositoryId: string;
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
  fileHash: string | null;
  extra: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  repositoryId: string;
  kind: string;
  sourceQualified: string;
  targetQualified: string;
  filePath: string;
  line: number;
}

export interface GraphStats {
  totalNodes: number;
  totalEdges: number;
  totalFlows: number;
  nodesByKind: Record<string, number>;
  edgesByKind: Record<string, number>;
  languages: string[];
  filesCount: number;
}

export interface FlowData {
  name: string;
  entryPointQn: string;
  depth: number;
  nodeCount: number;
  fileCount: number;
  criticality: number;
  dbCallCount: number;  // total DB-touching calls across the entire BFS flow
  hasN1Risk: boolean;   // true if any node has fan-out>2 AND ≥1 DB call
  path: string[];       // ordered qualified names
  files: string[];      // distinct files touched
}

// ═══════════════════════════════════════════════════════════════════════════
// GraphStore
// ═══════════════════════════════════════════════════════════════════════════

export class GraphStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private prisma: any;
  private repositoryId: string;

  /**
   * @param prisma  PrismaClient instance (typed as any to avoid
   *                coupling to a specific generated client)
   * @param repositoryId  Repository.id (internal UUID)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(prisma: any, repositoryId: string) {
    this.prisma = prisma;
    this.repositoryId = repositoryId;
  }

  // ─── Write operations ──────────────────────────────────────────────────

  /**
   * Atomically replace all graph data for a single source file.
   * Deletes existing nodes/edges for the file, then bulk-inserts new ones.
   * Uses a Prisma transaction for atomicity (mirrors reference graph.py l.235-250).
   */
  async storeFileNodesEdges(
    filePath: string,
    nodes: NodeInfo[],
    edges: EdgeInfo[],
    fileHash?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      // 1. Delete existing data for this file
      await tx.codeEdge.deleteMany({
        where: { repositoryId: this.repositoryId, filePath },
      });
      await tx.codeNode.deleteMany({
        where: { repositoryId: this.repositoryId, filePath },
      });

      // 2. Insert nodes via upsert (handles cross-file qualified name collisions)
      for (const node of nodes) {
        const qualifiedName =
          node.kind === 'File'
            ? node.filePath
            : this.makeQualified(node);

        await tx.codeNode.upsert({
          where: {
            repositoryId_qualifiedName: {
              repositoryId: this.repositoryId,
              qualifiedName,
            },
          },
          create: {
            repositoryId: this.repositoryId,
            kind: node.kind,
            name: node.name,
            qualifiedName,
            filePath: node.filePath,
            lineStart: node.lineStart,
            lineEnd: node.lineEnd,
            language: node.language,
            parentName: node.parentName ?? null,
            params: node.params ?? null,
            returnType: node.returnType ?? null,
            fileHash: fileHash ?? null,
            extra: node.extra ?? {},
          },
          update: {
            kind: node.kind,
            name: node.name,
            filePath: node.filePath,
            lineStart: node.lineStart,
            lineEnd: node.lineEnd,
            language: node.language,
            parentName: node.parentName ?? null,
            params: node.params ?? null,
            returnType: node.returnType ?? null,
            fileHash: fileHash ?? null,
            extra: node.extra ?? {},
          },
        });
      }

      // 3. Bulk-insert edges
      if (edges.length > 0) {
        await tx.codeEdge.createMany({
          data: edges.map((edge) => ({
            repositoryId: this.repositoryId,
            kind: edge.kind,
            sourceQualified: edge.source,
            targetQualified: edge.target,
            filePath: edge.filePath,
            line: edge.line,
          })),
        });
      }
    }, { timeout: 30000 }); // 30s timeout for large files
  }

  /** Remove all nodes and edges for a file. */
  async removeFileData(filePath: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.codeEdge.deleteMany({
        where: { repositoryId: this.repositoryId, filePath },
      }),
      this.prisma.codeNode.deleteMany({
        where: { repositoryId: this.repositoryId, filePath },
      }),
    ]);
  }

  /** Clear ALL graph data for this repository. */
  async clearAllData(): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.codeFlow.deleteMany({
        where: { repositoryId: this.repositoryId },
      }),
      this.prisma.codeEdge.deleteMany({
        where: { repositoryId: this.repositoryId },
      }),
      this.prisma.codeNode.deleteMany({
        where: { repositoryId: this.repositoryId },
      }),
    ]);
  }

  // ─── Node queries ──────────────────────────────────────────────────────

  async getNode(qualifiedName: string): Promise<GraphNode | null> {
    return this.prisma.codeNode.findUnique({
      where: {
        repositoryId_qualifiedName: {
          repositoryId: this.repositoryId,
          qualifiedName,
        },
      },
    });
  }

  async getNodeById(id: string): Promise<GraphNode | null> {
    return this.prisma.codeNode.findUnique({ where: { id } });
  }

  async getNodesByFile(filePath: string): Promise<GraphNode[]> {
    return this.prisma.codeNode.findMany({
      where: { repositoryId: this.repositoryId, filePath },
    });
  }

  async getNodesByKind(kinds: string[]): Promise<GraphNode[]> {
    return this.prisma.codeNode.findMany({
      where: {
        repositoryId: this.repositoryId,
        kind: { in: kinds },
      },
    });
  }

  /** Fuzzy search nodes by name or qualified name. */
  async searchNodes(query: string, limit: number = 20): Promise<GraphNode[]> {
    return this.prisma.codeNode.findMany({
      where: {
        repositoryId: this.repositoryId,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { qualifiedName: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: limit,
    });
  }

  // ─── Edge queries ──────────────────────────────────────────────────────

  async getEdgesBySource(qualifiedName: string): Promise<GraphEdge[]> {
    return this.prisma.codeEdge.findMany({
      where: {
        repositoryId: this.repositoryId,
        sourceQualified: qualifiedName,
      },
    });
  }

  async getEdgesByTarget(qualifiedName: string): Promise<GraphEdge[]> {
    return this.prisma.codeEdge.findMany({
      where: {
        repositoryId: this.repositoryId,
        targetQualified: qualifiedName,
      },
    });
  }

  async getEdgesByKind(kind: string): Promise<GraphEdge[]> {
    return this.prisma.codeEdge.findMany({
      where: {
        repositoryId: this.repositoryId,
        kind,
      },
    });
  }

  /** Get all qualified names that are CALLS targets (used for entry-point detection). */
  async getAllCallTargets(): Promise<Set<string>> {
    const rows = await this.prisma.codeEdge.findMany({
      where: {
        repositoryId: this.repositoryId,
        kind: 'CALLS',
      },
      select: { targetQualified: true },
      distinct: ['targetQualified'],
    });
    return new Set(rows.map((r: { targetQualified: string }) => r.targetQualified));
  }

  // ─── Stats ─────────────────────────────────────────────────────────────

  async getStats(): Promise<GraphStats> {
    const [totalNodes, totalEdges, totalFlows] = await Promise.all([
      this.prisma.codeNode.count({ where: { repositoryId: this.repositoryId } }),
      this.prisma.codeEdge.count({ where: { repositoryId: this.repositoryId } }),
      this.prisma.codeFlow.count({ where: { repositoryId: this.repositoryId } }),
    ]);

    const [nodesByKindRaw, edgesByKindRaw, languagesRaw] = await Promise.all([
      this.prisma.codeNode.groupBy({
        by: ['kind'],
        where: { repositoryId: this.repositoryId },
        _count: true,
      }),
      this.prisma.codeEdge.groupBy({
        by: ['kind'],
        where: { repositoryId: this.repositoryId },
        _count: true,
      }),
      this.prisma.codeNode.findMany({
        where: {
          repositoryId: this.repositoryId,
          language: { not: null },
        },
        select: { language: true },
        distinct: ['language'],
      }),
    ]);

    const nodesByKind: Record<string, number> = {};
    for (const row of nodesByKindRaw) {
      nodesByKind[row.kind] = row._count;
    }

    const edgesByKind: Record<string, number> = {};
    for (const row of edgesByKindRaw) {
      edgesByKind[row.kind] = row._count;
    }

    return {
      totalNodes,
      totalEdges,
      totalFlows,
      nodesByKind,
      edgesByKind,
      languages: languagesRaw.map((r: any) => r.language).filter(Boolean),
      filesCount: nodesByKind['File'] ?? 0,
    };
  }

  // ─── Flow storage ─────────────────────────────────────────────────────

  /** Clear existing flows and store new ones. */
  async storeFlows(flows: FlowData[]): Promise<number> {
    await this.prisma.codeFlow.deleteMany({
      where: { repositoryId: this.repositoryId },
    });

    if (flows.length === 0) return 0;

    await this.prisma.codeFlow.createMany({
      data: flows.map((flow) => ({
        repositoryId: this.repositoryId,
        name: flow.name,
        entryPointQn: flow.entryPointQn,
        depth: flow.depth,
        nodeCount: flow.nodeCount,
        fileCount: flow.fileCount,
        criticality: flow.criticality,
        dbCallCount: flow.dbCallCount,
        hasN1Risk: flow.hasN1Risk,
        pathJson: flow.path,
        filesJson: flow.files,
      })),
    });

    return flows.length;
  }

  /** Get stored flows, sorted by the given column (descending).
   *  @param sortBy  Column to sort by
   *  @param limit   Max rows to return
   *  @param minDbCalls  Only return flows with dbCallCount >= this value.
   *                     0 = no filter (return all). Default 0 — caller decides.
   */
  async getFlows(
    sortBy: 'criticality' | 'depth' | 'nodeCount' | 'dbCallCount' = 'criticality',
    limit: number = 50,
    minDbCalls: number = 0,
  ): Promise<any[]> {
    const where: any = { repositoryId: this.repositoryId };
    if (minDbCalls > 0) {
      where.dbCallCount = { gte: minDbCalls };
    }
    return this.prisma.codeFlow.findMany({
      where,
      orderBy: { [sortBy]: 'desc' },
      take: limit,
    });
  }

  /** Get a single flow by its primary key ID. */
  async getFlowById(id: string): Promise<any | null> {
    return this.prisma.codeFlow.findUnique({
      where: { id },
    });
  }

  /**
   * Search flows by partial name OR entryPointQn match (Postgres ILIKE).
   *
   * Flows are stored with name = bare function name (e.g. "POST") and
   * entryPointQn = full qualified name (e.g. "src/app/api/checkout/route.ts::POST").
   * Agents often pass qualified names, so we search both columns.
   */
  async searchFlowsByName(partialName: string, limit: number = 10): Promise<any[]> {
    return this.prisma.codeFlow.findMany({
      where: {
        repositoryId: this.repositoryId,
        OR: [
          { name: { contains: partialName, mode: 'insensitive' } },
          { entryPointQn: { contains: partialName, mode: 'insensitive' } },
        ],
      },
      orderBy: { criticality: 'desc' },
      take: limit,
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private makeQualified(node: NodeInfo): string {
    if (node.kind === 'File') return node.filePath;
    if (node.parentName) {
      return `${node.filePath}::${node.parentName}.${node.name}`;
    }
    return `${node.filePath}::${node.name}`;
  }
}
