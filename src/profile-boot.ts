// 只有副作用：解析部署 profile，用一行日志打出 profile 名和六个开关的生效值。
// server.ts 在 import './env.js' 之后紧接着 import 它：store.ts 在模块加载时就会读 profile()（保鲜），
// 配置错了要在这里先打一行原因再退出，而不是在 import 链里抛出异常栈。启动失败会被部署的健康检查拦下并回滚。
import { profile, ProfileConfigError } from './profile.js';

try {
  const p = profile();
  // prod 没有匿名只读：没配密码的后台什么都看不到，也接管不了会话，这样的实例不如不起
  if (p.name === 'prod' && !process.env.ADMIN_PASS) throw new ProfileConfigError('prod 必须配置 ADMIN_PASS');
  const flags = Object.entries(p.flags).map(([k, v]) => `${k}=${typeof v === 'boolean' ? (v ? 'on' : 'off') : v}`);
  console.log(`[profile] ${p.name} · ${flags.join(' ')}`);
} catch (e) {
  if (!(e instanceof ProfileConfigError)) throw e;
  console.error(`[profile] 配置错误，拒绝启动：${e.message}`);
  process.exit(1);
}
