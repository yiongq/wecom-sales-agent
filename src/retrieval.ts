import './core/engine/sources.js';
// R1：旧检索入口只转发通用运行时。
export {
  embedCfg,
  buildIndex,
  invalidateIndex,
  indexHealth,
  __retrievalTest,
  indexReady,
  semanticRecall,
  type IndexHealth,
} from './core/retrieval.js';
