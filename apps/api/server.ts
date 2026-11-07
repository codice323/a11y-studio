import express from 'express';import multer from 'multer';import fs from 'node:fs';import path from 'node:path';import {zipSync,strToU8} from 'fflate';import 'dotenv/config';
import {db,id,now,ROOT,DATA,project,proposal,audit,snapshotDir,walk,safePath} from './storage';import {createProject} from './import';import {captureUrlSnapshot} from './url-snapshot';import {runAudit,inspectAuditElement} from './scan';import {createProposal,applyProposal,rejectProposal,rollback,getKnowledge} from './repair';
import { decideAiFinding, requestAiAudit } from './audit-ai';
const app=express();app.disable('x-powered-by');app.use((req,res,next)=>{const origin=req.get('origin');if(origin){try{const o=new URL(origin);if(!['127.0.0.1','localhost'].includes(o.hostname)||!['http:'].includes(o.protocol)||![String(process.env.PORT||4173),'5173'].includes(o.port))return res.status(403).json({error:'请求来源无效。'});}catch{return res.status(403).json({error:'请求来源无效。'});}}next()});app.use((req,res,next)=>{
 const host = req.get('host');
 if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host)) return res.status(403).json({error:'请求主机无效。'});
 next();
});app.use(express.json({limit:'64kb'}));const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:1}});const port=Number(process.env.PORT||4173);
db.exec("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT,status TEXT,result TEXT,error TEXT,created_at TEXT); UPDATE jobs SET status='failed',error='服务重启，任务已中断。' WHERE status IN ('queued','running'); UPDATE audits SET status='failed',error='服务重启，扫描已中断。' WHERE status='running';");
const controllers=new Map<string,AbortController>();
function job(type:string,run:(signal:AbortSignal)=>Promise<any>){const jid=id(),controller=new AbortController();controllers.set(jid,controller);db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(jid,type,'queued',null,null,now());setImmediate(async()=>{if(controller.signal.aborted){controllers.delete(jid);return;}db.prepare('UPDATE jobs SET status=? WHERE id=?').run('running',jid);try{const result=await run(controller.signal);db.prepare('UPDATE jobs SET status=?,result=? WHERE id=?').run(controller.signal.aborted?'cancelled':'completed',JSON.stringify(result),jid)}catch(error){db.prepare('UPDATE jobs SET status=?,error=? WHERE id=?').run(controller.signal.aborted?'cancelled':'failed',(error as Error).message,jid)}finally{controllers.delete(jid)}});return {id:jid,status:'queued'};}
function latest(pid:string,sid:string){const row:any=db.prepare("SELECT id FROM audits WHERE project_id=? AND snapshot_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(pid,sid);return row?audit(row.id).result:null;}
function state(pid:string){const p=project(pid);const snaps:any[]=db.prepare("SELECT id,parent_id,hash,created_at,description FROM snapshots WHERE project_id=? AND description NOT IN ('验证失败','待验证修复') ORDER BY rowid ASC").all(pid);const first=snaps[0];const baseline=first?latest(pid,first.id):null,current=latest(pid,p.current_snapshot);const baseIds=new Set((baseline?.issues||[]).map((x:any)=>x.id)),currentIds=new Set((current?.issues||[]).map((x:any)=>x.id));const verifications:any[]=db.prepare('SELECT data FROM verifications WHERE project_id=? ORDER BY rowid DESC').all(pid).map((x:any)=>JSON.parse(x.data));return {project:{id:p.id,name:p.name,entry:p.entry,currentSnapshot:p.current_snapshot,createdAt:p.created_at},snapshots:snaps,baseline,current,summary:{initial:baseline?.issues.length??null,resolved:(baseline?.issues||[]).filter((x:any)=>!currentIds.has(x.id)).length,remaining:(baseline?.issues||[]).filter((x:any)=>currentIds.has(x.id)).length,added:(current?.issues||[]).filter((x:any)=>!baseIds.has(x.id)).length},verifications};}
app.get('/api/status',(_req,res)=>res.json({configured:!!process.env.AI_API_KEY}));
app.get('/api/fixtures',(_req,res)=>res.json([{id:'demo-mixed',name:'慢绿生活',description:'图片、按钮、表单与对比度综合示例'},{id:'demo-form',name:'课程报名',description:'表单可访问名称示例'},{id:'demo-contrast',name:'自然笔记',description:'文字对比度示例'}]));
app.get('/api/projects',(_req,res)=>res.json(db.prepare('SELECT id,name,entry,current_snapshot AS currentSnapshot,created_at AS createdAt FROM projects ORDER BY rowid DESC').all()));
app.post('/api/projects',upload.single('file'),async(req,res,next)=>{try{res.status(201).json(await createProject({fixture:req.body.fixture,file:req.file}));}catch(e){next(e)}});
let activeUrlImports = 0;
app.post('/api/projects/import-url', async (req,res,next) => {
 const url = req.body?.url;
 if (typeof url !== 'string' || !url.trim() || url.length > 2048) return res.status(400).json({error:'请输入完整的网页 URL。'});
 if (activeUrlImports >= 2) return res.status(429).json({error:'URL 导入任务过多，请稍后重试。'});
 const controller = new AbortController();
 res.on('close', () => { if (!res.writableEnded) controller.abort(); });
 activeUrlImports++;
 try {
  const captured = await captureUrlSnapshot(url.trim(), controller.signal);
  controller.signal.throwIfAborted();
  const created = await createProject({captured});
  res.status(201).json({...created, assets: captured.assets});
 } catch (error) { if (!controller.signal.aborted) next(error); }
 finally { activeUrlImports--; }
});
app.get('/api/projects/:id',(req,res,next)=>{try{res.json(state(req.params.id));}catch(e){next(e)}});
app.post('/api/projects/:id/audits',(req,res,next)=>{try{const p=project(req.params.id);res.status(202).json(job('audit',signal=>runAudit(p.id,p.current_snapshot,signal)));}catch(e){next(e)}});
app.get('/api/jobs/:id',(req,res)=>{const row:any=db.prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);if(!row)return res.status(404).json({error:'任务不存在。'});res.json({id:row.id,type:row.type,status:row.status,result:row.result?JSON.parse(row.result):null,error:row.error})});
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
app.post('/api/projects/:id/issues/:issueId/proposals',async(req,res,next)=>{try{res.status(201).json(await createProposal(req.params.id,req.params.issueId,req.body));}catch(e){next(e)}});
app.post('/api/proposals/:id/apply',(req,res,next)=>{try{proposal(req.params.id);res.status(202).json(job('verification',signal=>applyProposal(req.params.id,signal)));}catch(e){next(e)}});
app.post('/api/proposals/:id/reject',(req,res,next)=>{try{res.json(rejectProposal(req.params.id));}catch(e){next(e)}});
app.post('/api/projects/:id/rollback',(req,res,next)=>{try{res.json(rollback(req.params.id,String(req.body.snapshotId||'')));}catch(e){next(e)}});
app.get('/api/projects/:id/reports',(req,res,next)=>{try{res.json(state(req.params.id));}catch(e){next(e)}});
app.get('/api/knowledge/:rule',(req,res)=>res.json(getKnowledge(req.params.rule)));
app.get('/api/projects/:id/export',(req,res,next)=>{try{const report=state(req.params.id),p=project(req.params.id),dir=snapshotDir(p.id,p.current_snapshot);const entries:Record<string,Uint8Array>={};for(const f of walk(dir))entries['website/'+f]=fs.readFileSync(safePath(dir,f));
 const exportedReport=structuredClone(report);const auditIds=new Set<string>([report.baseline?.id,report.current?.id,...report.verifications.flatMap((v:any)=>[v.baselineAudit,v.audit])].filter(Boolean));for(const auditId of auditIds){if(!/^[0-9a-f-]{36}$/i.test(auditId))continue;const image=path.join(DATA,'screenshots',auditId+'.png');if(fs.existsSync(image))entries['report/screenshots/'+auditId+'.png']=fs.readFileSync(image)}for(const scan of [exportedReport.baseline,exportedReport.current])if(scan?.id)scan.screenshot='screenshots/'+scan.id+'.png';entries['report/report.json']=strToU8(JSON.stringify(exportedReport,null,2));const escape=(x:any)=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'} as Record<string,string>)[c]);const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>无障碍检测报告</title><body><h1>${escape(p.name)} · 检测报告</h1><p>初始 ${report.summary.initial??'未扫描'} / 已解决 ${report.summary.resolved} / 残留 ${report.summary.remaining} / 新增 ${report.summary.added}</p><h2>修复前页面</h2>${report.baseline?.id?`<img alt="原始网页截图" style="max-width:100%" src="screenshots/${escape(report.baseline.id)}.png">`:''}<h2>当前页面</h2>${report.current?.id?`<img alt="当前网页截图" style="max-width:100%" src="screenshots/${escape(report.current.id)}.png">`:''}<h2>当前问题</h2><ul>${(report.current?.issues||[]).map((i:any)=>`<li>${escape(i.help)} · ${escape(i.selector)} · ${escape(i.impact)}</li>`).join('')}</ul><h2>人工复核</h2><p>自动检测不能替代键盘、屏幕阅读器及语义检查。</p><ul>${(report.current?.incomplete||[]).map((i:any)=>`<li>${escape(i.help)} · ${i.count} 项</li>`).join('')}</ul><h2>验证记录</h2><pre>${escape(JSON.stringify(report.verifications,null,2))}</pre></body></html>`;entries['report/report.html']=strToU8(html);entries['report/verification-log.json']=strToU8(JSON.stringify(report.verifications,null,2));res.attachment('a11y-studio-'+p.id.slice(0,8)+'.zip');res.send(Buffer.from(zipSync(entries,{level:6}))); }catch(e){next(e)}});
app.use(express.static(path.join(ROOT,'dist'),{index:'index.html'}));
app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(error.message);if(!res.headersSent)res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'上传文件超过 8 MB 限制。':error.message||'处理失败。'});});
app.listen(port,'127.0.0.1',()=>console.log(`A11y Studio: http://127.0.0.1:${port}`));
