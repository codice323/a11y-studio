import express from 'express';import multer from 'multer';import fs from 'node:fs';import path from 'node:path';import {zipSync,strToU8} from 'fflate';import 'dotenv/config';
import {db,id,now,ROOT,DATA,project,proposal,audit,snapshotDir,walk,safePath} from './storage';import {createProject} from './import';import {captureUrlSnapshot} from './url-snapshot';import {runAudit,inspectAuditElement} from './scan';import {createProposal,createSourceProposal,createPanoramaProposal,previewProposal,previewIssueImage,applyProposal,rejectProposal,rollback,getKnowledge} from './repair';
import { projectState as state, renameSnapshot } from './version-state';
import { compareSnapshots } from './version-compare';
import { collectPanorama, collectSite, panoramaInput, panoramaInventory, panoramaScreenshot, siteReport } from './panorama';
import { imageVisionConfigured } from './ai/vision';
import { missingImageEvidence } from './ai/visual-context';
import { decideAiFinding, requestAiAudit } from './audit-ai';
const app=express();app.disable('x-powered-by');app.use((req,res,next)=>{const origin=req.get('origin');if(origin){try{const o=new URL(origin);if(!['127.0.0.1','localhost'].includes(o.hostname)||!['http:'].includes(o.protocol)||![String(process.env.PORT||4173),'5173'].includes(o.port))return res.status(403).json({error:'请求来源无效。'});}catch{return res.status(403).json({error:'请求来源无效。'});}}next()});app.use((req,res,next)=>{
 const host = req.get('host');
 if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) return res.status(403).json({error:'请求主机无效。'});
 next();
});app.use(express.json({limit:'64kb'}));const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});const port=Number(process.env.PORT||4173);
db.exec("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT,status TEXT,result TEXT,error TEXT,created_at TEXT); UPDATE jobs SET status='failed',error='服务重启，任务已中断。' WHERE status IN ('queued','running'); UPDATE audits SET status='failed',error='服务重启，扫描已中断。' WHERE status='running'; UPDATE panorama_attempts SET status='failed',error='服务重启，页面扫描已中断。' WHERE status='running';");
const controllers=new Map<string,AbortController>();
function job(type:string,run:(signal:AbortSignal,progress:(message:string)=>void)=>Promise<any>){const jid=id(),controller=new AbortController();controllers.set(jid,controller);db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(jid,type,'queued',null,null,now());setImmediate(async()=>{if(controller.signal.aborted){controllers.delete(jid);return;}db.prepare('UPDATE jobs SET status=? WHERE id=?').run('running',jid);try{const result=await run(controller.signal,message=>db.prepare("UPDATE jobs SET result=? WHERE id=? AND status='running'").run(JSON.stringify({progress:message}),jid));db.prepare('UPDATE jobs SET status=?,result=? WHERE id=?').run(controller.signal.aborted?'cancelled':'completed',JSON.stringify(result),jid)}catch(error){db.prepare('UPDATE jobs SET status=?,error=? WHERE id=?').run(controller.signal.aborted?'cancelled':'failed',(error as Error).message,jid)}finally{controllers.delete(jid)}});return {id:jid,kind:'job',type,status:'queued'};}
app.get('/api/status',(_req,res)=>res.json({configured:!!process.env.AI_API_KEY,visionConfigured:imageVisionConfigured()}));
app.get('/api/fixtures',(_req,res)=>res.json([{id:'demo-mixed',name:'慢绿生活',description:'图片、按钮、表单与对比度综合示例'},{id:'demo-form',name:'课程报名',description:'表单可访问名称示例'},{id:'demo-contrast',name:'自然笔记',description:'文字对比度示例'}]));
app.get('/api/projects',(_req,res)=>res.json(db.prepare('SELECT id,name,entry,mode,current_snapshot AS currentSnapshot,created_at AS createdAt FROM projects ORDER BY rowid DESC').all()));
app.post('/api/projects',upload.single('file'),async(req,res,next)=>{try{res.status(201).json(await createProject({fixture:req.body.fixture,file:req.file,engineering:req.body.mode==='source'}));}catch(e){next(e)}});
let activeUrlImports = 0;
app.post('/api/projects/import-url', async (req,res,next) => {
 const url = req.body?.url;
 const mode = req.body?.mode ?? 'static';
 if (typeof url !== 'string' || !url.trim() || url.length > 2048) return res.status(400).json({error:'请输入完整的网页 URL。'});
 if (mode !== 'static' && mode !== 'rendered') return res.status(400).json({error:'URL 采集模式无效。'});
 if (activeUrlImports >= 2) return res.status(429).json({error:'URL 导入任务过多，请稍后重试。'});
 const controller = new AbortController();
 res.on('close', () => { if (!res.writableEnded) controller.abort(); });
 activeUrlImports++;
 try {
  const captured = await captureUrlSnapshot(url.trim(), controller.signal, mode, req.body?.discover === true);
  controller.signal.throwIfAborted();
  const created = await createProject({captured});
  res.status(201).json({...created, assets: captured.assets, discovery: 'discovery' in captured ? captured.discovery : undefined, rendering: captured.rendering});
 } catch (error) { if (!controller.signal.aborted) next(error); }
 finally { activeUrlImports--; }
});
app.get('/api/projects/:id',(req,res,next)=>{try{res.json(state(req.params.id));}catch(e){next(e)}});
app.get('/api/projects/:id/compare', (req, res, next) => {
 const { left, right, issueId, selector } = req.query;
 if (typeof left !== 'string' || typeof right !== 'string' ||
     (issueId !== undefined && (typeof issueId !== 'string' || issueId.length > 128)) ||
     (selector !== undefined && (typeof selector !== 'string' || selector.length > 2048))) {
   return res.status(400).json({ error: '版本对比参数无效。' });
 }
 try { res.set('Cache-Control', 'no-store').json(compareSnapshots(req.params.id, left, right, issueId, selector)); }
 catch (error) { next(error); }
});
app.get('/api/projects/:id/panorama', (req,res,next) => {
 try {
  const {left,right} = req.query;
  if(typeof left!=='string'||typeof right!=='string')throw new Error('缺少对比版本。');
  res.set('Cache-Control','no-store').json(panoramaInventory(req.params.id,left,right));
 } catch(error) { next(error); }
});
const panoramaJobs = new Map<string, ReturnType<typeof job>>();
app.post('/api/projects/:id/panorama', (req,res) => {
 const parsed = panoramaInput.safeParse(req.body);
 if (!parsed.success) return res.status(400).json({error:'全景采集参数无效。'});
 const { id: projectId } = req.params;
 const input = parsed.data;
 const key = JSON.stringify([projectId, input]);
 const previous = panoramaJobs.get(key);
 if (previous && controllers.get(previous.id)?.signal.aborted === false) return res.status(202).json(previous);
 // The map only holds in-flight requests. Cancelled queued jobs may never run.
 for (const [request, ticket] of panoramaJobs) if (!controllers.has(ticket.id)) panoramaJobs.delete(request);
 const ticket = job('panorama', async (signal, progress) => {
  try { return input.site ? await collectSite(projectId, input.left, input.right, signal, progress) : await collectPanorama(projectId, input, signal, progress); }
  finally { if (panoramaJobs.get(key)?.id === ticket.id) panoramaJobs.delete(key); }
 });
 panoramaJobs.set(key, ticket);
 res.status(202).json(ticket);
});
app.post('/api/projects/:id/panorama/proposals', (req,res) => {
 res.status(202).json(job('source-repair',signal=>createPanoramaProposal(req.params.id,req.body,signal)));
});
app.get('/api/projects/:id/panorama/captures/:captureId/:kind', (req,res,next) => {
 try {
  res.set('Cache-Control','no-store').sendFile(panoramaScreenshot(req.params.id,req.params.captureId,req.params.kind));
 } catch(error) { next(error); }
});
app.post('/api/projects/:id/audits',(req,res,next)=>{try{const p=project(req.params.id);res.status(202).json(job('audit',signal=>runAudit(p.id,p.current_snapshot,signal)));}catch(e){next(e)}});
app.get('/api/jobs/:id',(req,res)=>{res.set('Cache-Control','no-store');const row:any=db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({code:'JOB_NOT_FOUND',error:'任务不存在。'});res.json({id:row.id,type:row.type,status:row.status,result:row.result?JSON.parse(row.result):null,error:row.error,
 ...(row.status==='failed'&&row.error==='服务重启，任务已中断。'?{code:'JOB_INTERRUPTED'}:{})})});
