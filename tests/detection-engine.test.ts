import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { AxeResults, Result } from 'axe-core';
import { classifyAxeResults, WCAG_TAGS } from '../apps/api/scan-rules';
import { keyboardFindings } from '../apps/api/scan-behavior';

test('运行时 axe 规则清单与分类保留人工复核节点', () => {
  const require = createRequire(import.meta.url);
  const actualAxe = createRequire(require.resolve('@axe-core/playwright'))('axe-core');
  assert.ok(actualAxe.getRules(WCAG_TAGS).some((rule: { ruleId: string }) => rule.ruleId === 'button-name'));
  assert.ok(actualAxe.getRules(['best-practice']).some((rule: { ruleId: string }) => rule.ruleId === 'heading-order'));
  const result = (id: string, tags: string[]) => ({ id, tags, nodes: [{ target: ['#target'], any: [{ id: 'evidence' }] }] }) as Result;
  const violation = result('button-name', ['wcag2a']);
  const uncertain = result('color-contrast', ['wcag2aa']);
  const advice = result('heading-order', ['best-practice']);
  const raw = { violations: [violation, advice], incomplete: [uncertain], passes: [] } as unknown as AxeResults;
  assert.deepEqual(classifyAxeResults(raw), {
    violations: [violation], incomplete: [uncertain], passes: 0,
    bestPractices: { violations: [advice], incomplete: [] },
  });
});

test('键盘探查将跳过项、顺序与状态不一致标为待复核', () => {
  const base = { role: 'button', tabindex: 0, radio: false, managed: false, tabbableCandidate: true,
    focusStyle: '', declaredState: null, expanded: null, controlledHidden: null, kind: 'action' as const, context: '' };
  const controls = [
    { ...base, selector: '#skipped', tabindex: -1 },
    { ...base, selector: '#unreached' },
    { ...base, selector: '#radio', radio: true },
    { ...base, selector: '#managed', tabindex: -1, managed: true },
    { ...base, selector: '#first', tabindex: 1 },
    { ...base, selector: '#previous' },
    { ...base, selector: '#order', tabindex: 2 },
    { ...base, selector: '#expanded', expanded: 'true', controlledHidden: true },
  ];
  const results = keyboardFindings(controls, ['#first', '#order', '#previous', '#expanded'], false);
  assert.deepEqual(results.map(item => item.selector), ['#skipped', '#order', '#expanded']);
  const order = results.find(item => item.ruleId === 'focus-order-positive-tabindex');
  assert.equal(order?.evidence.overtakenSelector, '#previous');
  assert.equal(order?.evidence.overtakenTabPosition, 3);
  assert.ok(results.every(item => item.status === 'needs-review'));
  assert.ok(keyboardFindings(controls, ['#first', '#order', '#previous', '#expanded'], true).some(item => item.selector === '#unreached'));
});

test('AI 是可选复核流程，失败不改变扫描，人工决定不升级为确定违规', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-ai-audit-test-'));
  const previous = process.env.A11Y_DATA_DIR;
  process.env.A11Y_DATA_DIR = directory;
  const { audit, db } = await import('../apps/api/storage');
  const { requestAiAudit, decideAiFinding } = await import('../apps/api/audit-ai');
  const apiKey = process.env.AI_API_KEY;
  try {
    const original = { issues: [{ id: 'legacy-id' }], detection: {
      schemaVersion: 2, behavior: { semanticCandidates: [
        { selector: '#vague', name: '点击这里', role: 'link', kind: 'action', context: '课程报名' },
      ] },
    } };
    db.prepare('INSERT INTO audits VALUES(?,?,?,?,?,?,?)').run('audit1', 'project1', 'snapshot1', 'completed', JSON.stringify(original), null, new Date().toISOString());
    delete process.env.AI_API_KEY;
    await assert.rejects(requestAiAudit('project1', 'audit1'), /未配置/);
    assert.deepEqual(audit('audit1').result, original);
    process.env.AI_API_KEY = 'test-key';
    const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 429 }));
    await assert.rejects(requestAiAudit('project1', 'audit1'), /429/);
    assert.deepEqual(audit('audit1').result, original);
    fetcher.mock.mockImplementation(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ findings: [{ index: 0, explanation: '链接名称未交代目标。' }] }) } }],
    }));
    const batch = await requestAiAudit('project1', 'audit1');
    const [finding] = batch.findings;
    assert.equal(finding.decision, 'needs-review');
    assert.equal(finding.candidate.selector, '#vague');
    assert.throws(() => decideAiFinding('other-project', 'audit1', finding.id, 'accepted'), /未找到/);
    for (const decision of ['accepted', 'rejected', 'needs-review']) {
      assert.equal(decideAiFinding('project1', 'audit1', finding.id, decision).decision, decision);
      assert.equal(audit('audit1').result.detection.ai.findings[0].decision, decision);
    }
    assert.deepEqual(audit('audit1').result.issues, original.issues);
    assert.equal(fetcher.mock.callCount(), 2);
    await requestAiAudit('project1', 'audit1');
    assert.equal(fetcher.mock.callCount(), 2);
  } finally {
    if (apiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = apiKey;
    if (previous === undefined) delete process.env.A11Y_DATA_DIR;
    else process.env.A11Y_DATA_DIR = previous;
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
