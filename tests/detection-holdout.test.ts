import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Independent pages with task-based labels. The frozen 31-page dataset is separate.
const focus = 'focus-style-unchanged';
const order = 'focus-order-positive-tabindex';
const labels = [
  { id: 'fieldset-border', rule: focus, expected: false,
    body: '<fieldset><legend>通知设置</legend><button id="target">保存</button></fieldset>',
    css: 'fieldset{border:3px solid #777}fieldset:focus-within{border-color:#2542ad}' },
  { id: 'card-marker', rule: focus, expected: false,
    body: '<article><section><button id="target">下载账单</button></section></article>',
    css: 'article:focus-within::before{content:"→";color:#222;font-weight:900}' },
  { id: 'badge-ring', rule: focus, expected: false,
    body: '<label>短信验证 <input id="target"></label>',
    css: '#target:focus{box-shadow:0 0 0 4px #2424aa}' },
  { id: 'transparent-shadow', rule: focus, expected: true,
    body: '<button id="target">打开通知</button>',
    css: '#target:focus{box-shadow:0 0 0 4px rgba(45,90,160,0)}' },
  { id: 'invisible-wrapper', rule: focus, expected: true,
    body: '<div><button id="target">归档记录</button></div>',
    css: 'div{display:contents}div:focus-within{outline:3px solid #222}' },
  { id: 'transparent-border', rule: focus, expected: true,
    body: '<button id="target">保存草稿</button>',
    css: '#target{border:2px solid transparent}#target:focus{border-color:rgba(55,75,170,0)}' },
  { id: 'aligned-priorities', rule: order, expected: false,
    body: '<button tabindex="5">填写资料</button><button id="target" tabindex="8">预览</button><button>提交</button>',
    css: '', sequence: ['填写资料', '预览', '提交'] },
  { id: 'equal-priorities', rule: order, expected: false,
    body: '<button tabindex="2">查找</button><button id="target" tabindex="2">选择</button><button>保存</button>',
    css: '', sequence: ['查找', '选择', '保存'] },
  { id: 'later-step-jumps', rule: order, expected: true,
    body: '<button tabindex="2">选择日期</button><button>选择时段</button><button id="target" tabindex="3">确认预约</button>',
    css: '', sequence: ['选择日期', '确认预约', '选择时段'] },
  { id: 'mixed-priorities', rule: order, expected: true,
    body: '<button tabindex="3">配置付款</button><button id="target" tabindex="2">确认付款</button><button>完成</button>',
    css: '', sequence: ['确认付款', '配置付款', '完成'] },
  { id: 'removed-export', rule: 'keyboard-unreached', expected: true,
    body: '<button id="target" tabindex="-1">下载凭证</button><button>关闭</button>', css: '' },
  { id: 'radio-group', rule: 'keyboard-unreached', expected: false,
    body: '<label><input name="delivery" type="radio" checked> 邮箱</label><label><input id="target" name="delivery" type="radio"> 短信</label>',
    css: '' },
];

test('独立静态页面：真实 Tab、焦点提示与原生控件行为', { timeout: 90000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-holdout-'));
  process.env.A11Y_DATA_DIR = dataDir;
  const { db } = await import('../apps/api/storage');
  try {
    const { createProject } = await import('../apps/api/import');
    const { withSnapshotPage } = await import('../apps/api/scan');
    const { scanBehavior } = await import('../apps/api/scan-behavior');
    const errors: string[] = [];
    const results = [];
    for (const label of labels) {
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>独立样例</title>
        <style>#target:focus{outline:none}${label.css}</style><main><h1>设置</h1>${label.body}</main></html>`;
      const project = await createProject({ captured: { name: label.id, files: new Map([['index.html', Buffer.from(html)]]) } });
      const row = await withSnapshotPage(project.id, project.currentSnapshot, undefined, async page => {
        assert.equal(await page.locator('#target').count(), 1, label.id);
        const behavior = await scanBehavior(page);
        assert.equal(behavior.status, 'completed', label.id);
        const finding = behavior.findings.find(item => item.selector === '#target' && item.ruleId === label.rule);
        if (label.sequence) {
          const texts = [];
          for (const selector of behavior.tabSequence) texts.push(await page.locator(selector).innerText());
          assert.deepEqual(texts, label.sequence, label.id);
        }
        if (finding) assert.equal(finding.status, 'needs-review', label.id);
        return { id: label.id, rule: label.rule, expected: label.expected, flagged: Boolean(finding) };
      });
      results.push(row);
      if (row.flagged !== label.expected) errors.push(label.id);
    }
    console.log('HOLDOUT ' + JSON.stringify(results));
    assert.deepEqual(errors, []);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