app.post('/api/jobs/:id/cancel',(req,res)=>{const controller=controllers.get(req.params.id);if(!controller)return res.status(409).json({error:'任务已结束，无法取消。'});controller.abort();db.prepare("UPDATE jobs SET status='cancelled',error='任务已取消。' WHERE id=? AND status='queued'").run(req.params.id);res.json({status:'cancelling'});});
app.get('/api/audits/:id/screenshot',(req,res,next)=>{try{audit(req.params.id);const f=path.join(DATA,'screenshots',req.params.id+'.png');res.sendFile(f);}catch(e){next(e)}});
app.get('/api/projects/:id/audits/:auditId/semantics', async (req,res,next) => {
 const selector = req.query.selector;
 if (typeof selector !== 'string' || !selector.trim() || selector.length > 2048) return res.status(400).json({error:'元素选择器无效。'});
 const controller = new AbortController();
 res.on('close', () => { if (!res.writableEnded) controller.abort(); });
 try { res.json(await inspectAuditElement(req.params.id, req.params.auditId, selector, controller.signal)); }
 catch (error) { if (!controller.signal.aborted) next(error); }
});
app.post('/api/projects/:id/audits/:auditId/ai-review', async (req,res,next) => {
 if (req.body?.consent !== true) return res.status(400).json({error:'请确认将候选元素名称和上下文文本发送给模型服务。'});
 try { res.json(await requestAiAudit(req.params.id, req.params.auditId)); }
 catch (error) { next(error); }
});
app.patch('/api/projects/:id/audits/:auditId/ai-review/:findingId', (req,res,next) => {
 try { res.json(decideAiFinding(req.params.id, req.params.auditId, req.params.findingId, req.body?.decision)); }
 catch (error) { next(error); }
});
app.post('/api/projects/:id/issues/:issueId/proposals',async(req,res,next)=>{try{if(req.body?.sourceRepair===true&&['agent','manual'].includes(req.body.source)){
  const {id,issueId}=req.params;
  return res.status(202).json(job('source-repair',signal=>createSourceProposal(id,issueId,req.body.snapshotId,req.body.intent,signal,req.body.source==='manual',req.body.imagePurpose)));
 }const result=await createProposal(req.params.id,req.params.issueId,req.body);res.status('patch' in result?201:200).json(result);}catch(e){next(e)}});
