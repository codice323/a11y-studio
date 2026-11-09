import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './storage';

export type Passage = { id: string; title: string; refs: string[]; url: string; text: string; keywords: string };
const passages = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge/wcag/passages.json'), 'utf8')) as Passage[];

// Map only supported, independently identified issue types to relevant criteria.
// The model's query can refine ranking but cannot redefine the detected issue.
const issueProfiles: Record<string, { hint: string; refs: string[] }> = {
  'image-alt': { hint: '图片 图像 image alt 替代文本', refs: ['1.1.1'] },
  label: { hint: '表单 控件 label 名称 输入', refs: ['3.3.2', '1.3.1', '4.1.2'] },
  'select-name': { hint: '下拉表单 选择 控件 label 名称', refs: ['3.3.2', '1.3.1', '4.1.2'] },
  'button-name': { hint: '按钮 button 名称 可见 标签', refs: ['4.1.2', '2.5.3'] },
  'link-name': { hint: '链接 link 目的 名称', refs: ['2.4.4', '4.1.2'] },
  'aria-broken-idref': { hint: 'aria 名称 角色 值 关联', refs: ['4.1.2', '1.3.1'] },
  'aria-valid-attr-value': { hint: 'aria 名称 角色 值 关联', refs: ['4.1.2'] },
  'color-contrast': { hint: '颜色 对比度 contrast 文字 背景', refs: ['1.4.3'] },
  'focus-style-unchanged': { hint: '键盘 焦点 focus 轮廓 可见 样式', refs: ['2.4.7', '2.4.11'] },
  'keyboard-unreached': { hint: '键盘 keyboard tab 无法访问', refs: ['2.1.1'] },
  'focus-order-positive-tabindex': { hint: '焦点 顺序 键盘 focus keyboard', refs: ['2.4.3', '2.1.1'] },
  'target-size': { hint: '目标尺寸 target size 点击 触摸 按钮', refs: ['2.5.8'] },
  'meta-viewport': { hint: '页面 文字 放大 缩放 zoom resize', refs: ['1.4.4', '1.4.10'] },
};

function terms(value: string): string[] {
  const parts = value.toLowerCase().match(/[a-z0-9]+(?:\.[0-9]+)+|[a-z0-9]+|[\u4e00-\u9fff]+/g) ?? [];
  return parts.flatMap(part => /[\u4e00-\u9fff]/.test(part) && part.length > 1
    ? [part, ...Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2))]
    : part.length > 1 ? [part] : []);
}

const documents = passages.map(passage => {
  // Repeat title and keywords to give curated descriptive fields greater weight.
  const tokens = terms(`${passage.title} ${passage.title} ${passage.keywords} ${passage.keywords} ${passage.text} ${passage.refs.join(' ')}`);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return { passage, counts, length: tokens.length };
});
const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
const documentFrequency = new Map<string, number>();
for (const document of documents) for (const token of document.counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);

function bm25(query: string[], document: typeof documents[number]): number {
  let score = 0;
  for (const token of new Set(query)) {
    const frequency = document.counts.get(token) ?? 0;
    if (!frequency) continue;
    const df = documentFrequency.get(token) ?? 0;
    const inverse = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
    score += inverse * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * document.length / averageLength));
  }
  return score;
}

/** Rule-anchored lexical BM25 over curated WCAG summaries; no embedding model or vector database. */
export function searchWcag(ruleId: string, query: string, limit = 3): Passage[] {
  const profile = issueProfiles[ruleId];
  if (!profile) return [];
  const hints = terms(profile.hint);
  const queryTerms = terms(query.slice(0, 300)).slice(0, 80);
  return documents.map(document => {
    const refIndex = profile.refs.findIndex(ref => document.passage.refs.includes(ref));
    const hintScore = bm25(hints, document);
    const queryScore = bm25(queryTerms, document);
    // Anchored criteria take precedence over untrusted or misleading page/query text.
    const referenceBoost = refIndex === 0 ? 40 : refIndex > 0 ? 20 - refIndex : 0;
    return { passage: document.passage, eligible: refIndex >= 0, score: referenceBoost + 4 * hintScore / (hintScore + 8) + 12 * queryScore / (queryScore + 8) };
  }).filter(result => result.eligible).sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
    .slice(0, Math.max(0, Math.min(limit, 3))).map(result => result.passage);
}
