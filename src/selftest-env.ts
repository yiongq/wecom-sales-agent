// 六组自测和 eval 的第一个 import：把部署 profile 钉成 demo（00 spec「部署 profile 与开关 · 测试隔离」）。
// env.ts 会用本机 .env 补上缺失的变量，本机 .env 里写着 DEPLOY_PROFILE=prod 或 FLAG_* 时，自测就跑在别的 profile 下。
// 设成空串而不是删掉：env.ts 只补「不存在」的变量，空串挡得住 .env 里的值，而 profile.ts 把空串当未设置。
// 要测 prod 的用例用 __profileTest.use 切换，结束时调 reset()。
import { PROFILE_ENV_NAMES } from './profile.js';

for (const k of PROFILE_ENV_NAMES) process.env[k] = '';
process.env.DEPLOY_PROFILE = 'demo';
