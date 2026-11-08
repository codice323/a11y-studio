import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { zipSync, unzipSync } from 'fflate';
import { sites } from '../tests/fixtures/cross-site/sites.mjs';
import { generalizationSites } from '../tests/fixtures/cross-site/generalization.mjs';
import { createHash } from 'node:crypto';

const envPath = process.argv[2];
const split = process.env.A11Y_BENCH_SET ?? 'legacy';
if (!['legacy', 'all', 'development', 'holdout'].includes(split)) throw new Error('Unknown benchmark set');
const selectedSites = split === 'legacy' ? sites : generalizationSites.filter(site =>
  split === 'all' || site.id.startsWith(split === 'development' ? 'd' : 'h'));
const limit = Number(process.env.A11Y_BENCH_LIMIT ?? Infinity);
if (!(limit > 0 && (Number.isInteger(limit) || limit === Infinity))) throw new Error('Invalid case limit');
const commit = process.env.A11Y_BENCH_REVISION ?? execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.match(commit,/^[a-f0-9]{40}$/i);
const transportOverrides = split === 'development' ? {'d1-harbor':'rendered-url','d4-lab':'static-url'} : {};
const fingerprint = createHash('sha256').update(JSON.stringify({selectedSites,transportOverrides})).digest('hex');
const sourceFingerprint = createHash('sha256').update(JSON.stringify(
  ['apps/api','packages/shared','knowledge'].flatMap(dir => fs.readdirSync(dir,{recursive:true,withFileTypes:true})
    .filter(entry => entry.isFile()).map(entry=>path.join(entry.parentPath,entry.name))).sort()
    .map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')])
)).digest('hex');
const output = path.resolve(process.argv[3] ?? 'data/cross-site-repair');
if (!envPath || !fs.existsSync(envPath)) throw new Error('Usage: node scripts/cross-site-repair.mjs /path/to/.env [output-directory]');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-cross-site-'));
const usageFile = path.join(output, 'usage.ndjson');
fs.appendFileSync(usageFile, '');
const resultFile = path.join(output,'results.json');
const pendingFile = path.join(output,'pending.json');
const prior = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile,'utf8')) : null;
if (prior) for (const [key, value] of Object.entries({split,fingerprint,sourceFingerprint,commit})) {
  assert.equal(prior.metadata[key],value,'Refusing to resume a different baseline: '+key);
}
const artifacts = path.join(output,'cases');
fs.mkdirSync(artifacts,{recursive:true});
function writeJson(file, data) {
  fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));
  fs.renameSync(file+'.tmp',file);
}
function archiveSite(id, name, files) {
  const dir = path.join(artifacts,id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,name),zipSync(files));
}
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const bySite = new Map(selectedSites.map(site=>[site.id,site]));
const upstream = http.createServer((req,res) => {
  const [, id, file] = new URL(req.url,'http://fixture.test').pathname.split('/');
  const site = bySite.get(id);
  const mode = transportOverrides[id];
  if (!site || !mode) return res.writeHead(404).end();
  if (file === 'hydrate.js' && mode === 'rendered-url') {
    const body = site.html.match(/<body>([\s\S]*)<\/body>/i)[1];
    return res.writeHead(200,{'Content-Type':'text/javascript'}).end('document.querySelector("#root").outerHTML='+JSON.stringify(body)+';');
  }
  if (file !== 'index.html') return res.writeHead(404).end();
  const html = mode === 'rendered-url' ? site.html.replace(/<body>[\s\S]*<\/body>/i,
    '<body><div id="root"></div><script src="hydrate.js"></script></body>') : site.html;
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);
});
upstream.listen(0,'127.0.0.1');
await once(upstream,'listening');
const server = spawn(process.execPath, ['--env-file=' + envPath, '--require','./tests/helpers/url-upstream.cjs','--import', './tests/helpers/cross-site-usage.mjs', '--import', 'tsx', 'apps/api/server.ts'], {
  env: {...process.env, PORT: String(port), A11Y_TEST_UPSTREAM_PORT:String(upstream.address().port), A11Y_DATA_DIR: temporary, A11Y_BENCH_USAGE_FILE: usageFile, A11Y_VISION_TRACE: '0'},
  stdio: ['ignore', 'ignore', 'ignore'],
});
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
const records = prior?.records ?? [];
const imports = prior?.imports ?? [];
const caseKey = item => [item.site,item.kind,item.target].join('|');
const complete = new Set(records.map(caseKey));
let addedThisRun = 0;
const rules = {alt:'image-alt',label:'label',button:'button-name',link:'link-name',contrast:'color-contrast',aria:'aria-valid-attr-value',focus:'focus-style-unchanged'};
let metadata = prior?.metadata ?? {};
const rulesSeen = new Set(metadata.rulesSeen);

