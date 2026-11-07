import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './storage';

export type Passage = { id: string; title: string; refs: string[]; url: string; text: string; keywords: string };
const passages = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge/wcag/passages.json'), 'utf8')) as Passage[];
const hints: Record<string, string> = {
  'image-alt': '图片 图像 image alt 替代文本', label: '表单 控件 label 名称 输入',
  'button-name': '按钮 button 名称 可见 标签', 'link-name': '链接 link 目的 名称',
  'color-contrast': '颜色 对比度 contrast 文字 背景',
};

function terms(value: string) {
  const tokens = value.toLowerCase().match(/[a-z0-9.]+|[\u4e00-\u9fff]+/g) || [];
  return tokens.flatMap(token => /[\u4e00-\u9fff]/.test(token) && token.length > 2
    ? [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))]
    : [token]);
}

/** Lexical retrieval over curated Chinese summaries of WCAG 2.2, not a vector database. */
export function searchWcag(ruleId: string, query: string, limit = 3): Passage[] {
  const hintTerms = new Set(terms(hints[ruleId] || ruleId));
  const queryTerms = new Set(terms(query.slice(0, 300)));
  return passages.map(passage => {
    const content = `${passage.title} ${passage.text} ${passage.keywords} ${passage.refs.join(' ')}`.toLowerCase();
    const hintScore = [...hintTerms].reduce((score, term) => score + (content.includes(term) ? 2 : 0), 0);
    const queryScore = [...queryTerms].reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0);
    return { passage, score: hintScore + queryScore, hintScore };
  }).filter(result => result.hintScore > 0).sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
    .slice(0, Math.max(0, Math.min(limit, 3))).map(result => result.passage);
}
