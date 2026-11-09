import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { searchWcag, type Passage } from '../apps/api/knowledge-search';
import { ROOT } from '../apps/api/storage';

type Case = { id: string; ruleId: string; query: string; expectedRef: string | null; question?: string; answerPattern?: string };
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'evaluation/wcag/cases.json'), 'utf8')) as Case[];
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, 'knowledge/wcag/passages.json'), 'utf8')) as Passage[];
const oldIds = new Set(['non-text-content','images-of-text','labels-or-instructions','info-and-relationships','name-role-value','label-in-name','link-purpose','contrast-minimum','focus-visible']);
const legacyHints: Record<string, string> = {
  'image-alt': '图片 图像 image alt 替代文本', label: '表单 控件 label 名称 输入',
  'button-name': '按钮 button 名称 可见 标签', 'link-name': '链接 link 目的 名称',
  'aria-broken-idref': 'aria 名称 角色 值 关联', 'aria-valid-attr-value': 'aria 名称 角色 值 关联',
  'color-contrast': '颜色 对比度 contrast 文字 背景',
};
function legacyTerms(value: string) {
  const tokens = value.toLowerCase().match(/[a-z0-9.]+|[\u4e00-\u9fff]+/g) || [];
  return tokens.flatMap(token => /[\u4e00-\u9fff]/.test(token) && token.length > 2
    ? [token, ...Array.from({ length: token.length - 1 }, (_, index) => token.slice(index, index + 2))] : [token]);
}
function legacySearch(ruleId: string, query: string) {
  const hints = new Set(legacyTerms(legacyHints[ruleId] || ruleId));
  const tokens = new Set(legacyTerms(query.slice(0, 300)));
  return corpus.filter(passage => oldIds.has(passage.id)).map(passage => {
    const content = `${passage.title} ${passage.text} ${passage.keywords} ${passage.refs.join(' ')}`.toLowerCase();
    const hintScore = [...hints].reduce((score, term) => score + (content.includes(term) ? 2 : 0), 0);
    const queryScore = [...tokens].reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0);
    return { passage, hintScore, score: hintScore + queryScore };
  }).filter(result => result.hintScore > 0).sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
    .slice(0, 3).map(result => result.passage);
}

function retrievalRow(item: Case) {
  const before = legacySearch(item.ruleId, item.query);
  const after = searchWcag(item.ruleId, item.query);
  const grade = (sources: Passage[]) => ({
    refs: sources.flatMap(source => source.refs),
    top1: item.expectedRef === null ? sources.length === 0 : sources[0]?.refs.includes(item.expectedRef) ?? false,
    top3: item.expectedRef === null ? sources.length === 0 : sources.some(source => source.refs.includes(item.expectedRef!)),
  });
  return { id: item.id, ruleId: item.ruleId, expectedRef: item.expectedRef, before: grade(before), after: grade(after) };
}
const retrieval = cases.map(retrievalRow);
const summary = (variant: 'before' | 'after') => ({ total: retrieval.length,
  top1: retrieval.filter(row => row[variant].top1).length, top3: retrieval.filter(row => row[variant].top3).length });

async function generate(item: Case, withRetrieval: boolean) {
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('运行 --live 前请配置 AI_API_KEY。');
  const base = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const sources = withRetrieval ? searchWcag(item.ruleId, item.query).map(({ id, refs, text }) => ({ id, refs, text })) : [];
  const started = performance.now();
  const response = await fetch(base + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'deepseek-flash', temperature: 0, max_tokens: 350,
      ...(/^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(base) ? { thinking: { type: 'disabled' } } : {}),
      messages: [
        { role: 'system', content: '你是网页无障碍助手。回答问题并列出相关 WCAG 成功准则编号。若提供规范摘要，可作为证据；不确定时说明。只返回 JSON：{"answer":"简短回答","refs":["1.1.1"]}。' },
        { role: 'user', content: JSON.stringify({ question: item.question, evidence: sources }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}`);
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || raw.length > 10000) throw new Error('模型输出格式无效');
  const value = JSON.parse(raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  if (typeof value.answer !== 'string' || !Array.isArray(value.refs) || value.refs.some((ref: unknown) => typeof ref !== 'string')) throw new Error('模型 JSON 字段无效');
  const answerMatched = new RegExp(item.answerPattern!, 'i').test(value.answer);
  const referenceMatched = value.refs.some((ref: string) => ref.includes(item.expectedRef!));
  return { answer: value.answer.slice(0, 1500), refs: value.refs.slice(0, 8), sourceIds: sources.map(source => source.id),
    answerMatched, referenceMatched, passed: answerMatched && referenceMatched,
    elapsedMs: Math.round(performance.now() - started), usage: payload.usage ?? null };
}

async function main() {
  const report: any = { schema: 1, generatedAt: new Date().toISOString(), model: process.env.AI_MODEL || 'deepseek-flash',
    corpusSize: corpus.length, retrieval: { cases: retrieval, before: summary('before'), after: summary('after') },
    generation: null, limitations: ['人工构造小样本，和实现由同一团队维护，不代表独立泛化能力。', '答案按预设正则和条款编号自动粗评，不能代替人工语义、适用性及引用核对。', '检索前后使用相同问题和模型；不同模型调用可能波动。'] };
  if (process.argv.includes('--live')) {
    const rows = [];
    for (const item of cases.filter(item => item.question && item.answerPattern)) {
      const measure = async (withRetrieval: boolean) => {
        try { return await generate(item, withRetrieval); }
        catch (error) { return { error: error instanceof Error ? error.message : '模型请求失败', passed: false }; }
      };
      rows.push({ id: item.id, question: item.question, expectedRef: item.expectedRef,
        withoutRetrieval: await measure(false), withRetrieval: await measure(true) });
    }
    report.generation = { cases: rows, total: rows.length,
      withoutRetrievalPassed: rows.filter(row => row.withoutRetrieval.passed).length,
      withRetrievalPassed: rows.filter(row => row.withRetrieval.passed).length };
  }
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) {
    if (!process.argv[outputIndex + 1]) throw new Error('--output 后需要结果文件路径。');
    const output = path.resolve(process.argv[outputIndex + 1]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ retrieval: { before: report.retrieval.before, after: report.retrieval.after },
    generation: report.generation && { total: report.generation.total, withoutRetrievalPassed: report.generation.withoutRetrievalPassed, withRetrievalPassed: report.generation.withRetrievalPassed } }, null, 2));
}
await main();
