import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { buildKnowledgeGraph } from "../../../../../scale-analyzer/build-graph";

/**
 * POST /api/agent/graph-test
 * Builds the knowledge graph for a given repository.
 *
 * Body: { repositoryId: string }   (this is the internal UUID – Repository.id)
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId } = body;

        if (!repositoryId) {
            return NextResponse.json(
                { error: "repositoryId is required" },
                { status: 400 }
            );
        }

        const start = Date.now();
        await buildKnowledgeGraph(prisma, repositoryId);
        const elapsed = Date.now() - start;

        // Fetch summary stats
        const [nodeCount, edgeCount, flowCount] = await Promise.all([
            prisma.codeNode.count({ where: { repositoryId } }),
            prisma.codeEdge.count({ where: { repositoryId } }),
            prisma.codeFlow.count({ where: { repositoryId } }),
        ]);

        const nodesByKind = await prisma.codeNode.groupBy({
            by: ["kind"],
            where: { repositoryId },
            _count: true,
        });

        const edgesByKind = await prisma.codeEdge.groupBy({
            by: ["kind"],
            where: { repositoryId },
            _count: true,
        });

        return NextResponse.json({
            success: true,
            executionTimeMs: elapsed,
            stats: {
                nodes: nodeCount,
                edges: edgeCount,
                flows: flowCount,
                nodesByKind: Object.fromEntries(
                    nodesByKind.map((r) => [r.kind, r._count])
                ),
                edgesByKind: Object.fromEntries(
                    edgesByKind.map((r) => [r.kind, r._count])
                ),
            },
        });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/graph-test] Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

/**
 * GET /api/agent/graph-test?repositoryId=xxx&view=nodes|edges|flows|stats
 * Query the knowledge graph for a repository.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const repositoryId = searchParams.get("repositoryId");
        const view = searchParams.get("view") ?? "stats";

        if (!repositoryId) {
            return NextResponse.json(
                { error: "repositoryId query param required" },
                { status: 400 }
            );
        }

        if (view === "stats") {
            const [nodeCount, edgeCount, flowCount] = await Promise.all([
                prisma.codeNode.count({ where: { repositoryId } }),
                prisma.codeEdge.count({ where: { repositoryId } }),
                prisma.codeFlow.count({ where: { repositoryId } }),
            ]);

            const nodesByKind = await prisma.codeNode.groupBy({
                by: ["kind"],
                where: { repositoryId },
                _count: true,
            });

            const edgesByKind = await prisma.codeEdge.groupBy({
                by: ["kind"],
                where: { repositoryId },
                _count: true,
            });

            const languages = await prisma.codeNode.findMany({
                where: { repositoryId, language: { not: null } },
                select: { language: true },
                distinct: ["language"],
            });

            const repo = await prisma.repository.findUnique({
                where: { id: repositoryId },
                select: { graphStatus: true, graphBuiltAt: true },
            });

            return NextResponse.json({
                graphStatus: repo?.graphStatus ?? null,
                graphBuiltAt: repo?.graphBuiltAt ?? null,
                stats: {
                    nodes: nodeCount,
                    edges: edgeCount,
                    flows: flowCount,
                    nodesByKind: Object.fromEntries(
                        nodesByKind.map((r) => [r.kind, r._count])
                    ),
                    edgesByKind: Object.fromEntries(
                        edgesByKind.map((r) => [r.kind, r._count])
                    ),
                    languages: languages
                        .map((l) => l.language)
                        .filter(Boolean),
                },
            });
        }

        if (view === "nodes") {
            const kind = searchParams.get("kind");
            const search = searchParams.get("search");
            const limit = parseInt(searchParams.get("limit") ?? "100", 10);

            const where: any = { repositoryId };
            if (kind) where.kind = kind;
            if (search) {
                where.OR = [
                    { name: { contains: search, mode: "insensitive" } },
                    {
                        qualifiedName: {
                            contains: search,
                            mode: "insensitive",
                        },
                    },
                ];
            }

            const nodes = await prisma.codeNode.findMany({
                where,
                take: limit,
                orderBy: { name: "asc" },
                select: {
                    id: true,
                    kind: true,
                    name: true,
                    qualifiedName: true,
                    filePath: true,
                    lineStart: true,
                    lineEnd: true,
                    language: true,
                    parentName: true,
                    params: true,
                    returnType: true,
                },
            });

            return NextResponse.json({ nodes, count: nodes.length });
        }

        if (view === "edges") {
            const kind = searchParams.get("kind");
            const source = searchParams.get("source");
            const target = searchParams.get("target");
            const limit = parseInt(searchParams.get("limit") ?? "200", 10);

            const where: any = { repositoryId };
            if (kind) where.kind = kind;
            if (source)
                where.sourceQualified = {
                    contains: source,
                    mode: "insensitive",
                };
            if (target)
                where.targetQualified = {
                    contains: target,
                    mode: "insensitive",
                };

            const edges = await prisma.codeEdge.findMany({
                where,
                take: limit,
                orderBy: { createdAt: "desc" },
                select: {
                    id: true,
                    kind: true,
                    sourceQualified: true,
                    targetQualified: true,
                    filePath: true,
                    line: true,
                },
            });

            return NextResponse.json({ edges, count: edges.length });
        }

        if (view === "flows") {
            const limit = parseInt(searchParams.get("limit") ?? "20", 10);

            const flows = await prisma.codeFlow.findMany({
                where: { repositoryId },
                take: limit,
                orderBy: { criticality: "desc" },
                select: {
                    id: true,
                    name: true,
                    entryPointQn: true,
                    depth: true,
                    nodeCount: true,
                    fileCount: true,
                    criticality: true,
                    pathJson: true,
                    filesJson: true,
                },
            });

            return NextResponse.json({ flows, count: flows.length });
        }

        if (view === "callchain") {
            const fn = searchParams.get("function");
            if (!fn) {
                return NextResponse.json(
                    { error: "function query param required for callchain view" },
                    { status: 400 }
                );
            }

            // Find the function
            const funcNodes = await prisma.codeNode.findMany({
                where: {
                    repositoryId,
                    kind: "Function",
                    name: { contains: fn, mode: "insensitive" },
                },
                take: 5,
            });

            if (funcNodes.length === 0) {
                return NextResponse.json({
                    chain: [],
                    error: `No function found matching "${fn}"`,
                });
            }

            const entryNode = funcNodes[0];

            // BFS
            const visited = new Set<string>();
            const chain: Array<{
                name: string;
                qualifiedName: string;
                file: string;
                depth: number;
            }> = [];
            const queue: Array<{ qn: string; depth: number }> = [
                { qn: entryNode.qualifiedName, depth: 0 },
            ];
            visited.add(entryNode.qualifiedName);

            while (queue.length > 0) {
                const { qn, depth } = queue.shift()!;
                const node = await prisma.codeNode.findFirst({
                    where: { repositoryId, qualifiedName: qn },
                });
                if (node) {
                    chain.push({
                        name: node.name,
                        qualifiedName: node.qualifiedName,
                        file: node.filePath,
                        depth,
                    });
                }
                if (depth >= 10) continue;

                const edges = await prisma.codeEdge.findMany({
                    where: {
                        repositoryId,
                        sourceQualified: qn,
                        kind: "CALLS",
                    },
                });

                for (const edge of edges) {
                    if (!visited.has(edge.targetQualified)) {
                        const target = await prisma.codeNode.findFirst({
                            where: {
                                repositoryId,
                                qualifiedName: edge.targetQualified,
                            },
                        });
                        if (target) {
                            visited.add(edge.targetQualified);
                            queue.push({
                                qn: edge.targetQualified,
                                depth: depth + 1,
                            });
                        }
                    }
                }
            }

            return NextResponse.json({
                entry: entryNode.qualifiedName,
                chain,
                totalSteps: chain.length,
            });
        }

        if (view === "file-graph") {
            // Fetch all nodes to build file-level summary
            const allNodes = await prisma.codeNode.findMany({
                where: { repositoryId },
                select: {
                    kind: true,
                    name: true,
                    qualifiedName: true,
                    filePath: true,
                    language: true,
                },
            });

            // Build file summaries
            const fileMap = new Map<string, { path: string; functions: string[]; language: string | null }>();
            for (const n of allNodes) {
                if (!fileMap.has(n.filePath)) {
                    fileMap.set(n.filePath, { path: n.filePath, functions: [], language: n.language });
                }
                if (n.kind === "Function") {
                    fileMap.get(n.filePath)!.functions.push(n.name);
                }
            }

            // Build qualified-name → filePath lookup
            const qnToFile = new Map<string, string>();
            for (const n of allNodes) {
                qnToFile.set(n.qualifiedName, n.filePath);
            }

            // Fetch CALLS and IMPORTS_FROM edges, aggregate to file-level
            const allEdges = await prisma.codeEdge.findMany({
                where: { repositoryId, kind: { in: ["CALLS", "IMPORTS_FROM"] } },
                select: {
                    kind: true,
                    sourceQualified: true,
                    targetQualified: true,
                    filePath: true,
                },
            });

            // Aggregate edges: fileA→fileB with count
            const edgeKey = (src: string, tgt: string) => `${src}|||${tgt}`;
            const fileEdgeMap = new Map<string, { source: string; target: string; calls: number; imports: number }>();

            for (const e of allEdges) {
                // Source file comes from the edge's filePath
                const srcFile = e.filePath;
                // Target file: look up from qualifiedName, or extract from qualified name
                let tgtFile = qnToFile.get(e.targetQualified);
                if (!tgtFile) {
                    // For IMPORTS_FROM, the target might be a file path itself
                    const parts = e.targetQualified.split("::");
                    tgtFile = parts[0];
                }
                if (!tgtFile || srcFile === tgtFile) continue; // skip self-edges
                if (!fileMap.has(srcFile) || !fileMap.has(tgtFile)) continue;

                const key = edgeKey(srcFile, tgtFile);
                if (!fileEdgeMap.has(key)) {
                    fileEdgeMap.set(key, { source: srcFile, target: tgtFile, calls: 0, imports: 0 });
                }
                const fe = fileEdgeMap.get(key)!;
                if (e.kind === "CALLS") fe.calls++;
                else if (e.kind === "IMPORTS_FROM") fe.imports++;
            }

            const files = Array.from(fileMap.values()).map(f => ({
                path: f.path,
                functionCount: f.functions.length,
                functions: f.functions.slice(0, 10), // top 10 for display
                language: f.language,
            }));

            const fileEdges = Array.from(fileEdgeMap.values());

            return NextResponse.json({
                files,
                fileEdges,
                totalFiles: files.length,
                totalFileEdges: fileEdges.length,
            });
        }

        return NextResponse.json({ error: "Unknown view" }, { status: 400 });
    } catch (error) {
        const message =
            error instanceof Error ? error.message : "Unknown error";
        console.error("[api/agent/graph-test] GET Error:", message);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
