import {createTwoFilesPatch} from 'diff';import fs from 'node:fs';import path from 'node:path';import * as cheerio from 'cheerio';import postcss from 'postcss';import {z} from 'zod';
import {db,id,now,hash,ROOT,safePath,snapshotDir,project,snapshot,audit,proposal,treeHash} from './storage';import {runAudit} from './scan';
import type { ImageSemanticReview, RepairAnalysis } from '../../packages/shared/types';
import { collectVisualContext } from './ai/visual-context';
import { suggestImageAlt, suggestIconLabel } from './ai/visual-repair';
import { searchWcag } from './knowledge-search';
import { runRepairAgent, type AgentTrace } from './repair-agent';
const knowledge:Record<string,any>=JSON.parse(fs.readFileSync(path.join(ROOT,'knowledge/wcag/rules.json'),'utf8'));
const rules:Record<string,string>={'image-alt':'set-alt','label':'set-label','button-name':'set-name','link-name':'set-name','color-contrast':'set-color'};
const Patch=z.object({issueId:z.string().min(1),ruleId:z.string().min(1),targetFile:z.string().min(1),selector:z.string().min(1),fileHash:z.string().length(64),operation:z.enum(['set-alt','set-label','set-name','set-color']),value:z.string().max(160)}).strict();
const locks=new Set<string>();
function latestAudit(pid:string,sid:string){const row:any=db.prepare("SELECT * FROM audits WHERE project_id=? AND snapshot_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(pid,sid);if(!row)throw new Error('请先扫描当前版本。');return audit(row.id).result;}
function findIssue(pid:string,sid:string,issueId:string){const result=latestAudit(pid,sid);const issue=result.issues.find((i:any)=>i.id===issueId);if(!issue)throw new Error('该问题不存在或已变化，请重新扫描。');return issue;}
function signature(source:string){const $=cheerio.load(source);return $('*').toArray().map(el=>{const e=$(el);const attrs=Object.entries((el as any).attribs||{}).filter(([k])=>!['aria-label','alt','style'].includes(k)).sort(([a],[b])=>a.localeCompare(b));return [(el as any).tagName,attrs,e.contents().filter((_,c)=>(c as any).type==='text').text()];});}
function applySource(source:string,patch:any){const $=cheerio.load(source,{sourceCodeLocationInfo:true});let nodes;try{nodes=$(patch.selector)}catch{throw new Error('无法匹配目标选择器。')}if(nodes.length!==1)throw new Error('目标节点不唯一或已变化。');const node=nodes.first();const element=node[0] as any;const tag=element.tagName?.toLowerCase();let name='',value=patch.value;
 if(patch.operation==='set-alt'){if(tag!=='img')throw new Error('补丁目标不是图片。');name='alt';}
 else if(patch.operation==='set-label'){if(!['input','textarea','select'].includes(tag))throw new Error('补丁目标不是表单控件。');name='aria-label';}
 else if(patch.operation==='set-name'){if(!['button','a','input'].includes(tag))throw new Error('补丁目标不是按钮或链接。');name='aria-label';}
 else if(patch.operation==='set-color'){if(!/^#[0-9a-fA-F]{6}$/.test(patch.value))throw new Error('颜色需为六位十六进制格式。');const root=postcss.parse(`x{${node.attr('style')||''}}`);const rule=root.first as postcss.Rule;rule.walkDecls('color',d=>{d.remove();});rule.append({prop:'color',value:patch.value,important:true});name='style';value=rule.nodes.map(n=>n.toString()).join(';');}
 else throw new Error('不支持的补丁操作。');
 const location=element.sourceCodeLocation?.startTag;if(!location)throw new Error('无法定位原始 HTML 源码。');
 const encoded=String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');const attr=`${name}="${encoded}"`;const existing=location.attrs?.[name];
 if(existing)return source.slice(0,existing.startOffset)+attr+source.slice(existing.endOffset);
 const startTag=source.slice(location.startOffset,location.endOffset);const match=startTag.match(/\s*\/?\s*>$/);if(!match)throw new Error('无法定位元素起始标签。');const insertion=location.endOffset-match[0].length;return source.slice(0,insertion)+' '+attr+source.slice(insertion);
}
export async function previewIssueImage(pid: string, issueId: string, snapshotId: string) {
 const current = project(pid).current_snapshot;
 if (current !== snapshotId) throw new Error('页面版本已变化。');
 const issue = findIssue(pid,current,issueId);
 if (issue.ruleId !== 'image-alt') throw new Error('该问题没有图片预览。');
 return collectVisualContext({projectId:pid,snapshotId:current,selector:issue.selector,mode:'image-resource'});
}
export async function createProposal(pid:string,issueId:string,input:{source?:string;value?:string;imagePurpose?:unknown}){const p=project(pid),sid=p.current_snapshot,issue=findIssue(pid,sid,issueId),operation=rules[issue.ruleId];if(!operation)throw new Error('此问题需要人工处理，当前没有受支持的补丁策略。');const guide=knowledge[issue.ruleId]||{};let value=input.value, reason='由用户填写并审核的修复建议。',source='manual';let analysis:RepairAnalysis|undefined;let agentTrace:AgentTrace[]|undefined;let sources:Awaited<ReturnType<typeof runRepairAgent>>['sources']|undefined;
 const snap=snapshot(pid,sid),dir=snapshotDir(pid,sid),file=safePath(dir,snap.entry),before=fs.readFileSync(file,'utf8');
 if(input.source==='ai'||input.source==='agent'){
  const target={projectId:pid,snapshotId:sid,selector:issue.selector};
  const issueHtml=String(issue.html).slice(0,1500);
  if(operation==='set-alt'||(issue.ruleId==='button-name'&&/<(?:svg|img)\b|aria-hidden\s*=|\bicon[-_]/i.test(issueHtml))){
   sources=searchWcag(issue.ruleId,issue.help).map(({keywords:_keywords,...passage})=>passage);
   const context={wcag:sources.map(({refs,text})=>({refs,text}))};
   if(operation==='set-alt')return {...await suggestImageAlt(target,context),sources};
   analysis={...await suggestIconLabel(target,context),sources};
   value=analysis.suggestedValue??undefined;reason=analysis.reason;
  }else{
   const doc=cheerio.load(before);let surrounding='';try{const selected=doc(issue.selector);if(selected.length===1)surrounding=doc.html(selected.parent()).slice(0,2500)}catch{}
   const inlineCss=doc('style').toArray().map(el=>doc(el).html()||'').join('\n').slice(0,2000);
   const ai=await runRepairAgent({issue:{ruleId:issue.ruleId,html:issueHtml,selector:issue.selector,help:issue.help},operation,context:{surrounding,inlineCss}});
   value=ai.value?.trim()||undefined;reason=ai.reason;agentTrace=ai.trace;sources=ai.sources;
   analysis={status:'repair-review',suggestedValue:value??null,reason,sources};
  }
  if(!value||(operation==='set-color'&&!/^#[0-9a-fA-F]{6}$/.test(value)))return {...analysis,suggestedValue:null};
  source=input.source;
 }
 if(typeof value!=='string'||value.length>160||(!value.trim()&&operation!=='set-alt'))throw new Error('请填写修复内容。');if(operation==='set-color'&&!/^#[0-9a-fA-F]{6}$/.test(value))throw new Error('颜色应为六位十六进制，例如 #233c2b。');
 const imagePurpose=input.imagePurpose;
 if(operation==='set-alt'){
  if(imagePurpose!==undefined&&imagePurpose!=='informative'&&imagePurpose!=='decorative')throw new Error('请选择图片用途。');
  if(imagePurpose==='decorative'&&value!=='')throw new Error('装饰性图片应使用空 alt。');
  if(imagePurpose!=='decorative'&&!value.trim())throw new Error('内容性图片需要非空替代文本；纯装饰图片请显式选择装饰性图片。');
 }
 if(project(pid).current_snapshot!==sid||fs.readFileSync(file,'utf8')!==before)throw new Error('页面版本或文件已变化，请重新生成建议。');
 const patch=Patch.parse({issueId,ruleId:issue.ruleId,targetFile:snap.entry,selector:issue.selector,fileHash:hash(before),operation,value});const after=applySource(before,patch);
 const data={id:id(),projectId:pid,snapshotId:sid,issueId,patch,reason,impact:issue.description,wcag:guide.refs||[],wcagTitle:guide.title||'',wcagUrl:guide.url||issue.helpUrl,guidance:guide.guidance||'',risk:'请核对名称、图片语义与视觉效果；自动检测不能代替人工复核。',source,analysis,agentTrace,sources,before,after,status:'pending',imagePurpose:operation==='set-alt'?imagePurpose:undefined};
 db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(data.id,pid,sid,issueId,'pending',JSON.stringify(data),now());return data;}
export async function applyProposal(proposalId:string,signal?:AbortSignal,semanticReviewed=false){const pr=proposal(proposalId),pid=pr.project_id;
 const imagePurpose=pr.data.imagePurpose;
 let imageReview:ImageSemanticReview|undefined;
 if(imagePurpose==='informative'||imagePurpose==='decorative'){
  if(!semanticReviewed)throw new Error('请先人工确认图片用途和替代文本。');
  imageReview={purpose:imagePurpose,confirmed:true};
 }if(locks.has(pid))throw new Error('项目正在验证，请稍后再试。');locks.add(pid);let candidateId:string|undefined;
 try {if(signal?.aborted)throw new Error('任务已取消。');const p=project(pid);if(pr.status!=='pending'||p.current_snapshot!==pr.snapshot_id)throw new Error('建议已处理或版本已变化，请重新生成。');const patch=Patch.parse(pr.data.patch);if(patch.issueId!==pr.issue_id||rules[patch.ruleId]!==patch.operation)throw new Error('补丁规则无效。');const issue=findIssue(pid,p.current_snapshot,patch.issueId);if(issue.ruleId!==patch.ruleId||issue.selector!==patch.selector||patch.targetFile!==p.entry)throw new Error('补丁目标与问题不匹配。');
 const sourceDir=snapshotDir(pid,p.current_snapshot),file=safePath(sourceDir,patch.targetFile),before=fs.readFileSync(file,'utf8');if(hash(before)!==patch.fileHash)throw new Error('源文件已变化，请重新生成建议。');const after=applySource(before,patch);if(JSON.stringify(signature(before))!==JSON.stringify(signature(after)))throw new Error('页面结构或交互属性发生变化，补丁已拒绝。');
 const baseline=latestAudit(pid,p.current_snapshot);candidateId=id();const dest=snapshotDir(pid,candidateId);fs.cpSync(sourceDir,dest,{recursive:true});fs.writeFileSync(safePath(dest,patch.targetFile),after,'utf8');
 db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)').run(candidateId,pid,p.current_snapshot,p.entry,treeHash(dest),now(),'待验证修复');
 let scanned;try{scanned=await runAudit(pid,candidateId,signal,patch.operation==='set-color'?patch.selector:undefined);if(signal?.aborted)throw new Error('任务已取消。')}catch(error){
 const failure={imageReview,id:id(),projectId:pid,proposalId,fromSnapshot:p.current_snapshot,toSnapshot:candidateId,baselineAudit:baseline.id,audit:null,resolved:[],remaining:baseline.issues,added:[],targetFixed:false,structurePassed:true,patch,proposalReason:pr.data.reason,analysis:pr.data.analysis,agentTrace:pr.data.agentTrace,sources:pr.data.sources,wcag:pr.data.wcag,wcagUrl:pr.data.wcagUrl,diff:createTwoFilesPatch(patch.targetFile,patch.targetFile,before,after,'修复前','修复后'),status:'failed',reason:`复测无法完成，已保留原版本：${(error as Error).message}`,createdAt:now(),beforeHash:hash(before),afterHash:hash(after)};
 db.transaction(()=>{db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(failure.id,pid,proposalId,'failed',JSON.stringify(failure),now());db.prepare('UPDATE proposals SET status=? WHERE id=?').run('failed',proposalId);db.prepare('UPDATE snapshots SET description=? WHERE id=?').run('验证失败',candidateId)})();return failure;
 }
 const initialIds=new Set(baseline.issues.map((i:any)=>i.id)),currentIds=new Set(scanned.issues.map((i:any)=>i.id));const resolved=baseline.issues.filter((i:any)=>!currentIds.has(i.id));const remaining=baseline.issues.filter((i:any)=>currentIds.has(i.id));const added=scanned.issues.filter((i:any)=>!initialIds.has(i.id));const targetFixed=!currentIds.has(patch.issueId);const contrastPassed=patch.operation!=='set-color'||scanned.contrastCheck?.valid===true;const functionPassed=JSON.stringify(baseline.functionChecks)===JSON.stringify(scanned.functionChecks);const passed=targetFixed&&added.length===0&&contrastPassed&&functionPassed;
 const report={imageReview,id:id(),projectId:pid,proposalId,fromSnapshot:p.current_snapshot,toSnapshot:candidateId,baselineAudit:baseline.id,audit:scanned.id,resolved,remaining,added,targetFixed,structurePassed:true,functionPassed,contrastCheck:scanned.contrastCheck,patch,proposalReason:pr.data.reason,analysis:pr.data.analysis,agentTrace:pr.data.agentTrace,sources:pr.data.sources,wcag:pr.data.wcag,wcagUrl:pr.data.wcagUrl,diff:createTwoFilesPatch(patch.targetFile,patch.targetFile,before,after,'修复前','修复后'),status:passed?'passed':'failed',reason:passed?'目标问题已解决，结构与键盘聚焦检查通过，未发现新增自动检测问题。':!functionPassed?'交互控件或键盘聚焦检查发生变化，已保留原版本。':!contrastPassed?'文字对比度未通过独立核验或需要人工检查，已保留原版本。':!targetFixed?'目标问题未通过复测，已保留原版本。':'复测发现新增问题，已保留原版本。',createdAt:now(),beforeHash:hash(before),afterHash:hash(after)};
 db.transaction(()=>{db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(report.id,pid,proposalId,report.status,JSON.stringify(report),now());db.prepare('UPDATE proposals SET status=? WHERE id=?').run(passed?'applied':'failed',proposalId);db.prepare('UPDATE snapshots SET description=? WHERE id=?').run(passed?'已验证修复':'验证失败',candidateId);if(passed)db.prepare('UPDATE projects SET current_snapshot=? WHERE id=?').run(candidateId,pid)})();return report;
 }finally{locks.delete(pid)}}
export function rejectProposal(proposalId:string){const pr=proposal(proposalId);if(pr.status!=='pending')throw new Error('建议已处理。');db.prepare('UPDATE proposals SET status=? WHERE id=?').run('rejected',proposalId);return {status:'rejected'};}
export function rollback(pid:string,sid:string){if(locks.has(pid))throw new Error('项目正在验证，请稍后再试。');project(pid);const snap=snapshot(pid,sid);if(snap.description==='验证失败'||snap.description==='待验证修复')throw new Error('只能回退到有效版本。');db.prepare('UPDATE projects SET current_snapshot=? WHERE id=?').run(sid,pid);return {currentSnapshot:sid};}
export function getKnowledge(ruleId:string){return knowledge[ruleId]||null;}
