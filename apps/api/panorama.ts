import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { Control, PanoramaCapture, PanoramaComparison, PanoramaIssue, PanoramaSide, PanoramaStep } from '../../packages/shared/panorama';
import { createInteractionAudit, readInteractionState } from './interaction-audit';
import { scanBehavior } from './scan-behavior';
import { scanRules } from './scan-rules';
import { inspectPageElement, withRepairPage, type ResourceFailure } from './scan';
import { originAttribute, sourceSelector, type buildReactProject } from './project-build';
import { DATA, db, hash, id, project, snapshot, snapshotDir, walk } from './storage';
import { latestSnapshotAudit, validSnapshots } from './version-state';

const maxStates = 12;
const maxSteps = 6;
const maxPages = 12;
const origin = 'http://a11y.local';
const directory = path.join(DATA, 'panorama');
const control = z.object({
  role: z.enum(['button', 'link', 'tab', 'textbox', 'combobox']),
  name: z.string().trim().min(1).max(100),
});
const stepSchema = z.union([
  z.object({ action: z.enum(['click', 'validate', 'fill']), target: control, navigationPath: z.string().max(240).optional() }),
  z.object({ action: z.enum(['tab', 'shift-tab', 'escape']) }),
  z.object({ action: z.literal('scroll'), y: z.number().int().min(0).max(6000) }),
]);

type Checkpoint = { path: string; landmarks: string; interaction: string; focus: string; scrollY: number };
type Recipe = { id: string; start: string; path: string; label: string; steps: PanoramaStep[]; checkpoints: Checkpoint[] };
type Captured = { capture: PanoramaCapture; checkpoints: Checkpoint[] };
type Site = { dir: string; entry: string };

