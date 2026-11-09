import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { Control, PanoramaCapture, PanoramaComparison, PanoramaIssue, PanoramaSide, PanoramaStep } from '../../packages/shared/panorama';
import { scanBehavior } from './scan-behavior';
import { scanRules } from './scan-rules';
import { inspectPageElement, withRepairPage } from './scan';
import { originAttribute, sourceSelector, type buildReactProject } from './project-build';
import { DATA, db, hash, id, project, snapshot, snapshotDir, walk } from './storage';
import { validSnapshots } from './version-state';

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
  z.object({ action: z.enum(['click', 'validate', 'fill']), target: control }),
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
  return [entry, ...walk(dir).filter(file => file !== entry && /\.html?$/i.test(file)).sort()].slice(0, maxPages);
}

function selectedVersions(projectId: string, left: string, right: string) {
  const available = new Set(validSnapshots(projectId).map(item => item.id));
  if (!available.has(left) || !available.has(right)) throw new Error('请选择当前项目的两个有效版本。');
  return { left: site(projectId, left), right: site(projectId, right) };
}

export function panoramaInventory(projectId: string, left: string, right: string) {
  const versions = selectedVersions(projectId, left, right);
  const counts = db.prepare(`SELECT recipe_id, snapshot_id, json_array_length(data, '$.capture.issues') AS count
    FROM panorama_captures WHERE project_id=? AND snapshot_id IN (?,?)`).all(projectId, left, right) as
    {recipe_id: string; snapshot_id: string; count: number}[];
  return {
    pages: [...new Set([...documents(versions.left), ...documents(versions.right)])],
    recipes: recipes(projectId).map(({checkpoints: _, ...recipe}) => ({
      ...recipe, counts: Object.fromEntries(counts.filter(row => row.recipe_id === recipe.id)
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

async function act(page: Page, step: PanoramaStep, signal: AbortSignal) {
  signal.throwIfAborted();
  if (step.action === 'tab' || step.action === 'shift-tab' || step.action === 'escape') {
    await page.keyboard.press({ tab: 'Tab', 'shift-tab': 'Shift+Tab', escape: 'Escape' }[step.action]);
  } else if (step.action === 'scroll') {
    await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), step.y);
  } else if ('target' in step) {
    if (safeText(step.target.name) !== step.target.name) throw new Error('控件名称可能含个人数据，无法保存重放。');
    if (/(支付|删除|发送|购买|付款|注销|下单|\b(?:pay|buy|delete|send|purchase|checkout)\b)/i.test(step.target.name)) {
      throw new Error('此控件可能产生业务副作用，已阻止。');
    }
    const target = page.getByRole(step.target.role, { name: step.target.name, exact: true });
    if (await target.count() !== 1 || !await target.isVisible() || !await target.isEnabled()) {
      throw new Error('目标控件不存在、不唯一或不可操作。');
    }
    const eligibility = await target.evaluate(el => {
      if (el instanceof HTMLAnchorElement) {
        const link = new URL(el.href, location.href);
        if (link.origin !== location.origin || link.search || el.hasAttribute('download') ||
            el.target && el.target !== '_self') return 'blocked';
      }
      if (el instanceof HTMLInputElement && /^(password|file|hidden|email|tel)$/i.test(el.type)) return 'sensitive';
      if (el instanceof HTMLButtonElement && el.form && el.type === 'submit' ||
          el instanceof HTMLInputElement && /^(submit|image|reset)$/i.test(el.type)) return 'submission';
      return 'local';
    });
    if (step.action === 'validate') {
      if (eligibility !== 'submission') throw new Error('请选择表单提交控件以触发原生校验。');
      await target.evaluate(el => {
        const form = (el as HTMLButtonElement).form;
        if (!form || form.reportValidity()) throw new Error('表单当前没有原生校验错误，未执行提交。');
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
}

async function controlsFor(page: Page): Promise<Control[]> {
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

async function withReplay<T>(site: Site, recipe: Recipe, signal: AbortSignal, inspect: (
  page: Page, product: Awaited<ReturnType<typeof buildReactProject>> | undefined, checkpoints: Checkpoint[]
) => Promise<T>) {
  const start = recipe.start;
  if (!documents(site).includes(start)) throw new ReplayError('此版本中没有起始页面。');
  return withRepairPage(site.dir, site.entry, signal, async (page, product) => {
    page.setDefaultTimeout(3000);
    if (start !== site.entry) {
      await page.goto(origin + '/' + start.split('/').map(encodeURIComponent).join('/'), {waitUntil: 'load', timeout: 5000});
    }
    const checkpoints = [await checkpoint(page)];
    if (recipe.checkpoints[0] && !checkpointMatches(recipe.checkpoints[0], checkpoints[0])) {
      throw new ReplayError('两个版本的起始页面无法可靠匹配。', 0);
    }
    for (const [index, step] of recipe.steps.entries()) {
      try {
        await act(page, step, signal);
        const actual = await checkpoint(page);
        const expected = recipe.checkpoints[index + 1];
        if (expected && !checkpointMatches(expected, actual, step.action)) throw new Error('页面、状态、焦点或滚动位置不一致。');
        checkpoints.push(actual);
      } catch (error) {
        signal.throwIfAborted();
        throw new ReplayError((error as Error).message.split('\n')[0], index + 1);
      }
    }
    return inspect(page, product, checkpoints);
  }, 6500, true);
}

const maskedFields = 'input:not([type=button],[type=submit],[type=checkbox],[type=radio]),textarea,[contenteditable=true]';

async function capture(site: Site, recipe: Recipe, signal: AbortSignal, screenshotId?: string, target?: string) {
  return withReplay(site, recipe, signal, async (page, product, checkpoints) => {
    const final = checkpoints[checkpoints.length - 1];
    const size = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight,
    }));
    if (size.width > 2500 || size.height > 6000) throw new Error('页面尺寸超过全景采集上限。');
    const title = safeText((await page.title()).slice(0, 120));
    const ax = safeText((await page.locator('body').ariaSnapshot({timeout: 4000})).slice(0, 16000));
    const { dom, layout, styles } = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('body *')];
      if (nodes.length > 3500) throw new Error('DOM 超过全景采集上限。');
      const displayed = nodes.filter(node => node.getClientRects().length > 0);
      const dom = displayed.slice(0, 220).map(node =>
        '<' + node.localName + (node.id ? ' id=' + JSON.stringify(node.id) : '') +
        (node.hasAttribute('role') ? ' role=' + JSON.stringify(node.getAttribute('role')) : '') + '>');
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
    const actions = await controlsFor(page);
    const scanned = await scanRules(page);
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
        selector: safeText(selector), help: violation.help, description: violation.description, bounds, source });
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
      controls: actions, keyboard: {status: behavior.status, tabSequence: behavior.tabSequence.map(safeText),
        findings: behavior.findings.map(item => ({ruleId: item.ruleId, selector: safeText(item.selector), explanation: item.explanation}))},
      style: hash(JSON.stringify(styles)), layout: hash(JSON.stringify(layout)) } };
  });
}

function cached(projectId: string, version: string, recipeId: string): Captured | undefined {
  const row = db.prepare('SELECT data FROM panorama_captures WHERE project_id=? AND snapshot_id=? AND recipe_id=?')
    .get(projectId, version, recipeId) as {data: string} | undefined;
  if (row) return JSON.parse(row.data);
}

function save(projectId: string, version: string, recipe: Recipe, evidence: Captured) {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO panorama_recipes VALUES (?,?,?)')
      .run(recipe.id, projectId, JSON.stringify(recipe));
    db.prepare('INSERT INTO panorama_captures VALUES (?,?,?,?,?)')
      .run(evidence.capture.id, projectId, version, recipe.id, JSON.stringify(evidence));
  })();
}