async function api(route, body, { form = false, binary = false } = {}) {
  const response = await fetch(base + route, body === undefined ? {} : form ? {method:'POST', body} :
    {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)});
  if (binary && response.ok) return new Uint8Array(await response.arrayBuffer());
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? 'HTTP ' + response.status);
  return value;
}
async function job(task) {
  assert.equal(task.kind, 'job');
  for (let i = 0; i < 650; i++) {
    const state = await api('/api/jobs/' + task.id);
    if (state.status === 'completed') return state.result;
    if (state.status === 'failed' || state.status === 'cancelled') throw new Error(state.error ?? state.status);
    await delay(250);
  }
  throw new Error('Task timed out');
}
const enc = value => new TextEncoder().encode(value);
const svg = {
  bridge:'<path d="M0 148h320v60H0" fill="#75a9d6"/><path d="M14 133H306M62 134V67m196 67V67M62 67Q160 155 258 67M95 93v40m45-18v22m48-19v17m42-38v38" fill="none" stroke="#784524" stroke-width="8"/>',
  lamp:'<path d="M106 169h96m-50 0 31-73-28-25" fill="none" stroke="#25415c" stroke-width="12"/><path d="M106 99l55-45 36 52H93Z" fill="#227bc5"/><circle cx="141" cy="114" r="9" fill="#ffdf70"/>',
  train:'<path d="M22 160h282m-252 20h238" stroke="#554e51" stroke-width="5"/><rect x="27" y="69" width="266" height="80" rx="22" fill="#c33639"/><path d="M48 88h39v30H48zm54 0h39v30h-39zm54 0h39v30h-39zm54 0h60v30h-60z" fill="#dfefff"/><circle cx="82" cy="149" r="13" fill="#252c36"/><circle cx="239" cy="149" r="13" fill="#252c36"/>',
};
async function build(site, drawing) {
  const files = {[site.entry]:enc(site.html)};
  if (site.css) files[site.css] = enc(site.style);
  for (const [file, content] of Object.entries(site.extraFiles ?? {})) files[file] = enc(content);
  for (const [file, subject] of site.images) {
    const ext = path.extname(file).slice(1);
    const uri = await drawing.evaluate(async ({markup, ext}) => {
      const image = new Image();
      image.src = 'data:image/svg+xml,' + encodeURIComponent(markup);
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 208;
      const context = canvas.getContext('2d');
      context.fillStyle = '#f6f0df'; context.fillRect(0, 0, 320, 208);
      context.drawImage(image, 0, 0);
      return canvas.toDataURL('image/' + (ext === 'jpg' ? 'jpeg' : ext === 'webp' ? 'webp' : 'png'));
    }, {markup:`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="208">${svg[subject]}</svg>`, ext});
    let bytes = Buffer.from(uri.split(',')[1], 'base64');
    if (ext === 'gif') {
      const png = path.join(temporary, 'drawing.png'), gif = path.join(temporary, 'drawing.gif');
      fs.writeFileSync(png, bytes);
      execFileSync('sips', ['-s','format','gif',png,'--out',gif]);
      bytes = fs.readFileSync(gif);
    }
    files[file] = bytes;
  }
  return files;
}

async function view(page, entry, files) {
  await page.unrouteAll();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const file = decodeURIComponent(url.pathname.slice(1));
    const value = files[file];
    if (url.origin !== 'http://snapshot.test' || !value) return route.abort();
    const mime = {html:'text/html',htm:'text/html',css:'text/css',png:'image/png',jpg:'image/jpeg',webp:'image/webp',gif:'image/gif'};
    return route.fulfill({body:Buffer.from(value),contentType:(mime[file.split('.').at(-1)] ?? 'application/octet-stream')});
  });
  await page.goto('http://snapshot.test/'+entry);
}

async function matching(page, target, rows) {
  const selectors = rows.map(item=>item.selector);
  const indexes = await page.locator(target).evaluate((node, selectors) => selectors.flatMap((selector, index) => {
    try { return node.matches(selector) ? [index] : []; } catch { return []; }
  }), selectors);
  return indexes.map(index=>rows[index]);
}

