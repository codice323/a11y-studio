import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Result } from 'axe-core';
import { scanRules } from '../apps/api/scan-rules';

type Annotation = { selector: string; ruleIds: string[]; expected: boolean };
type Detected = { selector: string; ruleId: string; review: boolean };
const fixtureDir = new URL('./fixtures/detection/', import.meta.url);
const annotations: Annotation[] = JSON.parse(fs.readFileSync(new URL('annotations.json', fixtureDir), 'utf8'));

function nodes(rules: Result[], review: boolean): Detected[] {
  return rules.flatMap(rule => rule.nodes.flatMap(node => typeof node.target[0] === 'string'
    ? [{ selector: node.target[0], ruleId: rule.id, review }] : []));
}

function measure(detected: Detected[]) {
  const labels = annotations.filter(item => !item.ruleIds.includes('ai-name-context'));
  let tp = 0, fp = 0, fn = 0, tn = 0, review = 0, matched = 0;
  for (const label of labels) {
    const signals = detected.filter(item => label.selector === item.selector && label.ruleIds.includes(item.ruleId));
    if (signals.length) {
      matched++;
      if (signals.every(item => item.review)) review++;
      if (label.expected) tp++;
      else fp++;
    } else if (label.expected) fn++;
    else tn++;
  }
  return {
    tp, fp, fn, tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp + fn ? tp / (tp + fn) : null,
    manualReviewFraction: matched ? review / matched : null,
  };
}

test('人工标注样页上对比旧规则与 V2 的真实浏览器证据', { timeout: 90000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-detection-test-'));
  process.env.A11Y_DATA_DIR = dataDir;
  const { db, hash } = await import('../apps/api/storage');
  try {
    const { createProject } = await import('../apps/api/import');
    const { runAudit, withSnapshotPage } = await import('../apps/api/scan');
    const project = await createProject({ captured: {
      name: '标注评测样页',
      files: new Map([['index.html', fs.readFileSync(new URL('mixed.html', fixtureDir))]]),
    } });
    const { baseline, baselineMs } = await withSnapshotPage(project.id, project.currentSnapshot, undefined, async page => {
      const started = performance.now();
      const baseline = await scanRules(page, false);
      return { baseline, baselineMs: performance.now() - started };
    });
    const enhanced = await runAudit(project.id, project.currentSnapshot);
    const { detection } = enhanced;
    const oldViolations = nodes(baseline.violations, false);
    const newViolations = nodes(detection.violations, false);
    const canonical = (items: Detected[]) => items.map(item => item.ruleId + '|' + item.selector).sort();
    assert.deepEqual(canonical(newViolations), canonical(oldViolations), '原有确定违规选择器保持一致');
    assert.deepEqual(enhanced.issues.map(issue => issue.id).sort(),
      oldViolations.map(item => hash(item.ruleId + '|' + item.selector).slice(0, 20)).sort());
    const headingOrder = detection.bestPractices.violations.find(rule => rule.id === 'heading-order');
    assert.ok(headingOrder?.nodes.some(node => node.target[0] === '#heading-jump'));
    assert.ok(!enhanced.issues.some(issue => issue.ruleId === 'heading-order'));
    assert.ok(detection.violations.find(rule => rule.id === 'button-name')?.nodes.some(node =>
      node.target[0] === '#unnamed' && typeof node.html === 'string' && node.any.length > 0));
    assert.equal(detection.behavior.status, 'completed');
    for (const [ruleId, selector] of [
      ['keyboard-unreached', '#skipped'], ['focus-style-unchanged', '#focusless'],
      ['focus-order-positive-tabindex', '#priority'], ['empty-computed-control-name', '#unnamed'],
      ['expanded-visibility-mismatch', '#expanded'],
    ]) assert.ok(detection.behavior.findings.some(item => item.ruleId === ruleId && item.selector === selector), ruleId + ' ' + selector);
    assert.ok(!detection.behavior.findings.some(item => item.ruleId === 'focus-style-unchanged' && item.selector === '#good-focus'));
    assert.ok(detection.behavior.semanticCandidates.some(item => item.selector === '#bad-alt' && item.name === 'IMG_2031.png'));
    const oldTriage = [...oldViolations, ...nodes(baseline.incomplete, true)];
    const newTriage = [
      ...newViolations, ...nodes(detection.incomplete, true),
      ...nodes(detection.bestPractices.violations, true), ...nodes(detection.bestPractices.incomplete, true),
      ...detection.behavior.findings.map(item => ({ ...item, review: item.status === 'needs-review' })),
    ];
    console.log(JSON.stringify({
      engine: detection.engine.version,
      confirmedWcag: { original: measure(oldViolations), enhanced: measure(newViolations) },
      triage: { original: measure(oldTriage), enhanced: measure(newTriage) },
      elapsedMs: {
        original: baselineMs,
        enhanced: detection.timing.rulesMs + detection.timing.behaviorMs,
        enhancedStages: detection.timing,
      },
      timingNote: '排除首次加载、截图、原有补丁回归签名和存储。V2 行为耗时包含为重置 Tab 起点进行的重载。',
      excludedAiAnnotations: annotations.filter(item => item.ruleIds.includes('ai-name-context')).length,
    }));
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
