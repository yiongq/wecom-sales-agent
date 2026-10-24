// 08 R8：为纯护栏工厂绑定当前租户包、已发布政策与只读订单能力。
import {
  moneyProvenanceStep as replyStep,
  moneyProvenanceFollowupStep as followupStep,
  type MoneyProvenanceOptions,
  type MoneyProvenanceSources,
} from './guards/money-provenance.js';

async function sources(): Promise<MoneyProvenanceSources> {
  // pack-api 是包的公共出口，不能在模块初始化时反向装配配置/存储及具体包。
  const [{ currentPack, currentPolicy }, { getAnyOrder }] = await Promise.all([import('../config/source.js'), import('../store.js')]);
  return {
    money() {
      const { runtime } = currentPack();
      if (!runtime.money) throw new Error(`行业包 ${runtime.id} 的 money_provenance 缺少 money 解析选项`);
      return runtime.money;
    },
    getOrder: getAnyOrder,
    followupPolicy: () => currentPolicy().policy,
  };
}

export const moneyProvenanceStep = (options: MoneyProvenanceOptions & { fallback: string }) => replyStep(options, sources);
export const moneyProvenanceFollowupStep = (options: MoneyProvenanceOptions) => followupStep(options, sources);