app.get('/api/projects/:id/issues/:issueId/image-preview',async(req,res,next)=>{
 try {
  const evidence=await previewIssueImage(req.params.id,req.params.issueId,String(req.query.snapshot??''));
  if(!evidence)return res.status(404).json({error:missingImageEvidence});
  const [header,body]=evidence.pixels.split(',',2);
  const mime=header.slice(5,header.indexOf(';'));
  res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff').type(mime).send(Buffer.from(body,'base64'));
 }catch(e){next(e);}
});
app.get('/api/proposals/:id/preview',async(req,res,next)=>{
 const controller=new AbortController();
 res.on('close',()=>{if(!res.writableEnded)controller.abort();});
 try{res.set('Cache-Control','no-store').json(await previewProposal(req.params.id,controller.signal));}
 catch(error){if(!controller.signal.aborted)next(error);}
});
app.post('/api/proposals/:id/apply',(req,res,next)=>{try{proposal(req.params.id);res.status(202).json(job('verification',signal=>applyProposal(req.params.id,signal,req.body?.semanticReviewed===true,req.body?.sourceReviewed===true)));}catch(e){next(e)}});
app.post('/api/proposals/:id/reject',(req,res,next)=>{try{res.json(rejectProposal(req.params.id));}catch(e){next(e)}});
app.patch('/api/projects/:id/snapshots/:snapshotId',(req,res,next)=>{
 try{res.json(renameSnapshot(req.params.id,req.params.snapshotId,req.body?.name));}catch(e){next(e);}
});
app.post('/api/projects/:id/rollback',(req,res,next)=>{try{res.json(rollback(req.params.id,String(req.body.snapshotId||'')));}catch(e){next(e)}});
app.get('/api/projects/:id/reports',(req,res,next)=>{
 try {
  const report = state(req.params.id);
  res.set('Cache-Control','no-store').json({...report,site:siteReport(report.project.id,report.project.currentSnapshot)});
 } catch(e) { next(e); }
});
app.get('/api/knowledge/:rule',(req,res)=>res.json(getKnowledge(req.params.rule)));
app.get('/api/projects/:id/export',(req,res,next)=>{try{const report=state(req.params.id),p=project(req.params.id),dir=snapshotDir(p.id,p.current_snapshot);const entries:Record<string,Uint8Array>={};for(const f of walk(dir))entries[(p.mode==='snapshot'?'website/':'source/')+f]=fs.readFileSync(safePath(dir,f));
 const exportedSite=siteReport(p.id,p.current_snapshot);
 for(const item of exportedSite.states){
  if(!item.screenshot) continue;
  const file='screenshots/'+item.id+'.jpg';
  entries['report/'+file]=fs.readFileSync(panoramaScreenshot(p.id,item.id,'full'));
  item.screenshot=file;
 }
 const exportedReport={...structuredClone(report),site:exportedSite};const auditIds=new Set<string>([report.baseline?.id,report.current?.id,...report.verifications.flatMap((v:any)=>[v.baselineAudit,v.audit])].filter(Boolean));for(const auditId of auditIds){if(!/^[0-9a-f-]{36}$/i.test(auditId))continue;const image=path.join(DATA,'screenshots',auditId+'.png');if(fs.existsSync(image))entries['report/screenshots/'+auditId+'.png']=fs.readFileSync(image)}for(const scan of [exportedReport.baseline,exportedReport.current])if(scan?.id)scan.screenshot='screenshots/'+scan.id+'.png';entries['report/report.json']=strToU8(JSON.stringify(exportedReport,null,2));const escape=(x:any)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]);const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>无障碍检测报告</title><body><h1>${escape(p.name)} · 检测报告</h1><p>当前版本：${escape(report.snapshots.find(item=>item.id===p.current_snapshot)?.name)}</p><p>初始 ${report.summary.initial??'未扫描'} / 已解决 ${report.summary.resolved} / 残留 ${report.summary.remaining} / 新增 ${report.summary.added}</p><h2>修复前页面</h2>${report.baseline?.id?`<img alt="原始网页截图" style="max-width:100%" src="screenshots/${escape(report.baseline.id)}.png">`:''}<h2>当前页面</h2>${report.current?.id?`<img alt="当前网页截图" style="max-width:100%" src="screenshots/${escape(report.current.id)}.png">`:''}<h2>当前问题</h2><ul>${(report.current?.issues||[]).map((i:any)=>`<li>${escape(i.help)} · ${escape(i.selector)} · ${escape(i.impact)}</li>`).join('')}</ul><h2>页面与状态检测</h2>
 <ul>${exportedSite.pages.map(page=>`<li>${escape(page.path)} · ${escape(({completed:'已扫描',running:'扫描未完成',failed:'扫描失败',skipped:'跳过',unscanned:'尚未扫描'})[page.status])}${page.issues===null?'':` · ${page.issues} 项违规`}${page.error?` · ${escape(page.error)}`:''}</li>`).join('')}</ul>
 <p>全站确定性违规：${exportedSite.confirmed}。未检测的已知路径：${escape(exportedSite.untested.join('、') || '无')}。自动规则不代表完整覆盖。</p>
 ${exportedSite.states.map(item=>`<details><summary>${escape(item.path)} · ${escape(item.label)}</summary>${item.screenshot?`<img alt="状态截图" style="max-width:100%" src="${escape(item.screenshot)}">`:'截图缺失'}<ul>${item.issues.map(issue=>`<li>${escape(issue.ruleId)} · ${escape(issue.selector)}</li>`).join('')}</ul></details>`).join('')}
 <h2>人工复核</h2><p>自动检测不能替代键盘、屏幕阅读器及语义检查。</p><ul>${(report.current?.incomplete||[]).map((i:any)=>`<li>${escape(i.help)} · ${i.count} 项</li>`).join('')}</ul><h2>版本历史</h2><ul>${report.snapshots.map((item,index)=>`<li>V${index} · ${escape(item.name)}</li>`).join('')}</ul><h2>跨版本验证记录</h2><pre>${escape(JSON.stringify(report.verifications,null,2))}</pre></body></html>`;entries['report/report.html']=strToU8(html);entries['report/verification-log.json']=strToU8(JSON.stringify(report.verifications,null,2));res.attachment('a11y-studio-'+p.id.slice(0,8)+'.zip');res.send(Buffer.from(zipSync(entries,{level:6}))); }catch(e){next(e)}});
app.use(express.static(path.join(ROOT,'dist'),{index:'index.html'}));
app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(error.message);if(!res.headersSent)res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'上传文件超过 8 MB 限制。':error.message||'处理失败。'});});
app.listen(port,'127.0.0.1',()=>console.log(`A11y Studio: http://127.0.0.1:${port}`));