const inputSchema = z.object({
  left: z.uuid(), right: z.uuid(),
  start: z.string().min(1).max(240).optional(),
  stateId: z.uuid().optional(), step: stepSchema.optional(),
  from: z.enum(['left', 'right']).default('left'),
});

const running = new Set<string>();

export async function collectPanorama(projectId: string, input: unknown, signal: AbortSignal,
  progress: (message: string) => void = () => {}) {
  if (running.has(projectId) || running.size >= 2) throw new Error('已有全景采集任务，请稍后重试。');
  running.add(projectId);
  try {
    const {left, right, start, stateId, step, from} = inputSchema.parse(input);
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
    if (!existing.some(item => item.id === recipe.id) && existing.length >= maxStates) {
      throw new Error('本项目已达到 12 个已采集状态上限。');
    }
    const versionsIds = {left, right};
    const result: PanoramaComparison = {
      stateId: null, left: {status: 'unmatched', error: '尚未采集。'}, right: {status: 'unmatched', error: '尚未采集。'},
    };
    const first = !recipe.checkpoints.length && !documents(versions[from]).includes(recipe.start)
      ? (from === 'left' ? 'right' : 'left') : from;
    const order = first === 'left' ? ['left', 'right'] as const : ['right', 'left'] as const;
    for (const [index, side] of order.entries()) {
      signal.throwIfAborted();
      progress(`步骤 ${index + 1}/2 · ${index ? '匹配并采集' : '采集'}${side === 'left' ? '左' : '右'}侧版本`);
      const version = versionsIds[side];
      const prior = cached(projectId, version, recipe.id);
      if (prior) {
        result.stateId = recipe.id;
        result[side] = {status: 'captured', capture: prior.capture};
        continue;
      }
      if (side !== first && recipe.checkpoints.length !== recipe.steps.length + 1) {
        result[side] = {status: 'unmatched', error: '起始版本没有成功进入状态，无法在另一侧匹配。'};
        continue;
      }
      const shot = id();
      try {
        const evidence = await capture(versions[side], recipe, signal, shot);
        signal.throwIfAborted();
        if (recipe.checkpoints.length < evidence.checkpoints.length) {
          recipe.checkpoints = evidence.checkpoints;
          recipe.path = evidence.capture.path;
        }
        save(projectId, version, recipe, evidence);
        result.stateId = recipe.id;
        result[side] = {status: 'captured', capture: evidence.capture};
      } catch (error) {
        for (const kind of ['viewport', 'full']) fs.rmSync(path.join(directory, shot + '-' + kind + '.jpg'), {force: true});
        signal.throwIfAborted();
        result[side] = {status: 'unmatched', error: (error as Error).message,
          ...(error instanceof ReplayError ? {step: error.step} : {})};
      }
    }
    return result;
  } finally { running.delete(projectId); }
}

