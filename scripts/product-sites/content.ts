import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_GUIDES } from '../../src/shared/product-surface.js';

export const GUIDE_TITLES = ['快速开始', '绑定企业微信', '产品库', '销售话术', '常见问题', '更新日志'] as const;
export function guideHref(file: string): string {
  return file === 'quick-start.md' ? '/' : `/${file.replace(/\.md$/, '.html')}`;
}

/** 不接受 include、HTML、组件或任意资源路径；唯一来源是六份完整的使用者正文。 */
export function stageGuides(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const sourceRoot = fs.realpathSync(source);
  for (const file of PUBLIC_GUIDES) {
    const filename = path.join(source, file);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(filename)) !== sourceRoot)
      throw new Error(`非白名单文件：${file}`);
    const body = fs.readFileSync(filename, 'utf8');
    if (
      !body.startsWith('# ') ||
      /<|!\[|\{\{|^---|^\s*(?:import|export)\s|\b(?:spec|plan)\.md|docs\/(?:architecture|features)|\bADR-\d|deployment\.md|observability\.md|\.env/im.test(
        body,
      )
    )
      throw new Error(`指南含不允许的扩展或内部材料：${file}`);
    for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
      const [target] = match[1]!.split('#');
      if (target && !PUBLIC_GUIDES.includes(target.replace(/^\.\//, '') as (typeof PUBLIC_GUIDES)[number]))
        throw new Error(`指南链接不在白名单：${file}`);
    }
    fs.writeFileSync(path.join(destination, file), body.replace(/\]\(\.\/quick-start\.md(?=[)#])/g, '](/'));
  }
  if (fs.readdirSync(destination).toSorted().join('|') !== [...PUBLIC_GUIDES].toSorted().join('|')) throw new Error('暂存内容不等于白名单');
}
