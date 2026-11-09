import {createTwoFilesPatch} from 'diff';import fs from 'node:fs';import path from 'node:path';import * as cheerio from 'cheerio';import postcss from 'postcss';import {z} from 'zod';
import {db,id,now,hash,ROOT,safePath,snapshotDir,project,snapshot,audit,proposal,treeHash} from './storage';import {runAudit, withRepairPage, inspectPageElement, measurePageContrast} from './scan';
import os from 'node:os';
import type { ImageSemanticReview, RepairAnalysis } from '../../packages/shared/types';
import { collectVisualContext } from './ai/visual-context';
import { suggestImageAlt, suggestIconLabel } from './ai/visual-repair';
import { searchWcag } from './knowledge-search';
import { runRepairAgent, type AgentTrace } from './repair-agent';
import { reviewRepairIssue, sourceRepairKinds, type SourceReview } from '../../packages/shared/source-repair';
import { panoramaRepairScope, previewPanorama, verifyPanorama } from './panorama';
import { checkSourceCandidate, compileSourcePlan, proposeSourceRepair, writeSourceCandidate } from './source-repair';
import type { Issue } from '../../packages/shared/types';
const knowledge:Record<string,any>=JSON.parse(fs.readFileSync(path.join(ROOT,'knowledge/wcag/rules.json'),'utf8'));
const rules:Record<string,string>={'image-alt':'set-alt','label':'set-label','button-name':'set-name','link-name':'set-name','color-contrast':'set-color'};
const Patch=z.object({issueId:z.string().min(1),ruleId:z.string().min(1),targetFile:z.string().min(1),selector:z.string().min(1),fileHash:z.string().length(64),operation:z.enum(['set-alt','set-label','set-name','set-color']),value:z.string().max(160)}).strict();
const locks=new Set<string>();
function latestAudit(pid:string,sid:string){const row:any=db.prepare("SELECT * FROM audits WHERE project_id=? AND snapshot_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(pid,sid);if(!row)throw new Error('请先扫描当前版本。');return audit(row.id).result;}
function findIssue(pid:string,sid:string,issueId:string): Issue {
 const result=latestAudit(pid,sid);
 const issue=result.issues.find((item:Issue)=>item.id===issueId);
 if(issue)return issue;
 const reviewIssue=result.detection?.behavior.findings.map(reviewRepairIssue).find((item:Issue|undefined)=>item?.id===issueId);
 if(reviewIssue)return {...reviewIssue,source:result.sourceLocations?.[reviewIssue.selector]};
 throw new Error('该问题不存在或已变化，请重新扫描。');
}

export async function createSourceProposal(pid:string, issueId:string, expectedSnapshot:unknown, intent:unknown, signal?:AbortSignal, manualLabel=false, imagePurpose?:unknown) {
 const p=project(pid), sid=p.current_snapshot;
 if(sid!==expectedSnapshot)throw new Error('页面版本已变化，请重新选择问题。');
 const issue=findIssue(pid,sid,issueId);
 const react=p.mode==='react-source';
 const reactImage=react&&issue.ruleId==='image-alt';
 if(reactImage && (!manualLabel || typeof intent!=='string' || (imagePurpose!=='informative'&&imagePurpose!=='decorative') ||
    (imagePurpose==='informative'?!intent.trim():intent!=='')))throw new Error('请明确图片用途并填写合适的替代文本。');
 const manualRules=['label','select-name','link-name'];
 if(p.mode!=='snapshot')manualRules.push('color-contrast','button-name');
 if(manualLabel&&!reactImage&&(!manualRules.includes(issue.ruleId)||
    typeof intent!=='string'||!intent.trim()))throw new Error('请填写受支持的修复值。');
 if(!reactImage&&!Object.hasOwn(sourceRepairKinds,issue.ruleId))throw new Error('此问题没有受支持的 Agent 源码策略。');
 const ctx={projectId:pid,snapshotId:sid,dir:snapshotDir(pid,sid),entry:p.entry,issue,engineering:p.mode!=='snapshot',baseline:latestAudit(pid,sid)};
 const result=await proposeSourceRepair(ctx,intent,signal);
 signal?.throwIfAborted();
 if(project(pid).current_snapshot!==sid||treeHash(ctx.dir)!==result.baseHash)throw new Error('页面版本已变化，请重新分析。');
 const analysis={status:'repair-review',suggestedValue:'suggestedValue' in result ? result.suggestedValue : null,
  ...('labelDecision' in result ? {labelDecision:result.labelDecision} : {}),
  ...('linkDecision' in result ? {linkDecision:result.linkDecision} : {}),reason:result.reason,sources:result.sources,agentTrace:result.trace,
  agentRun:{attempts:result.attempts,elapsedMs:result.elapsedMs,usage:result.usage}};
 if(!result.candidate)return analysis;
 const {candidate,checks}=result.candidate;
 const value='value' in candidate.plan ? candidate.plan.value : '';
 const review:SourceReview={changes:candidate.changes,checks,attempts:result.attempts,elapsedMs:result.elapsedMs,usage:result.usage};
 const guide=knowledge[issue.ruleId]||{};
 const data={id:id(),projectId:pid,snapshotId:sid,issueId,source:manualLabel?'manual':'agent',status:'pending',
  patch:{issueId,ruleId:issue.ruleId,targetFile:p.entry,selector:issue.selector,operation:'source',value},
  reason:result.reason,impact:issue.description,wcag:guide.refs||issue.wcag,wcagUrl:guide.url||issue.helpUrl,
  wcagTitle:guide.title||'',guidance:guide.guidance||'',risk:'请确认文案、引用和视觉改动符合实际业务。复测运行隔离快照。',
  analysis:{...analysis,suggestedValue:value||null},agentTrace:result.trace,sources:result.sources,
  ...(reactImage?{imagePurpose}:{}),
  before:candidate.changes[0].before,after:candidate.changes[0].after,
  sourcePatch:{plan:candidate.plan,baseHash:result.baseHash},sourceReview:review};
 db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(data.id,pid,sid,issueId,'pending',JSON.stringify(data),now());
 return data;
}
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
 if(p.mode==='react-source'&&(!(input.source==='agent'||input.source==='ai')||issue.ruleId!=='image-alt'))
  throw new Error('React 工程修复必须定位和验证原始组件，不能使用快照补丁。');
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
export async function createPanoramaProposal(pid: string, input: unknown, signal: AbortSignal) {
 const {stateId, snapshotId, issueId, value, source} = z.object({
  stateId: z.uuid(), snapshotId: z.uuid(), issueId: z.string().regex(/^[a-f0-9]{20}$/),
  value: z.string().trim().max(120), source:z.enum(['agent','manual']).default('manual'),
 }).parse(input);
 if (project(pid).current_snapshot !== snapshotId) throw new Error('请选择当前项目版本的状态问题。');
 const {entry, issue, site} = panoramaRepairScope(pid, snapshotId, stateId, issueId);
 if (source === 'agent') {
  const $ = cheerio.load(fs.readFileSync(safePath(site.dir,entry),'utf8'));
  const target = issue.source?.key ? $() : $(issue.selector);
  const surrounding = target.length === 1 ? target.parent().html()?.slice(0,2400) : undefined;
  const advice = await runRepairAgent({issue:{ruleId:issue.ruleId,html:issue.html,selector:issue.selector,help:issue.help},
    operation:'set-name',context:{surrounding}});
  signal.throwIfAborted();
  if (project(pid).current_snapshot !== snapshotId) throw new Error('项目版本已变化，请重新分析。');
  return {status:'repair-review' as const,suggestedValue:advice.value?.trim().slice(0,120) || null,reason:advice.reason,sources:advice.sources};
 }
 if (!value) throw new Error('请填写并审核按钮的可访问名称。');
 const reason = '为已采集状态中的原生按钮添加人工确认的可访问名称。';
 const baseHash = treeHash(site.dir);
 const started = performance.now();
 const candidate = compileSourcePlan({dir: site.dir, entry, issue, engineering: true}, {kind: 'button', mode: 'aria', value}, reason);
 const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-panorama-proposal-'));
 const copy = path.join(temporary, 'candidate');
 try {
  fs.cpSync(site.dir, copy, {recursive: true});
  writeSourceCandidate(copy, candidate);
  const check = await verifyPanorama(pid, snapshotId, copy, signal, {stateId, issueId, value, target: candidate.target});
  signal.throwIfAborted();
  if (project(pid).current_snapshot !== snapshotId || treeHash(site.dir) !== baseHash) throw new Error('项目版本已变化，请重新预览。');
  const guide = knowledge[issue.ruleId] ?? {};
  const sourceReview: SourceReview = {
   changes: candidate.changes, checks: check ? [check] : [], attempts: 1, elapsedMs: Math.round(performance.now() - started),
   usage: {requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, complete: true},
  };
  const data = {
   id: id(), projectId: pid, snapshotId, issueId, status: 'pending', source: 'manual',
   panoramaState: stateId, sourcePatch: {plan: candidate.plan, baseHash}, sourceReview,
   patch: {issueId, ruleId: issue.ruleId, targetFile: entry, selector: issue.selector, operation: 'source', value},
   reason, impact: issue.description, wcag: guide.refs ?? issue.wcag, wcagUrl: guide.url,
   risk: '请人工确认按钮的实际用途。',
   before: candidate.changes[0].before, after: candidate.changes[0].after,
  };
  db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(data.id, pid, snapshotId, issueId, 'pending', JSON.stringify(data), now());
  return data;
 } finally { fs.rmSync(temporary, {recursive: true, force: true}); }
}

export async function previewProposal(proposalId: string, signal?: AbortSignal) {
 const pr=proposal(proposalId);
 const p=project(pr.project_id);
 if(pr.status!=='pending'||p.current_snapshot!==pr.snapshot_id)throw new Error('补丁已处理或版本已变化。');
 const dir=snapshotDir(p.id,p.current_snapshot);
 const scoped=pr.data.panoramaState ? panoramaRepairScope(p.id,p.current_snapshot,pr.data.panoramaState,pr.issue_id) : undefined;
 const issue=scoped?.issue ?? findIssue(p.id,p.current_snapshot,pr.issue_id);
 const source=pr.data.sourcePatch;
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-patch-preview-'));
 const copy=path.join(temporary,'snapshot');
 let target=issue.selector;
 try {
  fs.cpSync(dir,copy,{recursive:true});
  if(source){
   if(treeHash(dir)!==source.baseHash)throw new Error('源文件已变化。');
   const candidate=compileSourcePlan({dir,entry:scoped?.entry ?? p.entry,issue,engineering:Boolean(scoped)||p.mode!=='snapshot'},source.plan,pr.data.reason);
   if(JSON.stringify(candidate.changes)!==JSON.stringify(pr.data.sourceReview.changes))throw new Error('补丁与预览不一致。');
   writeSourceCandidate(copy,candidate);
   target=candidate.target;
  }else{
   const patch=Patch.parse(pr.data.patch);
   if(patch.targetFile!==p.entry||patch.selector!==issue.selector||patch.issueId!==issue.id)throw new Error('补丁目标无效。');
   const file=safePath(copy,p.entry),before=fs.readFileSync(file,'utf8');
   if(hash(before)!==patch.fileHash)throw new Error('源文件已变化。');
   fs.writeFileSync(file,applySource(before,patch),'utf8');
  }
  const read=(directory:string,selector:string)=>withRepairPage(directory,p.entry,signal,async page=>{
   const semantics=await inspectPageElement(page,selector);
   const contrast=issue.ruleId==='color-contrast'?await measurePageContrast(page,selector):null;
   if(issue.ruleId==='focus-style-unchanged'){
    for(let step=0;step<75;step++){
     signal?.throwIfAborted();
     await page.keyboard.press('Tab');
     if(await page.locator(selector).evaluate(element=>element===document.activeElement))break;
    }
   }
   const {width,height}=semantics.size;
   const screenshot=width*height<=4_000_000&&width<=2500&&height<=5000
    ? 'data:image/jpeg;base64,'+(await page.screenshot({fullPage:true,type:'jpeg',quality:75,timeout:8000})).toString('base64') : null;
   return {semantics,contrast,screenshot};
  });
  const readVersion=(directory:string,selector:string)=>scoped
   ? previewPanorama(p.id,p.current_snapshot,pr.data.panoramaState,directory,selector,signal)
   : read(directory,selector);
  const before=await readVersion(dir,issue.selector),after=await readVersion(copy,target);
  return {proposalId,before,after};
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
export async function applyProposal(proposalId:string,signal?:AbortSignal,semanticReviewed=false,sourceReviewed=false){const pr=proposal(proposalId),pid=pr.project_id;
 const imagePurpose=pr.data.imagePurpose;
 let imageReview:ImageSemanticReview|undefined;
 if(imagePurpose==='informative'||imagePurpose==='decorative'){
  if(!semanticReviewed)throw new Error('请先人工确认图片用途和替代文本。');
  imageReview={purpose:imagePurpose,confirmed:true};
 }if(locks.has(pid))throw new Error('项目正在验证，请稍后再试。');locks.add(pid);let candidateId:string|undefined;
 try {
 signal?.throwIfAborted();
 const p=project(pid);
 if(pr.status!=='pending'||p.current_snapshot!==pr.snapshot_id)throw new Error('建议已处理或版本已变化，请重新生成。');
 const sourcePatch=pr.data.sourcePatch;
 if(sourcePatch&&!sourceReviewed)throw new Error('请先人工确认源码补丁及其页面语义。');
 const patch=sourcePatch ? pr.data.patch : Patch.parse(pr.data.patch);
 if(patch.issueId!==pr.issue_id||(sourcePatch ? patch.operation!=='source' : rules[patch.ruleId]!==patch.operation))throw new Error('补丁规则无效。');
 const scoped=pr.data.panoramaState ? panoramaRepairScope(pid,p.current_snapshot,pr.data.panoramaState,patch.issueId) : undefined;
 const issue=scoped?.issue ?? findIssue(pid,p.current_snapshot,patch.issueId);
 const entry=scoped?.entry ?? p.entry;
 if(issue.ruleId!==patch.ruleId||issue.selector!==patch.selector||patch.targetFile!==entry)throw new Error('补丁目标与问题不匹配。');
 const sourceDir=snapshotDir(pid,p.current_snapshot),file=safePath(sourceDir,patch.targetFile),before=fs.readFileSync(file,'utf8');
 const baseline=latestAudit(pid,p.current_snapshot);
 const ctx={projectId:pid,snapshotId:p.current_snapshot,dir:sourceDir,entry,issue,engineering:Boolean(scoped)||p.mode!=='snapshot',baseline};
 let candidate:ReturnType<typeof compileSourcePlan>|undefined;
 let after=before;
 if(sourcePatch){
  if(treeHash(sourceDir)!==sourcePatch.baseHash)throw new Error('源文件已变化，请重新生成建议。');
  candidate=compileSourcePlan(ctx,sourcePatch.plan,pr.data.reason);
  if(JSON.stringify(candidate.changes)!==JSON.stringify(pr.data.sourceReview.changes))throw new Error('源码补丁与预览不符。');
 }else{
  if(hash(before)!==patch.fileHash)throw new Error('源文件已变化，请重新生成建议。');
  after=applySource(before,patch);
  if(JSON.stringify(signature(before))!==JSON.stringify(signature(after)))throw new Error('页面结构或交互属性发生变化，补丁已拒绝。');
 }
 candidateId=id();
 const dest=snapshotDir(pid,candidateId);
 try {
  fs.cpSync(sourceDir,dest,{recursive:true});
  if(candidate)writeSourceCandidate(dest,candidate);
  else fs.writeFileSync(safePath(dest,patch.targetFile),after,'utf8');
 }catch(error){fs.rmSync(dest,{recursive:true,force:true});throw error;}
 const diff=candidate ? candidate.changes.map(change=>createTwoFilesPatch(change.file,change.file,change.before,change.after,'修复前','修复后')).join('\n') :
  createTwoFilesPatch(patch.targetFile,patch.targetFile,before,after,'修复前','修复后');
 const reviewedTarget=scoped||issue.ruleId==='focus-style-unchanged'||issue.ruleId==='aria-broken-idref'?issue:undefined;
 const reviewDetails=candidate ? { sourceReview:pr.data.sourceReview, sourceTarget:candidate.target, reviewedTarget, panoramaState:pr.data.panoramaState } :
  { reviewFiles:[{file:p.entry,selector:patch.selector,before,after}] };
 const beforeHash=candidate?sourcePatch.baseHash:hash(before),afterHash=candidate?treeHash(dest):hash(after);
 db.prepare('INSERT INTO snapshots(id,project_id,parent_id,entry,hash,created_at,description) VALUES(?,?,?,?,?,?,?)').run(candidateId,pid,p.current_snapshot,p.entry,treeHash(dest),now(),'待验证修复');
 let scanned;
 let sourceChecks;
 let contrastBefore;
 try{
  const contrastSelector=candidate?.plan.kind==='contrast'?candidate.target:patch.operation==='set-color'?patch.selector:undefined;
  if(contrastSelector)contrastBefore=await withRepairPage(sourceDir,p.entry,signal,page=>measurePageContrast(page,issue.selector));
  scanned=await runAudit(pid,candidateId,signal,contrastSelector);
  if(candidate&&!scoped)sourceChecks=await checkSourceCandidate(ctx,candidate,dest,scanned,signal);
  const panoramaCheck=await verifyPanorama(pid,p.current_snapshot,dest,signal,scoped&&candidate
   ? {stateId:scoped.recipe.id,issueId:issue.id,target:candidate.target,value:patch.value} : undefined,candidateId);
  if(panoramaCheck)sourceChecks=[...(sourceChecks??[]),panoramaCheck];
  signal?.throwIfAborted();
 }catch(error){
 const failure={...reviewDetails,sourceChecks:null,imageReview,id:id(),projectId:pid,proposalId,fromSnapshot:p.current_snapshot,toSnapshot:candidateId,baselineAudit:baseline.id,audit:scanned?.id??null,resolved:[],remaining:baseline.issues,added:[],targetFixed:false,structurePassed:true,patch,proposalReason:pr.data.reason,analysis:pr.data.analysis,agentTrace:pr.data.agentTrace,sources:pr.data.sources,wcag:pr.data.wcag,wcagUrl:pr.data.wcagUrl,diff,status:'failed',reason:`复测无法完成，已保留原版本：${(error as Error).message}`,createdAt:now(),beforeHash,afterHash};
 db.transaction(()=>{db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(failure.id,pid,proposalId,'failed',JSON.stringify(failure),now());db.prepare('UPDATE proposals SET status=? WHERE id=?').run('failed',proposalId);db.prepare('UPDATE snapshots SET description=? WHERE id=?').run('验证失败',candidateId)})();return failure;
 }
 const initialIds=new Set(baseline.issues.map((i:any)=>i.id)),currentIds=new Set(scanned.issues.map((i:any)=>i.id));const resolved=baseline.issues.filter((i:any)=>!currentIds.has(i.id));const remaining=baseline.issues.filter((i:any)=>currentIds.has(i.id));const added=scanned.issues.filter((i:any)=>!initialIds.has(i.id));const targetFixed=Boolean(scoped)||!currentIds.has(patch.issueId);const contrastPassed=patch.operation!=='set-color'||scanned.contrastCheck?.valid===true;const functionPassed=JSON.stringify(baseline.functionChecks)===JSON.stringify(scanned.functionChecks);const passed=targetFixed&&added.length===0&&contrastPassed&&functionPassed;
 const report={...reviewDetails,sourceChecks,contrastBefore,imageReview,id:id(),projectId:pid,proposalId,fromSnapshot:p.current_snapshot,toSnapshot:candidateId,baselineAudit:baseline.id,audit:scanned.id,resolved,remaining,added,targetFixed,structurePassed:true,functionPassed,contrastCheck:scanned.contrastCheck,patch,proposalReason:pr.data.reason,analysis:pr.data.analysis,agentTrace:pr.data.agentTrace,sources:pr.data.sources,wcag:pr.data.wcag,wcagUrl:pr.data.wcagUrl,diff,status:passed?'passed':'failed',reason:passed?'目标问题已解决，结构与键盘聚焦检查通过，未发现新增自动检测问题。':!functionPassed?'交互控件或键盘聚焦检查发生变化，已保留原版本。':!contrastPassed?'文字对比度未通过独立核验或需要人工检查，已保留原版本。':!targetFixed?'目标问题未通过复测，已保留原版本。':'复测发现新增问题，已保留原版本。',createdAt:now(),beforeHash,afterHash};
 db.transaction(()=>{db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?,?)').run(report.id,pid,proposalId,report.status,JSON.stringify(report),now());db.prepare('UPDATE proposals SET status=? WHERE id=?').run(passed?'applied':'failed',proposalId);db.prepare('UPDATE snapshots SET description=? WHERE id=?').run(passed?'已验证修复':'验证失败',candidateId);if(passed)db.prepare('UPDATE projects SET current_snapshot=? WHERE id=?').run(candidateId,pid)})();return report;
 }finally{locks.delete(pid)}}
export function rejectProposal(proposalId:string){const pr=proposal(proposalId);if(pr.status!=='pending')throw new Error('建议已处理。');db.prepare('UPDATE proposals SET status=? WHERE id=?').run('rejected',proposalId);return {status:'rejected'};}
export function rollback(pid:string,sid:string){if(locks.has(pid))throw new Error('项目正在验证，请稍后再试。');project(pid);const snap=snapshot(pid,sid);if(snap.description==='验证失败'||snap.description==='待验证修复')throw new Error('只能回退到有效版本。');db.transaction(()=>{
  const p=project(pid);
  if(p.current_snapshot===sid)return;
  db.prepare('UPDATE projects SET current_snapshot=? WHERE id=?').run(sid,pid);
  db.prepare("UPDATE proposals SET status='rejected' WHERE project_id=? AND status='pending'").run(pid);
 })();return {currentSnapshot:sid};}
export function getKnowledge(ruleId:string){return knowledge[ruleId]||null;}
