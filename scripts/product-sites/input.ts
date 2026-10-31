import fs from 'node:fs';
import path from 'node:path';
import type { ProductPublishInput } from '../../src/shared/product-surface.js';

export function readPublishInput(filename: string): ProductPublishInput {
  const fail = (): never => {
    throw new Error('发布输入不完整或格式无效；请检查品牌、HTTPS 地址、申请说明及法律版本材料');
  };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return fail();
  }
  const input = raw as ProductPublishInput;
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const https = (value: unknown): value is string => {
    if (!text(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  };
  if (!input || !input.bases || !input.legal || !['www', 'app', 'docs'].every((key) => https(input.bases[key as keyof typeof input.bases])))
    fail();
  if (
    new Set(Object.values(input.bases).map((base) => new URL(base).origin)).size !== 3 ||
    Object.values(input.bases).some((base) => new URL(base).pathname !== '/')
  )
    fail();
  if (
    !https(input.sourceRepositoryUrl) ||
    !text(input.applicationInstructions) ||
    !text(input.legal.version) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.legal.effectiveDate ?? '')
  )
    fail();
  if (
    Number.isNaN(Date.parse(input.legal.effectiveDate)) ||
    new Date(input.legal.effectiveDate).toISOString().slice(0, 10) !== input.legal.effectiveDate
  )
    fail();
  const resolveFile = (value: unknown, extensions: string[]): string => {
    if (!text(value) || !extensions.includes(path.extname(value).toLowerCase())) return fail();
    const resolved = path.resolve(path.dirname(filename), value);
    try {
      if (!fs.statSync(resolved).isFile() || fs.statSync(resolved).size === 0) fail();
    } catch {
      return fail();
    }
    return resolved;
  };
  input.logoFile = resolveFile(input.logoFile, ['.png', '.webp']);
  input.faviconFile = resolveFile(input.faviconFile, ['.png', '.ico']);
  input.legal.privacyFile = resolveFile(input.legal.privacyFile, ['.txt']);
  input.legal.termsFile = resolveFile(input.legal.termsFile, ['.txt']);
  for (const file of [input.legal.privacyFile, input.legal.termsFile]) {
    const body = fs.readFileSync(file, 'utf8');
    if (body.trim().length < 80 || /\{\{|待填写|待审定|TODO|PLACEHOLDER/i.test(body)) fail();
  }
  return input;
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const baseUrl = (base: string, relative = ''): string => new URL(relative, `${base.replace(/\/$/, '')}/`).href;