class ReplayError extends Error {
  constructor(message: string, readonly step?: number) { super(message); }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS panorama_recipes(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS panorama_attempts(
    project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, scope TEXT NOT NULL,
    path TEXT NOT NULL, status TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, snapshot_id, scope));
  CREATE TABLE IF NOT EXISTS panorama_captures(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, recipe_id TEXT NOT NULL,
    data TEXT NOT NULL, UNIQUE(project_id, snapshot_id, recipe_id));
`);

function recipes(projectId: string) {
  const rows = db.prepare('SELECT data FROM panorama_recipes WHERE project_id=? ORDER BY rowid').all(projectId) as {data: string}[];
  return rows.map(row => JSON.parse(row.data) as Recipe);
}

function site(projectId: string, snapshotId: string): Site {
  const version = snapshot(projectId, snapshotId);
  return { dir: snapshotDir(projectId, snapshotId), entry: version.entry };
}

function documents({dir, entry}: Site) {
  return [entry, ...walk(dir).filter(file => file !== entry && /\.html?$/i.test(file)).sort()];
}

function selectedVersions(projectId: string, left: string, right: string) {
  const available = new Set(validSnapshots(projectId).map(item => item.id));
  if (!available.has(left) || !available.has(right)) throw new Error('请选择当前项目的两个有效版本。');
  return { left: site(projectId, left), right: site(projectId, right) };
}

const documentPath = (file: string) => '/' + file.split('/').map(encodeURIComponent).join('/');

type Attempt = {scope:string; path:string; status:'running'|'completed'|'failed'|'skipped'; error:string|null; updatedAt:string};

function recordAttempt(projectId:string, version:string, scope:string, page:string, status:Attempt['status'], error?:string) {
  db.prepare(`INSERT INTO panorama_attempts VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(project_id,snapshot_id,scope) DO UPDATE SET path=excluded.path,status=excluded.status,error=excluded.error,updated_at=excluded.updated_at`)
    .run(projectId, version, scope, page, status, error ?? null, new Date().toISOString());
}

export function siteReport(projectId: string, snapshotId: string) {
  const current = site(projectId, snapshotId);
  const attempts = db.prepare(`SELECT scope,path,status,error,updated_at AS updatedAt FROM panorama_attempts
    WHERE project_id=? AND snapshot_id=?`).all(projectId, snapshotId) as Attempt[];
  const latest = new Map(attempts.map(attempt => [attempt.scope, attempt]));
  const rows = db.prepare('SELECT id, recipe_id, data FROM panorama_captures WHERE project_id=? AND snapshot_id=?')
    .all(projectId, snapshotId) as {id:string;recipe_id:string;data:string}[];
  const saved = new Map(rows.map(row => [row.recipe_id, JSON.parse(row.data) as Captured]));
  const knownRecipes = recipes(projectId);
  const states = knownRecipes.flatMap(recipe => {
    const evidence = saved.get(recipe.id)?.capture;
    if (!evidence) return [];
    const attempt = latest.get(recipe.steps.length ? recipe.id : documentPath(recipe.start));
    return [{stateId:recipe.id,coverage:recipe.steps.some(step => !('target' in step && step.navigationPath))
      ? 'interaction' : project(projectId).mode === 'react-source' ? 'dynamic-initial' : 'static',pageId:hash(evidence.path).slice(0,20),label:recipe.label,start:recipe.start,steps:recipe.steps,...evidence,
      attempt, screenshot:hasScreenshots(evidence.id) ? `/api/projects/${projectId}/panorama/captures/${evidence.id}/full` : null}];
  });
  const mode = project(projectId).mode;
  const known = new Set([
    ...documents(current).map(documentPath),
    ...knownRecipes.map(recipe => recipe.path),
    ...(mode === 'react-source' ? states.flatMap(item => (item.navigation ?? []).map(link => link.path)) : []),
    ...attempts.map(attempt => attempt.path),
  ]);
  if (current.entry === 'index.html' && known.has('/index.html') && !states.some(item => item.path === '/')) known.delete('/');
  const pages = [...known].map(path => {
    const captures = states.filter(state => state.path === path && (!state.attempt || state.attempt.status === 'completed'));
    const pageAttempts = attempts.filter(attempt => attempt.path === path);
    const initial = latest.get(path);
    const attempt = initial ?? pageAttempts.at(-1);
    const status = captures.length ? 'completed' : attempt?.status ?? 'unscanned';
    const issues = new Map(captures.flatMap(state => state.issues.map(issue => [issue.id, issue] as const)));
    return {pageId:hash(path).slice(0,20),path,status,issues:status === 'completed' ? issues.size : null,
      states:captures.length, error:status !== 'completed' ? attempt?.error : undefined};
  });
  const liveStates = db.prepare('SELECT data FROM live_state_audits WHERE project_id=? AND snapshot_id=? ORDER BY created_at DESC LIMIT 30')
    .all(projectId,snapshotId).map(row => JSON.parse((row as {data:string}).data) as Awaited<ReturnType<typeof import('./live-comparison').scanLive>>);
  return {projectId,snapshotId,mode,pages,states,liveStates,
    attempts:attempts.filter(attempt => attempt.status !== 'completed'),
    confirmed:pages.reduce((sum, page) => sum + (page.issues ?? 0), 0),
    untested:pages.filter(page => page.status !== 'completed').map(page => page.path)};
}

export function panoramaInventory(projectId: string, left: string, right: string) {
  const versions = selectedVersions(projectId, left, right);
  const knownRecipes = recipes(projectId);
  const counts = db.prepare(`SELECT id, recipe_id, snapshot_id, json_extract(data, '$.capture.title') AS title, json_array_length(data, '$.capture.issues') AS count
    FROM panorama_captures WHERE project_id=? AND snapshot_id IN (?,?)`).all(projectId, left, right) as
    {id: string; recipe_id: string; snapshot_id: string; title: string; count: number}[];
  const available = counts.filter(row => {
    const recipe = knownRecipes.find(item => item.id === row.recipe_id);
    if (!recipe) return false;
    const attempt = db.prepare('SELECT status FROM panorama_attempts WHERE project_id=? AND snapshot_id=? AND scope=?')
      .get(projectId,row.snapshot_id,recipe.steps.length ? recipe.id : documentPath(recipe.start)) as {status:string}|undefined;
    return !attempt || attempt.status === 'completed';
  });
  const entries = Object.fromEntries([...new Set([left, right])].flatMap(version => {
    const scan = latestSnapshotAudit(projectId, version);
    if (!scan?.screenshot || !scan.size || !isScreenshot(path.join(DATA, 'screenshots', scan.id + '.png'))) return [];
    return [[version, { file: version === left ? versions.left.entry : versions.right.entry, screenshot: scan.screenshot, size: scan.size }]];
  }));
  return {
    pages: [...new Set([...documents(versions.left), ...documents(versions.right)])],
    entries,
    recipes: knownRecipes.map(({checkpoints: _, ...recipe}) => ({
      ...recipe, title: available.find(row => row.recipe_id === recipe.id && row.snapshot_id === right)?.title, counts: Object.fromEntries(available.filter(row => row.recipe_id === recipe.id)
        .map(row => [row.snapshot_id, row.count])),
    })),
    interactive: project(projectId).mode !== 'snapshot',
    limit: maxStates,
  };
}

const safeText = (value: string) => value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d(?:[\d -]{7,})\d\b/gi, '[已隐藏]')
  .replace(/a11y-test-invalid/g, '[测试输入]');

async function checkpoint(page: Page): Promise<Checkpoint> {
  const url = new URL(page.url());
  if (url.origin !== origin) throw new Error('导航超出本地副本。');
  if (url.search) throw new Error('带查询参数的路由需人工验证。');
  const rendered = await page.evaluate(() => {
    const queryState = { visible(query: string) {
      return [...document.querySelectorAll(query)].filter(node => node.getClientRects().length > 0);
    } };
    const {visible} = queryState;
    return [
      visible('h1,main,[role="main"]').slice(0, 30).map(node => [node.localName, node.id, node.matches('h1') ? node.textContent?.trim().slice(0, 100) : '']),
      ['dialog[open],[role="dialog"],[role="alertdialog"]', 'details[open]', '[popover]:popover-open',
        '[aria-expanded="true"]', '[role="tab"][aria-selected="true"]', '[role="tabpanel"]',
        '[aria-invalid="true"],:user-invalid']
        .map(query => visible(query).slice(0, 30).map(node => [node.localName, node.id, node.getAttribute('aria-controls'), node.matches('[role=tab],details') ? node.textContent?.trim().slice(0, 80) : ''])),
      document.activeElement === document.body ? '' : document.activeElement?.id ||
        document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 100) ||
        document.activeElement?.localName || '',
      window.scrollY,
    ] as const;
  });
  return { path: url.pathname + (url.hash.includes('?') ? url.hash.split('?')[0] : url.hash),
    landmarks: hash(JSON.stringify(rendered[0])), interaction: JSON.stringify(rendered[1]),
    focus: safeText(rendered[2]), scrollY: rendered[3] };
}

function checkpointMatches(expected: Checkpoint, actual: Checkpoint, action?: PanoramaStep['action']) {
  return expected.path === actual.path && expected.landmarks === actual.landmarks &&
    expected.interaction === actual.interaction &&
    (action !== 'tab' && action !== 'shift-tab' || expected.focus === actual.focus) &&
    (action !== 'scroll' || Math.abs(expected.scrollY - actual.scrollY) <= 3);
}

export async function act(page: Page, step: PanoramaStep, signal: AbortSignal, recordTarget?: (selector:string) => void) {
  signal.throwIfAborted();
  let activated = '';
  let invalidFields: {id:string;referenced:boolean}[] | undefined;
  if (step.action === 'tab' || step.action === 'shift-tab' || step.action === 'escape') {
    await page.keyboard.press({ tab: 'Tab', 'shift-tab': 'Shift+Tab', escape: 'Escape' }[step.action]);
  } else if (step.action === 'scroll') {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), step.y);
  } else if ('target' in step) {
    if (safeText(step.target.name) !== step.target.name) throw new Error('控件名称可能含个人数据，无法保存重放。');
    if (/(支付|删除|发送|购买|付款|注销|下单|\b(?:pay|buy|delete|send|purchase|checkout)\b)/i.test(step.target.name)) {
      throw new Error('此控件可能产生业务副作用，已阻止。');
    }
    const navigationPath = step.navigationPath;
    if (navigationPath && (step.action !== 'click' || step.target.role !== 'link')) throw new Error('无效的导航步骤。');
    const scope = navigationPath ? page.locator('nav, [role=navigation]') : page;
    const target = scope.getByRole(step.target.role, { name: step.target.name, exact: true });
    if (await target.count() !== 1 || !await target.isVisible() || !await target.isEnabled()) {
      throw new Error('目标控件不存在、不唯一或不可操作。');
    }
    if (recordTarget) activated = await target.evaluate(el => {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
      const parts = [];
      for (let element: Element | null = el; element && element !== document.body; element = element.parentElement) {
        parts.unshift(element.localName + ':nth-child(' + (Array.from(element.parentElement?.children ?? []).indexOf(element) + 1) + ')');
      }
      return 'body > ' + parts.join(' > ');
    });
    const eligibility = await target.evaluate((el, expectedPath) => {
      if (expectedPath && (!(el instanceof HTMLAnchorElement) || new URL(el.href, location.href).pathname !== expectedPath)) return 'blocked';
      if (el instanceof HTMLAnchorElement) {
        const link = new URL(el.href, location.href);
        if (link.origin !== location.origin || link.search || el.hasAttribute('download') ||
            el.target && el.target !== '_self') return 'blocked';
      }
      if (el instanceof HTMLInputElement && /^(password|file|hidden|email|tel)$/i.test(el.type)) return 'sensitive';
      if (el instanceof HTMLButtonElement && el.form && el.type === 'submit' ||
          el instanceof HTMLInputElement && /^(submit|image|reset)$/i.test(el.type)) return 'submission';
      return 'local';
    }, navigationPath);
    if (step.action === 'validate') {
      if (eligibility !== 'submission') throw new Error('请选择表单提交控件以触发原生校验。');
      invalidFields = await target.evaluate(el => {
        const form = (el as HTMLButtonElement).form;
        if (!form) throw new Error('目标没有关联表单。');
        const fields: {id:string;referenced:boolean}[] = [];
        const listener = {handleEvent(event:Event) {
          const field = event.target;
          if (field instanceof Element && fields.length < 24) fields.push({id:field.id,
            referenced:['aria-describedby','aria-errormessage'].some(attr =>
              (field.getAttribute(attr) ?? '').split(/\s+/).some(value=>Boolean(document.getElementById(value))))});
        }};
        form.addEventListener('invalid',listener,true);
        try {
          if (form.reportValidity()) throw new Error('表单当前没有原生校验错误，未执行提交。');
        } finally { form.removeEventListener('invalid',listener,true); }
        return fields;
      });
    } else if (eligibility !== 'local') {
      throw new Error('不允许提交表单、打开外部资源或操作敏感输入。');
    } else if (step.action === 'fill') {
      if (step.target.role !== 'textbox') throw new Error('只能为普通文本框输入固定测试值。');
      await target.fill('a11y-test-invalid', { timeout: 2000 });
    } else {
      await target.click({ timeout: 2500 });
    }
  }
  // Wait for paint and short client-side updates, within the bounded replay.
  await page.waitForTimeout(120);
  signal.throwIfAborted();
  recordTarget?.(activated);
  return invalidFields;
}

export async function controlsFor(page: Page): Promise<Control[]> {
  const output: Control[] = [];
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    for (const node of nodes) {
      if (node.ignored) continue;
      const parsed = control.safeParse({ role: node.role?.value, name: node.name?.value });
      if (parsed.success && safeText(parsed.data.name) === parsed.data.name) {
        const target = parsed.data;
        if (!output.some(item => item.role === target.role && item.name === target.name)) output.push(target);
      }
      if (output.length === 45) break;
    }
  } finally { await session.detach(); }
  return output;
}

type InteractionScan = NonNullable<NonNullable<PanoramaCapture['scan']>['interaction']>;

async function withReplay<T>(site: Site, recipe: Recipe, signal: AbortSignal, inspect: (
  page: Page, product: Awaited<ReturnType<typeof buildReactProject>> | undefined, checkpoints: Checkpoint[], resources: ResourceFailure[], interaction: InteractionScan
) => Promise<T>) {
  const start = recipe.start;
  if (!documents(site).includes(start)) throw new ReplayError('此版本中没有起始页面。');
  return withRepairPage(site.dir, site.entry, signal, async (page, product, resources) => {
    page.setDefaultTimeout(3000);
    if (start !== site.entry) {
      const response = await page.goto(origin + documentPath(start), {waitUntil: 'load', timeout: 5000});
      if (!response?.ok()) throw new ReplayError('浏览器未成功加载页面。', 0);
    }
    const checkpoints = [await checkpoint(page)];
    if (recipe.checkpoints[0] && !checkpointMatches(recipe.checkpoints[0], checkpoints[0])) {
      throw new ReplayError('两个版本的起始页面无法可靠匹配。', 0);
    }
    const interaction: InteractionScan = {transitions:[],findings:[]};
    const analyze = createInteractionAudit();
    let before = recipe.steps.length ? await readInteractionState(page) : undefined;
    for (const [index, step] of recipe.steps.entries()) {
      try {
        let activated = '';
        const invalid = await act(page, step, signal, selector => {activated = selector;});
        const actual = await checkpoint(page);
        if ('target' in step && step.navigationPath && actual.path !== step.navigationPath) throw new Error('导航后未到达所发现的页面。');
        const expected = recipe.checkpoints[index + 1];
        if (expected && !checkpointMatches(expected, actual, step.action)) throw new Error('页面、状态、焦点或滚动位置不一致。');
        const after = await readInteractionState(page);
        const prior = before!;
        interaction.transitions.push({step:index+1,action:step.action,fromPath:checkpoints.at(-1)!.path,toPath:actual.path,
          beforeFocus:safeText(prior.focus),afterFocus:safeText(after.focus)});
        interaction.findings.push(...analyze(prior,after,step.action,index+1,activated,invalid)
          .map(finding => ({...finding,selector:safeText(finding.selector)})));
        before = after;
        checkpoints.push(actual);
      } catch (error) {
        signal.throwIfAborted();
        throw new ReplayError((error as Error).message.split('\n')[0], index + 1);
      }
    }
    return inspect(page, product, checkpoints, resources, interaction);
  }, 6500, true);
}

const maskedFields = 'input:not([type=button],[type=submit],[type=checkbox],[type=radio]),textarea,[contenteditable=true]';

async function capture(site: Site, recipe: Recipe, signal: AbortSignal, screenshotId?: string, target?: string) {
  return withReplay(site, recipe, signal, async (page, product, checkpoints, resourceFailures, interaction) => {
    const final = checkpoints[checkpoints.length - 1];
    const size = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    }));
    if (size.width > 2500 || size.height > 6000) throw new Error('页面尺寸超过全景采集上限。');
    const heading = await page.evaluate(() => document.querySelector('main h1, h1')?.textContent?.trim());
    const title = safeText((heading || await page.title()).slice(0, 120));
    const ax = safeText((await page.locator('body').ariaSnapshot({timeout: 4000})).slice(0, 16000));
    const { dom, layout, styles } = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('body *')];
      if (nodes.length > 3500) throw new Error('DOM 超过全景采集上限。');
      const displayed = nodes.filter(node => node.getClientRects().length > 0);
      const dom = displayed.slice(0, 220).map(node => {
        const link = node instanceof HTMLAnchorElement && node.hasAttribute('href') ? URL.parse(node.href, location.href) : null;
        const destination = link?.origin === location.origin ? ' href=' + JSON.stringify(link.pathname) : '';
        return '<' + node.localName + (node.id ? ' id=' + JSON.stringify(node.id) : '') +
          (node.hasAttribute('role') ? ' role=' + JSON.stringify(node.getAttribute('role')) : '') + destination + '>';
      });
      return {
        dom: dom.join('\n').slice(0, 12000),
        layout: displayed.filter(node => node.matches('main,header,footer,nav,dialog,[role="dialog"],form,h1,h2'))
          .map(node => { const box = node.getBoundingClientRect(); return [node.localName, node.id, Math.round(box.width), Math.round(box.height)]; }),
        styles: displayed.map(node => {
          const style = getComputedStyle(node);
          return [node.localName, node.id, style.color, style.backgroundColor, style.visibility, style.display, style.outline];
        }),
      };
    });
    const sourcePath = await page.locator('html').getAttribute('data-captured-path');
    const sourceFrom = await page.locator('html').getAttribute('data-captured-from');
    const actions = await controlsFor(page);
    const navigation = await page.locator('nav a[href], [role=navigation] a[href]').evaluateAll(links => links.flatMap(node => {
      const anchor = node as HTMLAnchorElement;
      const url = URL.parse(anchor.href);
      const name = (anchor.getAttribute('aria-label') ?? anchor.innerText).trim().replace(/\s+/g, ' ');
      if (!url || url.origin !== location.origin || url.search || url.hash || !name || name.length > 100 ||
          anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self' || !anchor.getClientRects().length) return [];
      return [{path:url.pathname,name}];
    }).slice(0, 20));
    const routeLinks = navigation.filter(link => safeText(link.name) === link.name && safeText(link.path) === link.path &&
      !/(支付|删除|发送|购买|付款|注销|下单|\b(?:pay|buy|delete|send|purchase|checkout|logout|signout|unsubscribe)\b)/i.test(link.name + ' ' + link.path));
    const scannedAt = performance.now();
    const scanned = await scanRules(page);
    const resources = await page.evaluate(() => {
      const images = Array.from(document.images);
      const stylesheets = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"]'));
      return {images:images.length, loadedImages:images.filter(img => img.complete && img.naturalWidth > 0).length,
        stylesheets:stylesheets.length,loadedStylesheets:stylesheets.filter(link => link.sheet).length};
    });
    const issues: PanoramaIssue[] = [];
    for (const violation of scanned.violations) for (const node of violation.nodes) {
      const selector = typeof node.target[0] === 'string' ? node.target[0] : '';
      const target = selector && !node.target.some(item => typeof item !== 'string') ? page.locator(selector) : null;
      let bounds = null;
      let source: PanoramaIssue['source'];
      if (target && await target.count().catch(() => 0) === 1 && node.target.length === 1) {
        bounds = await target.boundingBox({timeout: 1000}).catch(() => null);
        if (bounds) bounds.y += final.scrollY;
        if (product) {
          const key = await target.getAttribute(originAttribute).catch(() => null);
          if (key && /^[a-f0-9]{20}$/.test(key) && await page.locator(sourceSelector(key)).count() === 1) source = product.sources.get(key);
        } else source = { file: decodeURIComponent(final.path.split('#')[0].slice(1)) || site.entry, line: 0, tag: '' };
      }
      issues.push({ id: hash(violation.id + '|' + selector).slice(0, 20), ruleId: violation.id,
        selector: safeText(selector), impact: node.impact ?? violation.impact ?? 'unknown', html:safeText(node.html), help: violation.help, description: violation.description, bounds, source });
    }
    if (screenshotId) {
      fs.mkdirSync(directory, {recursive: true});
      for (const [kind, fullPage] of [['viewport', false], ['full', true]] as const) {
        await page.screenshot({path: path.join(directory, screenshotId + '-' + kind + '.jpg'),
          fullPage, animations: 'disabled', caret: 'hide', mask: [page.locator(maskedFields)], maskColor: '#d7dde7', quality: 78, timeout: 6000});
      }
    }
    const targetSemantics = target ? await inspectPageElement(page, target) : undefined;
    // The keyboard probe can change focus and scroll. Capture evidence first.
    const behavior = await scanBehavior(page, signal);
    return { checkpoints, targetSemantics, capture: { id: screenshotId ?? '', title, path: final.path, ax, dom: safeText(dom), focus: final.focus,
      ...size, scrollY: final.scrollY, issues, manual: scanned.incomplete.reduce((sum, item) => sum + item.nodes.length, 0),
      scan: { completedAt:new Date().toISOString(), elapsedMs:Math.round(performance.now() - scannedAt),
        browser:page.context().browser()?.version(),engine:scanned.engine,rules:scanned.rules,resources,interaction,
        incomplete:scanned.incomplete.map(rule => ({ruleId:rule.id,selectors:rule.nodes.map(node => safeText(JSON.stringify(node.target)))})),
        behavior:{...behavior,semanticCandidates:[],tabSequence:behavior.tabSequence.map(safeText),findings:behavior.findings.map(finding => ({
          ...finding,selector:safeText(finding.selector),explanation:safeText(finding.explanation),
          evidence:Object.fromEntries(Object.entries(finding.evidence).map(([key,value]) => [key,typeof value === 'string' ? safeText(value) : value])),
        }))}},
      controls: actions,
      ...(sourcePath?.startsWith('/') && {sourcePath:safeText(sourcePath.slice(0,240))}),
      ...(sourceFrom?.startsWith('/') && {sourceFrom:safeText(sourceFrom.slice(0,240))}),
      navigation: routeLinks, resourceFailures: [...resourceFailures], keyboard: {status: behavior.status, tabSequence: behavior.tabSequence.map(safeText),
        findings: behavior.findings.map(item => ({ruleId: item.ruleId, selector: safeText(item.selector), explanation: item.explanation}))},
      style: hash(JSON.stringify(styles)), layout: hash(JSON.stringify(layout)) } };
  });
}

function isScreenshot(file: string) {
  const stat = fs.statSync(file, {throwIfNoEntry: false});
  return Boolean(stat?.isFile() && stat.size > 0);
}

function screenshotPath(captureId: string, kind: string) {
  return path.join(directory, captureId + '-' + kind + '.jpg');
}

function hasScreenshots(captureId: string) {
  return isScreenshot(screenshotPath(captureId, 'full')) && isScreenshot(screenshotPath(captureId, 'viewport'));
}

function cached(projectId: string, version: string, recipeId: string): Captured | undefined {
  const row = db.prepare('SELECT id, data FROM panorama_captures WHERE project_id=? AND snapshot_id=? AND recipe_id=?')
    .get(projectId, version, recipeId) as {id: string; data: string} | undefined;
  if (row && hasScreenshots(row.id)) return JSON.parse(row.data);
}

function save(projectId: string, version: string, recipe: Recipe, evidence: Captured) {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO panorama_recipes VALUES (?,?,?)')
      .run(recipe.id, projectId, JSON.stringify(recipe));
    db.prepare(`INSERT INTO panorama_captures VALUES (?,?,?,?,?)
      ON CONFLICT(project_id,snapshot_id,recipe_id) DO UPDATE SET id=excluded.id,data=excluded.data`)
      .run(evidence.capture.id, projectId, version, recipe.id, JSON.stringify(evidence));
  })();
}

export const panoramaInput = z.object({
  left: z.uuid(), right: z.uuid(),
  start: z.string().min(1).max(240).optional(),
  stateId: z.uuid().optional(), step: stepSchema.optional(),
  site: z.literal(true).optional(),
  refresh: z.literal(true).optional(),
  from: z.enum(['left', 'right']).default('left'),
});

const running = new Set<string>();

export async function collectPanorama(projectId: string, input: unknown, signal: AbortSignal,
  progress: (message: string) => void = () => {}) {
  if (running.has(projectId) || running.size >= 2) throw new Error('已有全景采集任务，请稍后重试。');
  running.add(projectId);
  try {
    const {left, right, start, stateId, step, from, refresh} = panoramaInput.parse(input);
    const versions = selectedVersions(projectId, left, right);
    const existing = recipes(projectId);
    const parent = stateId ? existing.find(item => item.id === stateId) : existing.find(item => item.start === start && !item.steps.length);
    if (stateId && !parent) throw new Error('未找到此项目的交互状态。');
    if (!parent && (!start || ![...documents(versions.left), ...documents(versions.right)].includes(start))) {
      throw new Error('请选择本地已导入的 HTML 页面。');
    }
    if (step && project(projectId).mode === 'snapshot') throw new Error('静态快照仅支持浏览已采集状态。');
    if (step && !parent) throw new Error('请先采集起始状态。');
    const matching = step && parent && existing.find(item => item.start === parent.start &&
      JSON.stringify(item.steps) === JSON.stringify([...parent.steps, step]) &&
      JSON.stringify(item.checkpoints.slice(0, -1)) === JSON.stringify(parent.checkpoints));
    const recipe: Recipe = matching || (step && parent ? {
      id: id(), start: parent.start, path: parent.path, checkpoints: parent.checkpoints.slice(),
      steps: [...parent.steps, step], label: ('target' in step ? step.target.name + ' · ' : '') + step.action,
    } : parent ?? {id: id(), start: start!, path: '', label: '初始页面', steps: [], checkpoints: []});
    if (recipe.steps.length > maxSteps) throw new Error('此操作序列已达 6 步上限，请从较早状态继续。');
    const isRouteDiscovery = step && 'target' in step && Boolean(step.navigationPath);
    const interactiveCount = existing.filter(item => item.steps.length && !item.steps.every(action => 'target' in action && action.navigationPath)).length;
    if (!isRouteDiscovery && recipe.steps.length && !existing.some(item => item.id === recipe.id) && interactiveCount >= maxStates) {
      throw new Error('本项目已达到 12 个已采集状态上限。');
    }
    const versionsIds = {left, right};
    const result: PanoramaComparison = {
      stateId: null, left: {status: 'skipped', error: '尚未采集。'}, right: {status: 'skipped', error: '尚未采集。'},
    };
    const first = !recipe.checkpoints.length && !documents(versions[from]).includes(recipe.start)
      ? (from === 'left' ? 'right' : 'left') : from;
    const order = first === 'left' ? ['left', 'right'] as const : ['right', 'left'] as const;
    for (const [index, side] of order.entries()) {
      signal.throwIfAborted();
      progress(`步骤 ${index + 1}/2 · ${index ? '匹配并采集' : '采集'}${side === 'left' ? '左' : '右'}侧版本`);
      const version = versionsIds[side];
      if (index && left === right) {
        result[side] = result[first];
        continue;
      }
      const requestedPath = step && 'target' in step && step.navigationPath || recipe.path || documentPath(recipe.start);
      const scope = recipe.steps.length ? recipe.id : documentPath(recipe.start);
      const last = db.prepare('SELECT status FROM panorama_attempts WHERE project_id=? AND snapshot_id=? AND scope=?')
        .get(projectId,version,scope) as {status:string}|undefined;
      const prior = cached(projectId, version, recipe.id);
      if (!refresh && prior?.capture.scan?.interaction && (!last || last.status === 'completed')) {
        result.stateId = recipe.id;
        result[side] = {status: 'captured', capture: prior.capture};
        continue;
      }
      if (side !== first && recipe.checkpoints.length !== recipe.steps.length + 1) {
        recordAttempt(projectId,version,scope,requestedPath,'skipped','起始版本检测失败。');
        result[side] = {status: 'skipped', error: '起始版本采集失败，未重放另一侧。'};
        continue;
      }
      const shot = id();
      recordAttempt(projectId,version,scope,requestedPath,'running');
      try {
        const evidence = await capture(versions[side], recipe, signal, shot);
        signal.throwIfAborted();
        if (recipe.checkpoints.length < evidence.checkpoints.length) {
          recipe.checkpoints = evidence.checkpoints;
          recipe.path = evidence.capture.path;
        }
        save(projectId, version, recipe, evidence);
        recordAttempt(projectId,version,scope,evidence.capture.path,'completed');
        result.stateId = recipe.id;
        result[side] = {status: 'captured', capture: evidence.capture};
      } catch (error) {
        for (const kind of ['viewport', 'full']) fs.rmSync(path.join(directory, shot + '-' + kind + '.jpg'), {force: true});
        recordAttempt(projectId,version,scope,requestedPath,signal.aborted ? 'skipped' : 'failed',
          signal.aborted ? '检测中断或超时。' : (error as Error).message);
        signal.throwIfAborted();
        result[side] = {status: error instanceof ReplayError && (side !== first || error.step === 0) ? 'unmatched' : 'failed',
          error: (error as Error).message,
          ...(error instanceof ReplayError ? {step: error.step} : {})};
      }
    }
    return result;
  } finally { running.delete(projectId); }
}

export async function collectSite(projectId: string, left: string, right: string, signal: AbortSignal, progress: (message:string)=>void) {
  const versions = selectedVersions(projectId, left, right);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(100000)]);
  const files = [...new Set([...documents(versions.left), ...documents(versions.right)])];
  const home = versions.right.entry;
  const priorStates = recipes(projectId).filter(recipe => recipe.steps.length);
  const skip = (page: string, scope = page) => {
    const reason = '未检查：达到页面或时间限制，或任务已取消。';
    failures.push({page,reason});
    for (const version of new Set([left,right])) recordAttempt(projectId,version,scope,page,'skipped',reason);
  };
  const visited = new Set(files.map(documentPath));
  const failures: {page:string; reason:string}[] = [];
  let routes: NonNullable<PanoramaCapture['navigation']> = [];
  let homeState: string | null = null;
  const collect = async (page: string, request: object) => {
    progress('正在检测 ' + page);
    try {
      const result = await collectPanorama(projectId, {left, right, refresh:true, ...request}, bounded);
      if (result.left.status !== 'captured' || result.right.status !== 'captured') {
        failures.push({page, reason:[result.left,result.right].flatMap(side => side.status === 'captured' ? [] : [side.error]).join('；')});
      }
      return result;
    } catch (error) {
      failures.push({page, reason:bounded.aborted ? '扫描中断或超时。' : (error as Error).message});
    }
  };
  for (const file of files) {
    if (bounded.aborted) {skip(documentPath(file)); continue;}
    const result = await collect(file, {start:file});
    if (file === home && project(projectId).mode === 'react-source' && result?.stateId) {
      homeState = result.stateId;
      const capture = result.right.status === 'captured' ? result.right.capture : undefined;
      routes = capture?.navigation ?? [];
    }
  }
  const queue = homeState ? routes.map(link => ({link,parent:homeState!,depth:1})) : [];
  for (const recipe of priorStates) {
    if (bounded.aborted) {skip(recipe.path,recipe.id); continue;}
    const result = await collect(recipe.path,{stateId:recipe.id,from:'right'});
    const routeOnly = recipe.steps.every(step => 'target' in step && step.navigationPath);
    if (result?.right.status === 'captured' && routeOnly) {
      visited.add(recipe.path);
      if (recipe.steps.length < 3) queue.push(...(result.right.capture.navigation ?? [])
        .map(link => ({link,parent:recipe.id,depth:recipe.steps.length + 1})));
    }
  }
  for (const {link,parent,depth} of queue) {
    if (link.path === '/' || visited.has(link.path)) continue;
    visited.add(link.path);
    if (visited.size > maxPages || bounded.aborted) {skip(link.path); continue;}
    const result = await collect(link.path, {stateId:parent, step:{action:'click',target:{role:'link',name:link.name},navigationPath:link.path},from:'right'});
    if (result?.right.status === 'captured' && result.stateId && depth < 3) {
      queue.push(...(result.right.capture.navigation ?? []).map(next => ({link:next,parent:result.stateId!,depth:depth + 1})));
    }
  }
  signal.throwIfAborted();
  return {failures};
}

export function panoramaScreenshot(projectId: string, captureId: string, kind: string) {
  if (!z.uuid().safeParse(captureId).success || !['viewport', 'full'].includes(kind) ||
    !db.prepare('SELECT 1 FROM panorama_captures WHERE id=? AND project_id=?').get(captureId, projectId)) {
    throw new Error('截图不存在。');
  }
  const file = screenshotPath(captureId, kind);
  if (!isScreenshot(file)) throw new Error('此状态的截图文件缺失，请重试采集。');
  return file;
}

export function panoramaRepairScope(projectId: string, version: string, stateId: string, issueId: string) {
  const recipe = recipes(projectId).find(item => item.id === stateId);
  const evidence = recipe && cached(projectId, version, stateId)?.capture;
  const issue = evidence?.issues.find(item => item.id === issueId);
  const scope = recipe && (recipe.steps.length ? recipe.id : documentPath(recipe.start));
  const attempt = scope && db.prepare('SELECT status FROM panorama_attempts WHERE project_id=? AND snapshot_id=? AND scope=?')
    .get(projectId,version,scope) as {status:string}|undefined;
  if (attempt && attempt.status !== 'completed') throw new Error('该状态的最新检测未完成，请重新扫描。');
  if (!recipe || !issue?.source || issue.ruleId !== 'button-name' || !issue.selector) {
    throw new Error('全景 V1 只支持可定位到原始源码的原生按钮名称修复。');
  }
  const original = site(projectId, version);
  const entry = issue.source.key ? original.entry : issue.source.file;
  if (!documents(original).includes(entry)) throw new Error('目标页面不是可用的项目源码。');
  return { recipe, site: original, entry, issue: {
    ...issue, source: issue.source.key ? {...issue.source, key: issue.source.key} : undefined,
    impact: issue.impact ?? 'unknown', html: issue.html ?? '', helpUrl: '', wcag: ['4.1.2'],
  } };
}

export async function previewPanorama(projectId: string, version: string, stateId: string, dir: string, target: string, signal?: AbortSignal) {
  const recipe = recipes(projectId).find(item => item.id === stateId);
  if (!recipe) throw new Error('未找到预览状态。');
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
  return withReplay({...site(projectId, version), dir}, recipe, bounded, async page => {
    const semantics = await inspectPageElement(page, target);
    const {width,height} = semantics.size;
    const screenshot = width * height <= 4_000_000
      ? 'data:image/jpeg;base64,' + (await page.screenshot({fullPage: true, mask: [page.locator(maskedFields)],
        maskColor: '#d7dde7', type: 'jpeg', timeout: 6000})).toString('base64') : null;
    return {semantics, screenshot, contrast: null};
  });
}

type RepairTarget = {stateId: string; issueId: string; target: string; value: string};

export async function verifyPanorama(projectId: string, snapshotId: string, candidateDir: string, signal?: AbortSignal, repair?: RepairTarget, candidateSnapshot?: string) {
  const tracked = recipes(projectId);
  if (!tracked.length) return null;
  const beforeSite = site(projectId, snapshotId);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(110000)]);
  const verified: {recipe:Recipe; evidence:Captured}[] = [];
  const shots: string[] = [];
  for (const recipe of tracked) {
    try {
      const previous = cached(projectId, snapshotId, recipe.id)?.capture;
      const before = previous?.scan?.interaction ? previous : (await capture(beforeSite, recipe, bounded)).capture;
      const scopedRepair = repair && repair.stateId === recipe.id ? repair : undefined;
      const shot = candidateSnapshot ? id() : undefined;
      if (shot) shots.push(shot);
      const replayed = await capture({...beforeSite, dir: candidateDir}, recipe, bounded, shot, scopedRepair?.target);
      const after = replayed.capture;
      if (scopedRepair && (after.issues.some(issue => issue.id === scopedRepair.issueId) ||
          replayed.targetSemantics?.role !== 'button' || replayed.targetSemantics?.name !== scopedRepair.value)) {
        throw new Error('按钮名称在同一交互状态下未通过 Chromium 语义和 axe 验证。');
      }
      const existingBehavior = new Set((before.scan?.interaction?.findings ?? []).filter(item => item.status === 'confirmed')
        .map(item => JSON.stringify([item.step,item.ruleId,item.selector])));
      const newBehavior = after.scan?.interaction?.findings.find(item => item.status === 'confirmed' &&
        !existingBehavior.has(JSON.stringify([item.step,item.ruleId,item.selector])));
      if (newBehavior) throw new Error('步骤 ' + newBehavior.step + ' · ' + newBehavior.explanation);
      const missing = after.resourceFailures?.find(item => !before.resourceFailures?.some(previous => previous.path === item.path && previous.type === item.type));
      if (missing) throw new Error('新增资源加载失败 · ' + missing.path);
      const violations = new Set(before.issues.map(issue => issue.id));
      const added = after.issues.find(issue => !violations.has(issue.id));
      if (added) throw new Error('新增 ' + added.ruleId + ' · ' + added.selector);
      if (before.keyboard.status !== 'completed' || after.keyboard.status !== 'completed') {
        throw new Error('键盘证据不完整，需人工验证。');
      }
      const keyboard = new Set(before.keyboard.findings.map(item => item.ruleId + '|' + item.selector));
      if (JSON.stringify(before.keyboard.tabSequence) !== JSON.stringify(after.keyboard.tabSequence) ||
        after.keyboard.findings.some(item => !keyboard.has(item.ruleId + '|' + item.selector))) {
        throw new Error('Tab 顺序变化或新增键盘待复核项。');
      }
      const otherPage = recipe.path.split('#')[0] !== '/' + beforeSite.entry.split('/').map(encodeURIComponent).join('/') ||
        recipe.path.includes('#');
      if ((after.width > 900 && after.width > before.width) ||
        (otherPage && (before.layout !== after.layout || before.style !== after.style || (!scopedRepair && before.ax !== after.ax)))) {
        throw new Error('其他页面或路由的计算样式、布局或可访问语义变化，需人工验证。');
      }
      verified.push({recipe,evidence:replayed});
    } catch (error) {
      for (const shot of shots) for (const kind of ['viewport','full']) fs.rmSync(screenshotPath(shot,kind),{force:true});
      const steps = recipe.steps.map(step => step.action + ('target' in step ? ' ' + safeText(step.target.name) : '')).join(' → ');
      throw new Error(`全景回归：${recipe.path} · ${recipe.label}${steps ? '（'+steps+'）' : ''}。 ${(error as Error).message}`);
    }
  }
  if (candidateSnapshot) db.transaction(() => {
    for (const {recipe,evidence} of verified) {
      save(projectId,candidateSnapshot,recipe,evidence);
      recordAttempt(projectId,candidateSnapshot,recipe.steps.length ? recipe.id : documentPath(recipe.start),evidence.capture.path,'completed');
    }
  })();
  return {name: '已采集状态复测', detail: `${tracked.length} 个已采集状态完成操作重放、axe 和键盘检查。`};
}
