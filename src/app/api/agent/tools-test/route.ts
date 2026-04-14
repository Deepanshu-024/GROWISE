import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { createKnowledgeGraphTools } from '../../../../../scale-analyzer/knowledge-graph/tools';
import {
    getRepoTreeTool,
    getFileContentTool,
    searchCodeTool,
    getCodeBlockTool,
} from '../../../../../actions/analysis/tools/agent-tools';

/**
 * POST /api/agent/tools-test
 * Invoke a single knowledge-graph OR GitHub tool directly for testing.
 *
 * Body: {
 *   repositoryId?: string,   // required for graph tools; not needed for github tools
 *   toolName: string,
 *   args: Record<string, unknown>,
 *   // GitHub tools need: owner, repo, branch, accessToken inside args
 * }
 */

// ─── Static registry of GitHub tools (no repositoryId needed) ───────────────

const GITHUB_TOOLS: any[] = [
    getRepoTreeTool,
    getFileContentTool,
    searchCodeTool,
    getCodeBlockTool,
];

// ─── POST — invoke a tool ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, toolName, args = {} } = body;

        if (!toolName) {
            return NextResponse.json({ error: 'toolName is required' }, { status: 400 });
        }

        // 1️⃣ Try GitHub tools first (no repositoryId required)
        const githubTool = GITHUB_TOOLS.find((t) => t.name === toolName);
        if (githubTool) {
            const startMs = Date.now();
            let rawResult: string;
            try {
                rawResult = await githubTool.invoke(args);
            } catch (invokeErr) {
                const msg = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
                return NextResponse.json({
                    toolName,
                    args,
                    result: null,
                    parsed: null,
                    executionMs: Date.now() - startMs,
                    error: msg,
                });
            }
            const executionMs = Date.now() - startMs;
            let parsed: unknown = rawResult;
            try { parsed = JSON.parse(rawResult); } catch { /* keep as string */ }
            return NextResponse.json({ toolName, args, result: rawResult, parsed, executionMs });
        }

        // 2️⃣ Graph tools — require repositoryId
        if (!repositoryId) {
            return NextResponse.json(
                { error: 'repositoryId is required for graph tools' },
                { status: 400 },
            );
        }

        const graphTools = createKnowledgeGraphTools(prisma, repositoryId);
        const graphTool = graphTools.find((t) => t.name === toolName);

        if (!graphTool) {
            return NextResponse.json({
                error: `Unknown tool "${toolName}"`,
                availableTools: [
                    ...graphTools.map((t) => t.name),
                    ...GITHUB_TOOLS.map((t) => t.name),
                ],
            }, { status: 400 });
        }

        const startMs = Date.now();
        let rawResult: string;
        try {
            rawResult = await (graphTool as any).invoke(args);
        } catch (invokeErr) {
            const msg = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
            return NextResponse.json({
                toolName,
                args,
                result: null,
                parsed: null,
                executionMs: Date.now() - startMs,
                error: msg,
            });
        }

        const executionMs = Date.now() - startMs;
        let parsed: unknown = rawResult;
        try { parsed = JSON.parse(rawResult); } catch { /* keep as string */ }

        return NextResponse.json({ toolName, args, result: rawResult, parsed, executionMs });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

// ─── GET — list all available tools with schemas ─────────────────────────────

/**
 * GET /api/agent/tools-test?repositoryId=...
 * Returns all available tools with their schemas.
 * repositoryId is optional — when omitted, only GitHub tools are returned.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const repositoryId = searchParams.get('repositoryId');

        const githubToolMeta = GITHUB_TOOLS.map((t: any) => ({
            name: t.name,
            description: t.description,
            schema: t.schema?._def ?? null,
            category: 'github',
        }));

        let graphToolMeta: any[] = [];
        if (repositoryId) {
            const graphTools = createKnowledgeGraphTools(prisma, repositoryId);
            graphToolMeta = graphTools.map((t: any) => ({
                name: t.name,
                description: t.description,
                schema: t.schema?._def ?? null,
                category: 'graph',
            }));
        }

        const allTools = [...graphToolMeta, ...githubToolMeta];
        return NextResponse.json({ tools: allTools, total: allTools.length });

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
