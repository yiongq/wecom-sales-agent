// 组合根需要的能力：调用时读取配置、存储与支付模式，模块装载时不装配包。
import type { PackSources } from '../pack-api.js';
import { erpSources } from '../../connectors/registry.js';
import {
  catalogItemAt,
  catalogVersionKey,
  configMode,
  currentCatalog,
  currentPolicy,
  ConfigNotReadyError,
  installRuntimeSources,
} from '../../config/source.js';
import { indexReady, semanticRecall } from '../retrieval.js';
import { createOrder, getOrder, queueJobs, saveSession, supersedeOrder } from '../../store.js';
import { todayIso } from '../../env.js';
import { paymentMode } from '../../payment/mode.js';
import { orderUnconfirmedNotifyOps } from '../../jobs/notify.js';
import { enterHandoff, HANDOFF_REASON, isTerminalStage } from '../../handoff/record.js';

export function packSources(): PackSources {
  return {
    erp: {
      active: (...args) => erpSources.active(...args),
      availability: (...args) => erpSources.availability(...args),
      fresh: (...args) => erpSources.fresh(...args),
    },
    modelHandoffReason: HANDOFF_REASON.model,
    handoffReasons: HANDOFF_REASON,
    catalogItemAt,
    catalogVersionKey,
    configMode,
    currentCatalog,
    currentPolicy,
    indexReady,
    semanticRecall,
    createOrder,
    getOrder,
    queueJobs,
    saveSession,
    supersedeOrder,
    todayIso,
    paymentMode,
    orderUnconfirmedNotifyOps,
    enterHandoff,
    isTerminalStage,
    isConfigNotReadyError: (error) => error instanceof ConfigNotReadyError,
  };
}

installRuntimeSources(packSources());
