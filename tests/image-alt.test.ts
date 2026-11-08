import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

test('图片建议使用浏览器实际像素，区分信息图、装饰图和人工确认，并可审核复测和回滚', {timeout:90000}, async t => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-image-alt-'));
  process.env.A11Y_DATA_DIR = data;
  const { db } = await import('../apps/api/storage');
  try {
    const { createProject } = await import('../apps/api/import');
    const { runAudit } = await import('../apps/api/scan');
    const { applyProposal, createProposal, rollback } = await import('../apps/api/repair');
    const { imageVisionConfigured } = await import('../apps/api/ai/vision');
    const image = fs.readFileSync(new URL('./fixtures/vision/bars.png', import.meta.url));
    const html = '<!doctype html><html lang="zh-CN"><title>图像测试</title><main><h1>两季度报名数据</h1>' +
      '<figure><img id="target" src="rainbow-elephant.png"><figcaption>按季度比较报名人数</figcaption></figure></main></html>';
    const project = await createProject({captured:{name:'图像测试',files:new Map([
      ['index.html', Buffer.from(html)], ['rainbow-elephant.png', image],
    ])}});
    const original = await runAudit(project.id, project.currentSnapshot);
    const issue = original.issues.find(item => item.ruleId === 'image-alt');
    assert.ok(issue);

    process.env.AI_BASE_URL = 'https://api.deepseek.com';
    process.env.AI_MODEL = 'deepseek-chat';
    process.env.AI_API_KEY = 'local-test';
    delete process.env.AI_VISION_MODEL;
    assert.equal(imageVisionConfigured(), false);
    assert.equal((await createProposal(project.id, issue.id, {source:'ai'})).status, 'needs-manual-review');
    process.env.AI_MODEL = 'deepseek-flash';
    assert.equal(imageVisionConfigured(), true);
    Object.assign(process.env,{AI_BASE_URL:'http://127.0.0.1:1',AI_VISION_MODEL:'local-vision'});
    let result = {purpose:'uncertain',description:'红柱较低，蓝柱较高。',contentAlt:'蓝柱比红柱高',reason:'请确认两列分别代表哪个季度。'};
    let pixels = '';
    const fetcher = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.equal(url,'http://127.0.0.1:1/chat/completions');
      const body = JSON.parse(options.body as string);
      assert.equal(body.model, 'local-vision');
      const [text, visual] = body.messages[1].content;
      assert.equal(text.type,'text');
      assert.ok(!text.text.includes('rainbow-elephant'));
      assert.equal(visual.type,'image_url');
      pixels = visual.image_url.url;
      assert.equal(pixels, 'data:image/png;base64,' + image.toString('base64'));
      return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
    });
    const uncertain = await createProposal(project.id, issue.id, {source:'agent'});
    assert.equal(uncertain.status,'needs-manual-review');
    assert.ok('description' in uncertain);
    assert.equal(uncertain.description,result.description);
    assert.ok(uncertain.sources?.length);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM proposals').get() as {count:number}).count,0);
    const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
    try {
      const page = await browser.newPage();
      const colors = await page.evaluate(async input => {
        const image = new Image();
        image.src = input;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const drawing = canvas.getContext('2d')!;
        drawing.drawImage(image,0,0);
        return [[28,51],[95,32]].map(([x,y]) => Array.from(drawing.getImageData(x,y,1,1).data));
      }, pixels);
      assert.ok(colors[0][0] > 180 && colors[0][2] < 100);
      assert.ok(colors[1][2] > 150 && colors[1][0] < 100);
    } finally { await browser.close(); }

    result = {purpose:'informative',description:'蓝柱高于红柱',contentAlt:'蓝柱高于红柱',reason:'用于比较季度报名人数。'};
    assert.equal((await createProposal(project.id, issue.id, {source:'ai'})).status,'image-analysis');
    await assert.rejects(createProposal(project.id, issue.id, {source:'manual',value:' ',imagePurpose:'informative'}), /非空/);
    const suggested = await createProposal(project.id, issue.id, {source:'manual',value:result.contentAlt,imagePurpose:'informative'});
    assert.ok('patch' in suggested);
    assert.match(suggested.after,/alt="蓝柱高于红柱"/);
    await assert.rejects(applyProposal(suggested.id), /人工确认/);
    const verified = await applyProposal(suggested.id,undefined,true);
    assert.equal(verified.status,'passed');
    assert.deepEqual(verified.imageReview,{purpose:'informative',confirmed:true});
    rollback(project.id, project.currentSnapshot);

    const decorativeHtml = '<!doctype html><html lang="zh-CN"><title>专题</title><main><h1>专题</h1>' +
      '<p>以下为分隔装饰。</p><img id="target" src="divider.png"><p>正文</p></main></html>';
    const decorative = await createProject({captured:{name:'装饰图片',files:new Map([
      ['index.html',Buffer.from(decorativeHtml)],['divider.png',image],
    ])}});
    const scan = await runAudit(decorative.id, decorative.currentSnapshot);
    const decorativeIssue = scan.issues.find(item=>item.ruleId==='image-alt')!;
    assert.ok(decorativeIssue);
    result = {purpose:'decorative',description:'蓝红色柱形图案',contentAlt:'蓝柱高于红柱',reason:'这里的图案仅用作分隔。'};
    assert.equal((await createProposal(decorative.id, decorativeIssue.id, {source:'ai'})).status,'image-analysis');
    await assert.rejects(createProposal(decorative.id, decorativeIssue.id, {source:'manual',value:''}), /显式选择/);
    const empty = await createProposal(decorative.id, decorativeIssue.id, {source:'manual',value:'',imagePurpose:'decorative'});
    assert.ok('patch' in empty);
    assert.equal(empty.patch.value,'');
    assert.match(empty.after,/alt=""/);
    assert.equal((await applyProposal(empty.id,undefined,true)).status,'passed');

    const linked = await createProject({captured:{name:'链接图片',files:new Map([
      ['index.html',Buffer.from(decorativeHtml.replace('<img id="target" src="divider.png">','<a href="#topic"><img id="target" src="divider.png"></a>'))],
      ['divider.png',image],
    ])}});
    const linkedScan = await runAudit(linked.id,linked.currentSnapshot);
    const linkedIssue = linkedScan.issues.find(item=>item.ruleId==='image-alt')!;
    assert.ok(linkedIssue);
    assert.equal((await createProposal(linked.id,linkedIssue.id,{source:'ai'})).status,'needs-manual-review');

    const broken = await createProject({captured:{name:'缺失资源',files:new Map([
      ['index.html',Buffer.from(decorativeHtml)],
    ])}});
    const brokenScan = await runAudit(broken.id,broken.currentSnapshot);
    const brokenIssue = brokenScan.issues.find(item=>item.ruleId==='image-alt')!;
    assert.ok(brokenIssue);
    const calls = fetcher.mock.callCount();
    assert.equal((await createProposal(broken.id,brokenIssue.id,{source:'ai'})).status,'needs-manual-review');
    assert.equal(fetcher.mock.callCount(),calls);
  } finally {
    db.close();
    fs.rmSync(data,{recursive:true,force:true});
  }
});
