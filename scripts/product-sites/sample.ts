// 只生成到 gitignored 的运行目录；此样例不代表正式品牌或法律意见。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductPublishInput } from '../../src/shared/product-surface.js';

export function createSample(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  // 合成的单色 1px PNG，只用于证明私有素材输入链；不是正式标识。
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(directory, 'logo.png'), pixel);
  fs.writeFileSync(path.join(directory, 'favicon.png'), pixel);
  fs.writeFileSync(
    path.join(directory, 'privacy.txt'),
    '合成样例，仅供本地验证，不可作为正式政策。\n数据类别包括试用消息、附件、账号与操作记录。AI 处理用于理解询价与组织回复，报价和接手受确定性规则约束。共享试用环境请勿提交个人信息。真实试用消息、客户资料与追踪记录保留七天，合成种子另行管理，手动重置同时清理试用消息和种子。备份按独立周期轮换，删除请求须核验身份，并说明备份到期处理方式。用户可通过试用账号发放时约定的渠道提出访问、更正或删除请求。',
  );
  fs.writeFileSync(
    path.join(directory, 'terms.txt'),
    '合成样例，仅供本地验证，不可作为正式条款。\n本服务协助处理工业询价，用户应确保提交材料具有合法来源，并由授权人员核对规格与报价。共享试用仅提供合成种子及试用者自行提交的消息，不提供自动购买或付款承诺。服务范围以双方确认的实际开通功能为准，外部系统集成和用量展示以发布记录为准。请勿上传个人敏感信息或正式客户资料。软件代码按 MIT 授权，产品名称与标识不在该授权内。服务变更、责任范围、终止与争议处理在正式审定版本中约定。',
  );
  const input: ProductPublishInput = {
    bases: { www: 'https://www.example.test', app: 'https://app.example.test', docs: 'https://docs.example.test' },
    logoFile: 'logo.png',
    faviconFile: 'favicon.png',
    legal: { privacyFile: 'privacy.txt', termsFile: 'terms.txt', version: 'synthetic-1', effectiveDate: '2026-10-31' },
    applicationInstructions: '本地合成样例：请通过向你介绍本项目的人申请试用账号。账号按需发放，不自动领取。',
    sourceRepositoryUrl: 'https://source.example.test/project',
  };
  const filename = path.join(directory, 'publish.json');
  fs.writeFileSync(filename, JSON.stringify(input, null, 2));
  return filename;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSample(process.argv[2] ?? 'var/product-sites/sample');
  console.log('合成发布输入已生成；仅用于本地和自测');
}
