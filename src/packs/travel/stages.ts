// 04 R3：运行时从后台的同一份阶段定义派生，不另写终态或阶段集合。
import { travelStages } from './console-pack.js';

export const runtimeStages = travelStages.map(({ key, ...stage }) => ({
  id: key,
  ...('terminal' in stage ? { terminal: stage.terminal } : {}),
}));
