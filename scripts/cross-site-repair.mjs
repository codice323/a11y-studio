import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { zipSync, unzipSync } from 'fflate';
import { sites } from '../tests/fixtures/cross-site/sites.mjs';

const envPath = process.argv[2];
const output = path.resolve(process.argv[3] ?? 'data/cross-site-repair');
if (!envPath || !fs.existsSync(envPath)) throw new Error('Usage: node scripts/cross-site-repair.mjs /path/to/.env [output-directory]');
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-cross-site-'));
const usageFile = path.join(temporary, 'usage.ndjson');
fs.writeFileSync(usageFile, '');
const socket = net.createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--env-file=' + envPath, '--import', './tests/helpers/cross-site-usage.mjs', '--import', 'tsx', 'apps/api/server.ts'], {
  env: {...process.env, PORT: String(port), A11Y_DATA_DIR: temporary, A11Y_BENCH_USAGE_FILE: usageFile, A11Y_VISION_TRACE: '0'},
  stdio: ['ignore', 'ignore', 'ignore'],
});
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
const records = [];
const rules = {alt:'image-alt',label:'label',button:'button-name',contrast:'color-contrast',aria:'aria-valid-attr-value',focus:'focus-style-unchanged'};
let metadata = {};
let rulesSeen = new Set();

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
  const files = {[site.entry]:enc(site.html), [site.css]:enc(site.style)};
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
  if(item.kind==='button')return actual.role==='button'&&matches.test(actual.name);
  if(item.kind==='aria')return actual.refs?.split(/\s+/).includes(item.ref)&&matches.test(actual.name);
  if(item.kind==='focus')return Boolean(actual.focus?.visible&&actual.focus?.painted);
  return actual.contrast>=actual.required;
}
function usage() { return fs.readFileSync(usageFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)); }

