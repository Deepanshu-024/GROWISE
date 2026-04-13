/**
 * Build the code knowledge graph for a repository.
 *
 * Fetches source files from GitHub via API, parses them with Tree-sitter,
 * stores the structural graph in PostgreSQL, and traces execution flows.
 *
 * Usage (CLI):
 *   npx tsx scale-analyzer/build-graph.ts <repositoryId>
 *
 * Or call programmatically:
 *   import { buildKnowledgeGraph } from './build-graph';
 *   await buildKnowledgeGraph(prisma, repositoryId);
 */

import { CodeParser } from './knowledge-graph/parser';
import { GraphStore } from './knowledge-graph/graph-store';
import { traceFlows } from './knowledge-graph/flows';
import {
  EXTENSION_TO_LANGUAGE,
  SKIP_DIRS,
  SKIP_FILE_PATTERNS,
} from './knowledge-graph/constants';
import * as path from 'path';
import * as crypto from 'crypto';

// ─── Types ───────────────────────────────────────────────────────────────

export interface RepoFile {
  path: string;
  content: string;
}

interface GitHubTreeNode {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

// Maximum file size to fetch (500KB)
const MAX_FILE_SIZE = 500 * 1024;
// How many files to fetch concurrently
const CONCURRENCY = 10;

// ═══════════════════════════════════════════════════════════════════════════
// Main builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the knowledge graph for a repository.
 *
 * @param prisma         PrismaClient instance
 * @param repositoryId   Repository.id (UUID)
 * @param files          Optional array of { path, content } — if not provided,
 *                       fetches from GitHub using the user's access token.
 */
export async function buildKnowledgeGraph(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  repositoryId: string,
  files?: RepoFile[],
): Promise<void> {
  try {
    // Mark as building
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { graphStatus: 'building' },
    });

    const store = new GraphStore(prisma, repositoryId);

    // Clear existing graph data
    await store.clearAllData();

    // Get files from parameter or fetch from GitHub
    let repoFiles: RepoFile[];
    if (files && files.length > 0) {
      repoFiles = files;
    } else {
      repoFiles = await fetchFilesFromGitHub(prisma, repositoryId);
    }

    // Filter to supported files
    const supportedFiles = repoFiles.filter((f) => {
      const ext = path.extname(f.path).toLowerCase();
      if (!EXTENSION_TO_LANGUAGE[ext]) return false;

      // Skip files in excluded directories
      const parts = f.path.split('/');
      if (parts.some((p) => SKIP_DIRS.has(p))) return false;

      // Skip test/config/story files
      if (SKIP_FILE_PATTERNS.some((pat) => pat.test(f.path))) return false;

      return true;
    });

    console.log(
      `[KnowledgeGraph] Parsing ${supportedFiles.length} files ` +
      `for repository ${repositoryId}`,
    );

    if (supportedFiles.length === 0) {
      console.warn('[KnowledgeGraph] No supported files found to parse!');
      await prisma.repository.update({
        where: { id: repositoryId },
        data: {
          graphStatus: 'ready',
          graphBuiltAt: new Date(),
        },
      });
      return;
    }

    // Build the set of known file paths for import resolution
    const knownFiles = new Set(supportedFiles.map((f) => f.path));
    const parser = new CodeParser(knownFiles);

    // Parse all files
    let totalNodes = 0;
    let totalEdges = 0;

    for (const file of supportedFiles) {
      try {
        const { nodes, edges } = await parser.parseSource(file.path, file.content);
        const fileHash = crypto
          .createHash('sha256')
          .update(file.content)
          .digest('hex');
        await store.storeFileNodesEdges(file.path, nodes, edges, fileHash);
        totalNodes += nodes.length;
        totalEdges += edges.length;
      } catch (err) {
        console.error(`[KnowledgeGraph] Error parsing ${file.path}:`, err);
      }
    }

    console.log(
      `[KnowledgeGraph] Parsed: ${totalNodes} nodes, ${totalEdges} edges`,
    );

    // ── Diagnostics: what kinds of nodes/edges did we produce? ──
    const diagStats = await store.getStats();
    console.log('[KnowledgeGraph] Node kinds:', JSON.stringify(diagStats.nodesByKind));
    console.log('[KnowledgeGraph] Edge kinds:', JSON.stringify(diagStats.edgesByKind));

    // Trace flows
    console.log('[KnowledgeGraph] Tracing execution flows...');
    const { detectEntryPoints } = await import('./knowledge-graph/flows');
    const entryPoints = await detectEntryPoints(store);
    console.log(`[KnowledgeGraph] Detected ${entryPoints.length} entry points`);
    if (entryPoints.length > 0) {
      console.log('[KnowledgeGraph] First 5 entry points:', entryPoints.slice(0, 5).map(ep => `${ep.name} (${ep.qualifiedName})`));
    }

    const flows = await traceFlows(store);
    console.log(`[KnowledgeGraph] traceFlows returned ${flows.length} flows`);
    if (flows.length > 0) {
      console.log('[KnowledgeGraph] Top flow:', JSON.stringify(flows[0], null, 2));
    }
    const flowCount = await store.storeFlows(flows);
    console.log(`[KnowledgeGraph] Traced ${flowCount} flows`);

    // Print stats
    const stats = await store.getStats();
    console.log('[KnowledgeGraph] Stats:', JSON.stringify(stats, null, 2));