async function evidence(page, target, kind) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const {root} = await cdp.send('DOM.getDocument');
    const {nodeId} = await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:target});
    const {nodes} = await cdp.send('Accessibility.getPartialAXTree',{nodeId,fetchRelatives:false});
    const {name, role, ignored} = nodes[0];
    const dom = await page.locator(target).evaluate(el => {
      const style = getComputedStyle(el);
      let background = 'rgb(255, 255, 255)';
      for (let node = el; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor;
        if (!/^rgba\(.*[, ]0\)$/.test(value) && value !== 'transparent') { background=value; break; }
      }
      const rgb = value=>value.match(/[\d.]+/g)?.slice(0,3).map(Number);
      const luminance = value=>rgb(value).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4)
        .reduce((total,v,i)=>total+v*[0.2126,0.7152,0.0722][i],0);
      const a=luminance(style.color),b=luminance(background);
      return {alt:el.getAttribute('alt'),label:[...(el.labels??[])].map(label=>({text:label.textContent,valid:label.control===el})),
        refs:el.getAttribute('aria-labelledby'),contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),
        required:parseFloat(style.fontSize)>=24 || (parseFloat(style.fontSize)>=18.66&&+style.fontWeight>=700)?3:4.5,
        foreground:style.color,background};
    });
    const result={name:name?.value??'',role:role?.value??'',ignored,...dom};
    if (kind==='focus') {
      await page.reload();
      for(let i=0;i<35;i++){
        await page.keyboard.press('Tab');
        const active=await page.locator(target).evaluate(el=>el===document.activeElement);
        if(!active)continue;
        result.focus=await page.locator(target).evaluate(el=>{
          const s=getComputedStyle(el);
          return {visible:el.matches(':focus-visible'),outline:s.outline,shadow:s.boxShadow,painted:s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=2};
        });
        break;
      }
    }
    return result;
  } finally { await cdp.detach(); }
}
function pass(item, actual) {
  const matches=new RegExp(item.expected ?? '', 'iu');
  if(item.kind==='alt')return Boolean(actual.alt&&matches.test(actual.alt)&&matches.test(actual.name)&&!actual.ignored);
  if(item.kind==='label')return matches.test(actual.name)&&actual.label.some(label=>label.valid&&matches.test(label.text));
  if(item.kind==='button'||item.kind==='link')return actual.role===item.kind&&matches.test(actual.name);
  if(item.kind==='aria')return actual.refs?.split(/\s+/).includes(item.ref)&&matches.test(actual.name);
  if(item.kind==='focus')return Boolean(actual.focus?.visible&&actual.focus?.painted);
  return actual.contrast>=actual.required;
}
function usage() { return fs.readFileSync(usageFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)); }

function persist() {
  writeJson(resultFile,{metadata:{...metadata,rulesSeen:[...rulesSeen]},imports,records});
}

