import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { searchWcag } from '../apps/api/knowledge-search';
import { ROOT } from '../apps/api/storage';

const itemSchema = z.object({id:z.string(),ruleId:z.string(),query:z.string(),evidence:z.string(),expectedRef:z.string().nullable(),review:z.string()});
const answerSchema = z.object({suggestion:z.string().max(1000).nullable(),reason:z.string().min(1).max(1000),refs:z.array(z.string()).max(8)});
const cases = z.array(itemSchema).parse(JSON.parse(fs.readFileSync(path.join(ROOT,'evaluation/wcag/repair-cases.json'),'utf8')));
const live = process.argv.includes('--live');

async function generate(item: z.infer<typeof itemSchema>, withRetrieval: boolean) {
  const sources = withRetrieval ? searchWcag(item.ruleId,item.query).map(({id,refs,text})=>({id,refs,text})) : [];
  const key = process.env.AI_API_KEY;
  if (!key) throw new Error('请先配置 AI_API_KEY。');
  const base = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/$/,'');
  const started = performance.now();
  const response = await fetch(base+'/chat/completions',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},
    body:JSON.stringify({model:process.env.AI_MODEL || 'deepseek-flash',temperature:0,max_tokens:600,
      ...(/^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(base) ? {thinking:{type:'disabled'}} : {}),
      messages:[{role:'system',content:'你是网页无障碍修复助手。仅依据给出的页面证据和可选规范摘要提出建议，不要编造用途或验证结果；无法判断时 suggestion 为 null 并说明需要确认什么。只返回 JSON：{"suggestion":"修复建议或 null","reason":"理由","refs":["WCAG 条款编号"]}。'},
        {role:'user',content:JSON.stringify({issue:item.ruleId,evidence:item.evidence,wcag:sources})}]}),
  });
  if (!response.ok) throw new Error(`模型服务 HTTP ${response.status}`);
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.length > 10000) throw new Error('模型输出格式无效');
  const answer = answerSchema.parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g,'')));
  return {answer,sourceIds:sources.map(source=>source.id),elapsedMs:Math.round(performance.now()-started),usage:payload.usage ?? null,
    referenceMatched:item.expectedRef === null ? answer.refs.length===0 : answer.refs.some(ref => (ref.match(/\d+\.\d+\.\d+/g) ?? []).includes(item.expectedRef!)),
    humanReview:{appropriate:null,reason:null}};
}

const rows = [];
for (const [index,item] of cases.entries()) {
  const sources = searchWcag(item.ruleId,item.query);
  const row: Record<string,unknown> = {...item,retrieved:sources.map(({id,refs,url})=>({id,refs,url}))};
  if (live) {
    // Alternate order to avoid consistently giving either variant the first request.
    for (const variant of index % 2 ? ['withRetrieval','withoutRetrieval'] : ['withoutRetrieval','withRetrieval']) {
      try { row[variant] = await generate(item,variant==='withRetrieval'); }
      catch (error) { row[variant] = {error:error instanceof Error ? error.message : '模型请求失败',humanReview:{appropriate:null,reason:null}}; }
    }
  }
  rows.push(row);
}
const failedRequests = live ? rows.reduce((count,row) => count + ['withoutRetrieval','withRetrieval'].filter(variant => Boolean((row[variant] as {error?:string})?.error)).length,0) : 0;
const report = {generatedAt:new Date().toISOString(),model:live ? process.env.AI_MODEL || 'deepseek-flash' : null,live,failedRequests,cases:rows,
  limitations:['案例为团队构造的文本场景，并非独立盲测或实际图片评测。','条款编号匹配只是辅助检查；建议的语义正确性、规范适用性和拒答合理性需要人工审阅。','真实模型调用存在波动，单次结果不能证明统计显著性。']};
const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const output = process.argv[outputIndex+1];
  if (!output) throw new Error('--output 后需要结果文件路径。');
  fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({live,cases:rows.length,failedRequests,results:rows.map(({id,retrieved,withRetrieval,withoutRetrieval})=>({id,retrieved, ...(live ? {withRetrieval,withoutRetrieval} : {})})),limitations:report.limitations},null,2));
if (failedRequests) process.exitCode = 1;