    // Mark as ready
    await prisma.repository.update({
      where: { id: repositoryId },
      data: {
        graphStatus: 'ready',
        graphBuiltAt: new Date(),
      },
    });

    console.log('[KnowledgeGraph] Build complete!');
  } catch (error) {
    console.error('[KnowledgeGraph] Build failed:', error);
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { graphStatus: 'failed' },
    });
    throw error;
  }
}

// ─── GitHub file fetching ──────────────────────────────────────────────

/**
 * Fetch all source files from GitHub for a repository.
 *
 * 1. Gets the user's GitHub access token (OAuth or installation token)
 * 2. Fetches the full repo tree via git/trees?recursive=1
 * 3. Filters to supported extensions (.ts, .tsx, .js, .jsx)
 * 4. Fetches file contents in parallel (batched for rate limits)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchFilesFromGitHub(prisma: any, repositoryId: string): Promise<RepoFile[]> {
  // Fetch repo + user data
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: {
      user: {
        select: {
          githubAccessToken: true,
          githubInstallationId: true,
        },
      },
    },
  });

  if (!repo) {
    throw new Error(`Repository ${repositoryId} not found`);
  }

  // Resolve access token
  let accessToken = repo.user?.githubAccessToken ?? '';

  if (!accessToken && repo.user?.githubInstallationId) {
    console.log('[KnowledgeGraph] No OAuth token, generating installation token...');
    const { generateInstallationToken } = await import('../src/lib/github');
    const { token } = await generateInstallationToken(repo.user.githubInstallationId);
    accessToken = token;
  }

  if (!accessToken) {
    throw new Error(
      'No GitHub access token available. The user must connect GitHub first.',
    );
  }

  const fullName = repo.fullName;    // e.g. "Deepanshu-024/PERLE"
  const branch = repo.defaultBranch ?? 'main';

  console.log(`[KnowledgeGraph] Fetching tree for ${fullName}@${branch}...`);

  // ── Step 1: Fetch full repo tree ──
  let treeNodes: GitHubTreeNode[] = [];

  const treeUrl = `https://api.github.com/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  let treeRes = await fetch(treeUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'KnowledgeGraph-Builder',
    },
  });

  // Fallback: try 'master' if 'main' 404s
  if (!treeRes.ok && treeRes.status === 404 && branch === 'main') {
    const masterUrl = `https://api.github.com/repos/${fullName}/git/trees/master?recursive=1`;
    treeRes = await fetch(masterUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'KnowledgeGraph-Builder',
      },
    });
  }

  if (!treeRes.ok) {
    throw new Error(
      `Failed to fetch repository tree: ${treeRes.status} ${treeRes.statusText}`,
    );
  }

  const treeData = await treeRes.json();
  treeNodes = (treeData.tree ?? []) as GitHubTreeNode[];

  console.log(`[KnowledgeGraph] Tree has ${treeNodes.length} entries`);

  // ── Step 2: Filter to supported source files ──
  const sourceFiles = treeNodes.filter((node) => {
    if (node.type !== 'blob') return false;

    const ext = path.extname(node.path).toLowerCase();
    if (!EXTENSION_TO_LANGUAGE[ext]) return false;

    // Skip excluded dirs
    const parts = node.path.split('/');
    if (parts.some((p) => SKIP_DIRS.has(p))) return false;

    // Skip test/config/story files
    if (SKIP_FILE_PATTERNS.some((pat) => pat.test(node.path))) return false;

    // Skip oversized files
    if (node.size && node.size > MAX_FILE_SIZE) return false;

    return true;
  });

  console.log(
    `[KnowledgeGraph] Found ${sourceFiles.length} source files to fetch`,
  );

  // ── Step 3: Fetch file contents in batches ──
  const repoFiles: RepoFile[] = [];

  for (let i = 0; i < sourceFiles.length; i += CONCURRENCY) {
    const batch = sourceFiles.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (node) => {
        const fileUrl = `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(node.path)}?ref=${encodeURIComponent(branch)}`;
        const res = await fetch(fileUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github.v3.raw',
            'User-Agent': 'KnowledgeGraph-Builder',
          },
        });

        if (!res.ok) {
          console.warn(`[KnowledgeGraph] Failed to fetch ${node.path}: ${res.status}`);
          return null;
        }

        const content = await res.text();
        if (content.length > MAX_FILE_SIZE) return null;

        return { path: node.path, content };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        repoFiles.push(result.value);
      }
    }

    // Log progress
    const done = Math.min(i + CONCURRENCY, sourceFiles.length);
    if (done % 50 === 0 || done === sourceFiles.length) {
      console.log(
        `[KnowledgeGraph] Fetched ${done}/${sourceFiles.length} files`,
      );
    }
  }

  console.log(
    `[KnowledgeGraph] Successfully fetched ${repoFiles.length} files`,
  );
  return repoFiles;
}

// ─── CLI entry point ───────────────────────────────────────────────────

const isCLI =
  typeof require !== 'undefined' &&
  require.main === module;

if (isCLI) {
  const repositoryId = process.argv[2];
  if (!repositoryId) {
    console.error('Usage: npx tsx scale-analyzer/build-graph.ts <repositoryId>');
    process.exit(1);
  }

  // Dynamic import of prisma (avoids top-level import issues)
  import('../src/lib/prisma')
    .then(({ default: prisma }) => buildKnowledgeGraph(prisma, repositoryId))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
