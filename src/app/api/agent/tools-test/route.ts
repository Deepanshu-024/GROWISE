import { NextRequest, NextResponse } from 'next/server';
import prisma  from '@/lib/prisma';
import { createKnowledgeGraphTools } from '../../../../../scale-analyzer/knowledge-graph/tools';

/**
 * POST /api/agent/tools-test
 * Invoke a single knowledge-graph tool directly for testing.
 *
 * Body: {
 *   repositoryId: string,
 *   toolName: string,
 *   args: Record<string, unknown>,
 * }
 *
 * Returns: {
 *   toolName: string,
 *   args: object,
 *   result: string,      // raw JSON string from the tool
 *   parsed: unknown,     // parsed result (if valid JSON)
 *   executionMs: number,
 *   error?: string,
 * }
 */
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { repositoryId, toolName, args = {} } = body;

        if (!repositoryId) {
            return NextResponse.json({ error: 'repositoryId is required' }, { status: 400 });
        }
        if (!toolName) {
            return NextResponse.json({ error: 'toolName is required' }, { status: 400 });
        }

        // Build all tools for this repository
        const tools = createKnowledgeGraphTools(prisma, repositoryId);
        const tool = tools.find((t) => t.name === toolName);

        if (!tool) {
            const available = tools.map((t) => t.name);
            return NextResponse.json({
                error: `Unknown tool "${toolName}"`,
                availableTools: available,
            }, { status: 400 });
        }

        const startMs = Date.now();
        let rawResult: string;
        try {
            // LangChain tools expose .invoke() which returns a string
            rawResult = await (tool as any).invoke(args);
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

        // Try to parse as JSON for easier frontend display
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(rawResult);
        } catch {
            parsed = rawResult; // plain string result
        }

        return NextResponse.json({
            toolName,
            args,
            result: rawResult,
            parsed,
            executionMs,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}

/**
 * GET /api/agent/tools-test?repositoryId=...
 * Returns the list of available tools and their schemas.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const repositoryId = searchParams.get('repositoryId');

        if (!repositoryId) {
            return NextResponse.json({ error: 'repositoryId is required' }, { status: 400 });
        }

        const tools = createKnowledgeGraphTools(prisma, repositoryId);
        const toolMeta = tools.map((t: any) => ({
            name: t.name,
            description: t.description,
            schema: t.schema?._def ?? null,
        }));

        return NextResponse.json({ tools: toolMeta, total: toolMeta.length });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
