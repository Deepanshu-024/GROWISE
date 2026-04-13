/**
 * Knowledge Graph — barrel exports.
 */

export { CodeParser, type NodeInfo, type EdgeInfo } from './parser';
export {
  GraphStore,
  type GraphNode,
  type GraphEdge,
  type GraphStats,
  type FlowData,
} from './graph-store';
export { detectEntryPoints, traceFlows, computeScaleCriticality } from './flows';
export { createKnowledgeGraphTools } from './tools';
export {
  EXTENSION_TO_LANGUAGE,
  BUILTIN_CALL_NAMES,
  DB_KEYWORDS,
  SKIP_DIRS,
  SKIP_FILE_PATTERNS,
} from './constants';