try {
  for (let i=0;i<80;i++) { if(await fetch(base+'/api/status').then(r=>r.ok,()=>false))break;await delay(150); }
  const config = await api('/api/status');
  assert.ok(config.configured && config.visionConfigured, 'Real model and vision must be configured for this benchmark.');
  browser=await chromium.launch({executablePath:chromePath,headless:true});
  metadata={...metadata,split,fingerprint,sourceFingerprint,time:metadata.time??new Date().toISOString(),browser:browser.version(),node:process.version,commit,fixtureSet:'original authored fixtures, local HTTP route for URL tests',transports:['HTML','ZIP','static-url','rendered-url'],config};
  if (fs.existsSync(pendingFile)) {
    const pending = JSON.parse(fs.readFileSync(pendingFile,'utf8'));
    if (!complete.has(caseKey(pending.row))) {
      records.push({...pending.row,class:'E',status:'interrupted',reason:'Prior run interrupted; not retried to prevent a duplicate model charge',model:usage().slice(pending.usageIndex)});
      complete.add(caseKey(pending.row));
      persist();
    }
    fs.unlinkSync(pendingFile);
  }
  persist();
  const page=await browser.newPage({viewport:{width:900,height:700}});
  const drawing=await browser.newPage();
  siteLoop: for (const site of selectedSites) {
    if (addedThisRun >= limit) break;
    const remaining = site.pairs.filter(item=>!complete.has(caseKey({...item,site:site.id})));
    if (!remaining.length) continue;
    let files=await build(site,drawing);
    archiveSite(site.id,'authored.zip',files);
    writeJson(path.join(artifacts,site.id,'annotations.json'),site.pairs);
    let entry = site.entry;
    const form=new FormData();
    const isHtml = site.transport === 'html';
    const transport = transportOverrides[site.id] ?? (isHtml ? 'HTML' : 'ZIP');
    form.set('file',new Blob([isHtml ? site.html : zipSync(files)],{type:isHtml?'text/html':'application/zip'}),site.id+(isHtml?'.html':'.zip'));
    let project, baseline;
    try {
      if (transport.endsWith('-url')) {
        project=await api('/api/projects/import-url',{url:'http://93.184.216.34/'+site.id+'/index.html',mode:transport==='rendered-url'?'rendered':'static'});
        entry=project.entry;
        const exported=unzipSync(await api('/api/projects/'+project.id+'/export',undefined,{binary:true}));
        files=Object.fromEntries(Object.entries(exported).filter(([name])=>name.startsWith('website/')).map(([name,data])=>[name.slice(8),data]));
      } else project=await api('/api/projects',form,{form:true});
      archiveSite(site.id,'imported.zip',files);
      baseline=await job(await api('/api/projects/'+project.id+'/audits',{}));
      imports.push({site:site.id,transport,ok:true});
    } catch(error) {
      imports.push({site:site.id,transport,ok:false,reason:error.message});
      for(const item of remaining) {
        if (addedThisRun >= limit) break;
        records.push({site:site.id,category:site.category,transport,...item,status:'failed',stage:project?'scan':'import',class:'E',reason:error.message});
        addedThisRun++;
      }
      persist();
      continue;
    }
    const route='/api/projects/'+project.id;
    metadata.engine=baseline.detection.engine;
    baseline.issues.forEach(issue=>rulesSeen.add(issue.ruleId));
    for (const item of remaining) {
      if (addedThisRun >= limit) break siteLoop;
      const started=performance.now(), usageIndex=usage().length;
      const row={site:site.id,category:site.category,transport,...item,status:'failed',stage:'detection',humanSteps:[],added:null};
      writeJson(pendingFile,{row,usageIndex});
      try {
        await api(route+'/rollback',{snapshotId:project.currentSnapshot});
        await view(page,entry,files);
        const reviewRule=item.kind==='focus'?rules.focus:item.kind==='aria'?'aria-broken-idref':null;
        const typed=[...baseline.issues.filter(issue=>issue.ruleId===rules[item.kind] || (item.kind==='label' && issue.ruleId==='select-name')),
          ...baseline.detection.behavior.findings.filter(issue=>issue.ruleId===reviewRule)];
        const detected=(await matching(page,item.target,typed))[0];
        row.negativeFlagged=(await matching(page,item.control,typed)).length>0;
        row.before=await evidence(page,item.target,item.kind);
        row.negativeBefore=await evidence(page,item.control,item.kind);
        row.detected=Boolean(detected);
        row.detectionCategory=detected?.status==='needs-review'?'manual-review':detected?'confirmed':null;
        if(item.negativeOnly){
          row.status=detected?'false-positive':'correct-control';
          continue;
        }
        if(!detected){
          const candidates=[...baseline.detection.incomplete,...baseline.detection.bestPractices.violations,...baseline.detection.bestPractices.incomplete]
            .flatMap(rule=>rule.nodes.map(node=>({rule:rule.id,selector:node.target[0]}))).filter(node=>typeof node.selector==='string');
          row.reviewSignals=await matching(page,item.target,candidates);
          row.status='not-detected';
          row.reason='No supported finding in the repair workflow';
          continue;
        }
        const issueId=detected.id ?? (item.kind==='focus'?'focus:':'aria-ref:')+detected.selector;
        const endpoint=route+'/issues/'+encodeURIComponent(issueId)+'/proposals';
        row.stage='proposal';
        let proposed=await api(endpoint,{source:'agent',sourceRepair:item.kind!=='alt',snapshotId:project.currentSnapshot});
        if(proposed.kind==='job')proposed=await job(proposed);
        row.analysis=proposed.analysis ?? {reason:proposed.reason,purpose:proposed.purpose,contentAlt:proposed.contentAlt,labelDecision:proposed.labelDecision,media:proposed.media};
        row.attempts=proposed.sourceReview?.attempts??proposed.agentRun?.attempts??null;
        row.agentTrace=proposed.agentTrace??proposed.analysis?.agentTrace??[];
        row.aiAbstained=!proposed.patch && !proposed.contentAlt;
        if (item.expectRefusal) { row.status=row.aiAbstained?'safe-refusal':'unsafe-proposal'; continue; }
        if (item.expectAbstain && !row.aiAbstained) { row.status='unsafe-proposal'; continue; }
        if(item.kind==='alt'){
          if(!proposed.contentAlt || !new RegExp(item.expected,'iu').test(proposed.contentAlt)){
            row.status=proposed.contentAlt?'unsafe-proposal':'needs-human';row.reason='Image wording missing or mismatches authored subject';continue;
          }
          row.humanSteps.push('confirm-informative-purpose');
          proposed=await api(endpoint,{source:'manual',value:proposed.contentAlt,imagePurpose:'informative'});
        } else if((!proposed.patch || (item.kind==='button'&&!new RegExp(item.expected,'iu').test(proposed.patch.value))) && item.human){
          row.humanSteps.push('supply-wording');
          proposed=await api(endpoint,{source:item.kind==='label'?'manual':'agent',sourceRepair:true,snapshotId:project.currentSnapshot,intent:item.human});
          if(proposed.kind==='job')proposed=await job(proposed);
        }
        if(!proposed.patch){row.status='needs-human';row.reason=proposed.reason??'No verified patch';continue;}
        row.proposalPatch=proposed.sourceReview?.changes??proposed.patch;
        row.diffFiles=proposed.sourceReview?.changes.map(change=>change.file)??[proposed.patch.targetFile];
        row.humanSteps.push('approve-patch');
        row.stage='apply';
        const applied=await job(await api('/api/proposals/'+proposed.id+'/apply',{semanticReviewed:item.kind==='alt',sourceReviewed:Boolean(proposed.sourceReview)}));
        row.added=applied.added.length;row.addedRules=applied.added.map(issue=>issue.ruleId);
        row.validation=applied.status;row.verification={checks:applied.sourceChecks??null,reason:applied.reason,targetFixed:applied.targetFixed};row.diff=applied.diff;
        if(applied.status!=='passed'){row.status='validation-failed';row.reason=applied.reason;continue;}
        row.stage='independent-validation';
        const exported=unzipSync(await api(route+'/export',undefined,{binary:true}));
        const repaired=Object.fromEntries(Object.entries(exported).filter(([name])=>name.startsWith('website/')).map(([name,data])=>[name.slice(8),data]));
        await view(page,entry,repaired);
        row.after=await evidence(page,item.target,item.kind);
        row.negativeAfter=await evidence(page,item.control,item.kind);
        const comparable = item.kind==='focus' ? ['name','role','ignored','focus'] : item.kind==='contrast' ? ['contrast','foreground','background'] :
          item.kind==='alt'?['name','alt','ignored']:['name','role','ignored','refs','label'];
        row.negativeUnchanged=comparable.every(key=>JSON.stringify(row.negativeBefore[key])===JSON.stringify(row.negativeAfter[key]));
        row.otherPages = [];
        if (item.kind === 'contrast' || item.kind === 'focus') {
          for (const other of Object.keys(site.extraFiles ?? {}).filter(name => /\.html?$/i.test(name))) {
            const inspect = async files => {
              await view(page,other,files);
              return page.locator('main *').evaluateAll(nodes => nodes.map(node => {
                const s = getComputedStyle(node);
                return [node.id, s.color];
              }));
            };
            row.otherPages.push({file:other,unchanged:JSON.stringify(await inspect(files))===JSON.stringify(await inspect(repaired))});
          }
        }
        row.status=pass(item,row.after)&&row.negativeUnchanged&&row.added===0&&row.otherPages.every(other=>other.unchanged)?'success':'semantic-mismatch';
        if(row.status!=='success')row.reason='Independent browser semantic check or negative control changed';
      } catch(error){row.reason=error.message;}
      finally {
        row.elapsedMs=Math.round(performance.now()-started);row.model=usage().slice(usageIndex);
        row.class = ({success:'B','needs-human':'C','safe-refusal':'C','unsafe-proposal':'D','semantic-mismatch':'D','false-positive':'D','correct-control':'control'})[row.status] ?? 'E';
        records.push(row);
        addedThisRun++;
        console.log(JSON.stringify({site:row.site,kind:row.kind,target:row.target,status:row.status,reason:row.reason,elapsedMs:row.elapsedMs}));
        persist();
        fs.unlinkSync(pendingFile);
      }
    }
  }
} finally {
  await browser?.close();
  upstream.closeAllConnections();
  upstream.close();
  const stopped=server.exitCode===null?once(server,'exit'):null;
  server.kill('SIGTERM');
  if(stopped)await stopped;
  fs.rmSync(temporary,{recursive:true,force:true});
}
