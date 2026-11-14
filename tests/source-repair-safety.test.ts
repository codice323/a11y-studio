import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'a11y-source-safety-'));
process.env.A11Y_DATA_DIR = path.join(root,'db');
const { compileSourcePlan, sourceReviewChanges, writeSourceCandidate, checkSourceCandidate } = await import('../apps/api/source-repair');
const { auditCandidate, withRepairPage } = await import('../apps/api/scan');
const { checkOtherPages } = await import('../apps/api/page-regression');
const { inspectCssEvidence } = await import('../apps/api/css-evidence');

test('冻结开发集中的共享 CSS 跨页回归会被拦截，文档内修复通过', {timeout:40000}, async t=>{
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cases = await import('./fixtures/cross-site/generalization.mjs');
  const fixture = cases.generalizationSites.find((site:{id:string})=>site.id==='d6-archives');
  assert.ok(fixture);
  const dir=path.join(root,'original'), candidate=path.join(root,'candidate');
  fs.mkdirSync(path.dirname(path.join(dir,fixture.entry)),{recursive:true});
  fs.writeFileSync(path.join(dir,fixture.entry),fixture.html);
  fs.writeFileSync(path.join(dir,fixture.css),fixture.style);
  for(const [file,content] of Object.entries(fixture.extraFiles)) fs.writeFileSync(path.join(dir,file),String(content));
  const scope={dir,entry:fixture.entry,projectId:'project',snapshotId:'snapshot'};
  const baseline=await auditCandidate(scope.projectId,scope.snapshotId,dir,scope.entry);
  const issue=baseline.issues.find(item=>item.ruleId==='color-contrast'&&item.selector==='#status');
  assert.ok(issue);
  fs.cpSync(dir,candidate,{recursive:true});
  fs.appendFileSync(path.join(candidate,fixture.css),'\n#status { color: #595959 !important; }\n');
  await assert.rejects(checkOtherPages(scope,candidate),/跨页回归：annex\.html.*视觉变化/);
  fs.rmSync(candidate,{recursive:true,force:true});
  fs.cpSync(dir,candidate,{recursive:true});
  const ctx={...scope,issue,baseline};
  const repair=compileSourcePlan(ctx,{kind:'contrast',value:'#595959',file:fixture.css},'开发集回归');
  assert.deepEqual(repair.changes.map(change=>change.file),[scope.entry]);
  writeSourceCandidate(candidate,repair);
  const updated=await auditCandidate(scope.projectId,scope.snapshotId,candidate,scope.entry,undefined,repair.target);
  const checks=await checkSourceCandidate(ctx,repair,candidate,updated);
  assert.ok(checks.some(check=>check.name==='跨页复测'&&check.detail.includes('1')));
  assert.equal(fs.readFileSync(path.join(candidate,fixture.css),'utf8'),fixture.style);
});

test('浏览器证据包含继承、变量、媒体查询、内联优先级与伪状态', {timeout:15000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-css-probe-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html><head><style>
    main { --ink: #333; background: white; color: var(--ink); }
    @media (max-width: 500px) { main { background: #eee; } }
    button { background: transparent; }
    button:focus-visible { outline: 4px solid black; }
    button::before { content: '→'; color: black; }
    </style></head><body><main><button id="test" style="color:var(--ink) !important">Send</button></main></body></html>`);
  const evidence=await withRepairPage(dir,'index.html',undefined,page=>inspectCssEvidence(page,'#test'));
  assert.deepEqual(evidence.map(item=>item.width),[900,390]);
  assert.ok(evidence.every(item=>item.normal.inline?.some(decl=>decl.important&&decl.value.includes('var(--ink)'))));
  assert.ok(evidence[0].focused.matchedRules.some(rule=>rule.selectors.includes('button:focus-visible')));
  assert.ok(evidence[0].normal.pseudoElements?.some(item=>item.type==='before'));
  assert.ok(evidence[1].normal.inherited?.some(item=>item.rules.some(rule=>rule.media?.some(media=>media.includes('max-width')))));
  assert.notEqual(evidence[0].contrast.ratio,evidence[1].contrast.ratio);
});

test('浏览器采集的大型 HTML 可生成并写入局部补丁，审核只返回改动片段', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-large-capture-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const entry='index.html';
  const file=path.join(dir,entry);
  const original='<!doctype html><html><body><!--'+'x'.repeat(1_400_000)+'-->\n<button id="target"></button></body></html>';
  fs.writeFileSync(file,original);
  const issue={id:'issue',ruleId:'button-name',selector:'#target',impact:'critical',help:'',description:'',helpUrl:'',html:'<button id="target"></button>',bounds:null};
  const plan={kind:'button',mode:'aria',value:'打开菜单'};
  assert.throws(()=>compileSourcePlan({dir,entry,issue},plan,'补丁'),/64 KiB/);
  const candidate=compileSourcePlan({dir,entry,issue,capturedEntry:true},plan,'补丁');
  const review=sourceReviewChanges(candidate.changes)[0];
  assert.equal(review.excerpt,true);
  assert.ok(review.after.length<1024);
  assert.match(review.after,/aria-label="打开菜单"/);
  writeSourceCandidate(dir,candidate);
  assert.equal(fs.readFileSync(file,'utf8'),original.replace('id="target"','id="target" aria-label="打开菜单"'));
});