try {
  for (let i=0;i<80;i++) { if(await fetch(base+'/api/status').then(r=>r.ok,()=>false))break;await delay(150); }
  const config = await api('/api/status');
  assert.ok(config.configured && config.visionConfigured, 'Real model and vision must be configured for this benchmark.');
  browser=await chromium.launch({executablePath:chromePath,headless:true});
  metadata={time:new Date().toISOString(),browser:browser.version(),node:process.version,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixtureSet:'original synthetic pages, no public site access',transport:'ZIP',config};
  const page=await browser.newPage({viewport:{width:900,height:700}});
  const drawing=await browser.newPage();
  for (const site of sites) {
    const files=await build(site,drawing);
    const form=new FormData();
    form.set('file',new Blob([zipSync(files)],{type:'application/zip'}),site.id+'.zip');
    const project=await api('/api/projects',form,{form:true});
    const route='/api/projects/'+project.id;
    const baseline=await job(await api(route+'/audits',{}));
    metadata.engine=baseline.detection.engine;
    baseline.issues.forEach(issue=>rulesSeen.add(issue.ruleId));
    for (const item of site.pairs) {
      const started=performance.now(), usageIndex=usage().length;
      const row={site:site.id,category:site.category,...item,status:'failed',humanSteps:[],added:null};
      try {
        await api(route+'/rollback',{snapshotId:project.currentSnapshot});
        await view(page,site.entry,files);
        const reviewRule=item.kind==='focus'?rules.focus:item.kind==='aria'?'aria-broken-idref':null;
        const typed=[...baseline.issues.filter(issue=>issue.ruleId===rules[item.kind]),
          ...baseline.detection.behavior.findings.filter(issue=>issue.ruleId===reviewRule)];
        const detected=(await matching(page,item.target,typed))[0];
        row.negativeFlagged=(await matching(page,item.control,typed)).length>0;
        row.before=await evidence(page,item.target,item.kind);
        row.negativeBefore=await evidence(page,item.control,item.kind);
        row.detected=Boolean(detected);
        row.detectionCategory=detected?.status==='needs-review'?'manual-review':detected?'confirmed':null;
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
        let proposed=await api(endpoint,{source:'agent',sourceRepair:item.kind!=='alt',snapshotId:project.currentSnapshot});
        if(proposed.kind==='job')proposed=await job(proposed);
        row.analysis=proposed.analysis ?? {reason:proposed.reason,purpose:proposed.purpose,contentAlt:proposed.contentAlt,labelDecision:proposed.labelDecision,media:proposed.media};
        row.attempts=proposed.sourceReview?.attempts??proposed.agentRun?.attempts??null;
        row.agentTrace=proposed.agentTrace??proposed.analysis?.agentTrace??[];
        row.aiAbstained=!proposed.patch && !proposed.contentAlt;
        if(item.kind==='alt'){
          if(!proposed.contentAlt || !new RegExp(item.expected,'iu').test(proposed.contentAlt)){
            row.status='needs-human';row.reason='Image wording missing or mismatches authored subject';continue;
          }
          row.humanSteps.push('confirm-informative-purpose');
          proposed=await api(endpoint,{source:'manual',value:proposed.contentAlt,imagePurpose:'informative'});
        } else if((!proposed.patch || (item.kind==='button'&&!new RegExp(item.expected,'iu').test(proposed.patch.value))) && item.human){
          row.humanSteps.push('supply-wording');
          proposed=await api(endpoint,{source:item.kind==='label'?'manual':'agent',sourceRepair:true,snapshotId:project.currentSnapshot,intent:item.human});
          if(proposed.kind==='job')proposed=await job(proposed);
        }
        if(!proposed.patch){row.status='needs-human';row.reason=proposed.reason??'No verified patch';continue;}
        row.diffFiles=proposed.sourceReview?.changes.map(change=>change.file)??[proposed.patch.targetFile];
        row.humanSteps.push('approve-patch');
        const applied=await job(await api('/api/proposals/'+proposed.id+'/apply',{semanticReviewed:item.kind==='alt',sourceReviewed:Boolean(proposed.sourceReview)}));
        row.added=applied.added.length;row.addedRules=applied.added.map(issue=>issue.ruleId);
        row.validation=applied.status;row.diff=applied.diff;
        if(applied.status!=='passed'){row.status='validation-failed';row.reason=applied.reason;continue;}
        const exported=unzipSync(await api(route+'/export',undefined,{binary:true}));
        const repaired=Object.fromEntries(Object.entries(exported).filter(([name])=>name.startsWith('website/')).map(([name,data])=>[name.slice(8),data]));
        await view(page,site.entry,repaired);
        row.after=await evidence(page,item.target,item.kind);
        row.negativeAfter=await evidence(page,item.control,item.kind);
        const comparable = item.kind==='focus' ? ['name','role','ignored','focus'] : item.kind==='contrast' ? ['contrast','foreground','background'] :
          item.kind==='alt'?['name','alt','ignored']:['name','role','ignored','refs','label'];
        row.negativeUnchanged=comparable.every(key=>JSON.stringify(row.negativeBefore[key])===JSON.stringify(row.negativeAfter[key]));
        row.status=pass(item,row.after)&&row.negativeUnchanged&&row.added===0?'success':'semantic-mismatch';
        if(row.status!=='success')row.reason='Independent browser semantic check or negative control changed';
      } catch(error){row.reason=error.message;}
      finally {
        row.elapsedMs=Math.round(performance.now()-started);row.model=usage().slice(usageIndex);
        records.push(row);
        console.log(JSON.stringify({site:row.site,kind:row.kind,target:row.target,status:row.status,reason:row.reason,elapsedMs:row.elapsedMs}));
        fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({metadata:{...metadata,rulesSeen:[...rulesSeen]},records},null,2));
      }
    }
  }
} finally {
  await browser?.close();
  const stopped=server.exitCode===null?once(server,'exit'):null;
  server.kill('SIGTERM');
  if(stopped)await stopped;
  fs.rmSync(temporary,{recursive:true,force:true});
}
