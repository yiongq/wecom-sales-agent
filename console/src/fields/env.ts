// 渲染器要的外部数据（spec「行业包通用架构」）：当前时刻、引用字段的候选、文字联想、条目地址。
// 由页面（第 9、10 步的产品库，现在是样张页）按行业包和接口数据提供；渲染器自己不发请求、不认具体行业
import { createContext, type ReactNode, useContext } from 'react';
import type { RefItem } from './model.js';

export interface FieldEnv {
  /** 当前时刻：MonthStrip 标出当前月（走查与样张钉住时钟） */
  now: number;
  /** 引用字段的候选：目标实体（FieldDef.to）的条目；还没取到时 undefined */
  refItems(kind: string): readonly RefItem[] | undefined;
  /** text、tags 的联想（suggest: 'distinct'）：本实体各条目在这个字段上已有的值，去重 */
  distinct(key: string): readonly string[];
  /** 引用的名称画成指向条目详情的链接；不给时写成纯文本（详情路由在第 10.1 步，那时由页面给路由的 Link） */
  itemLink?(kind: string, code: string, children: ReactNode): ReactNode;
}

const DEFAULT_ENV: FieldEnv = {
  now: Date.now(),
  refItems: () => undefined,
  distinct: () => [],
};

export const FieldEnvContext = createContext<FieldEnv>(DEFAULT_ENV);

export const useFieldEnv = (): FieldEnv => useContext(FieldEnvContext);