export function panoramaScreenshot(projectId: string, captureId: string, kind: string) {
  if (!z.uuid().safeParse(captureId).success || !['viewport', 'full'].includes(kind) ||
    !db.prepare('SELECT 1 FROM panorama_captures WHERE id=? AND project_id=?').get(captureId, projectId)) {
    throw new Error('截图不存在。');
  }
  return path.join(directory, captureId + '-' + kind + '.jpg');
}

export function panoramaRepairScope(projectId: string, version: string, stateId: string, issueId: string) {
  const recipe = recipes(projectId).find(item => item.id === stateId);
  const evidence = recipe && cached(projectId, version, stateId)?.capture;
  const issue = evidence?.issues.find(item => item.id === issueId);
  if (project(projectId).mode === 'snapshot' || !recipe || !issue?.source || issue.ruleId !== 'button-name' || !issue.selector) {
    throw new Error('全景 V1 只支持可定位到原始源码的原生按钮名称修复。');
  }
  const original = site(projectId, version);
  const entry = issue.source.key ? original.entry : issue.source.file;
  if (!documents(original).includes(entry)) throw new Error('目标页面不是可用的项目源码。');
  return { recipe, site: original, entry, issue: {
    ...issue, source: issue.source.key ? {...issue.source, key: issue.source.key} : undefined,
    impact: 'unknown', html: '', helpUrl: '', wcag: ['4.1.2'],
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

export async function verifyPanorama(projectId: string, snapshotId: string, candidateDir: string, signal?: AbortSignal, repair?: RepairTarget) {
  const tracked = recipes(projectId);
  if (!tracked.length) return null;
  const beforeSite = site(projectId, snapshotId);
  const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(110000)]);
  for (const recipe of tracked) {
    try {
      const before = cached(projectId, snapshotId, recipe.id)?.capture ?? (await capture(beforeSite, recipe, bounded)).capture;
      const scopedRepair = repair && repair.stateId === recipe.id ? repair : undefined;
      const replayed = await capture({...beforeSite, dir: candidateDir}, recipe, bounded, undefined, scopedRepair?.target);
      const after = replayed.capture;
      if (scopedRepair && (after.issues.some(issue => issue.id === scopedRepair.issueId) ||
          replayed.targetSemantics?.role !== 'button' || replayed.targetSemantics?.name !== scopedRepair.value)) {
        throw new Error('按钮名称在同一交互状态下未通过 Chromium 语义和 axe 验证。');
      }
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
    } catch (error) {
      const steps = recipe.steps.map(step => step.action + ('target' in step ? ' ' + safeText(step.target.name) : '')).join(' → ');
      throw new Error(`全景回归：${recipe.path} · ${recipe.label}${steps ? '（'+steps+'）' : ''}。 ${(error as Error).message}`);
    }
  }
  return {name: '已采集状态复测', detail: `${tracked.length} 个已采集状态完成操作重放、axe 和键盘检查。`};
}
