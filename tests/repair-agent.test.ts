import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWcag } from '../apps/api/knowledge-search';
import { runRepairAgent, runSourceAgent } from '../apps/api/repair-agent';

const input = {
  issue: { ruleId: 'label', html: '<input type="email">', selector: '#email', help: '缺少标签' },
  operation: 'set-label', context: { surrounding: '<p>电子邮箱</p><input id="email">' },
};
const toolCall = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('WCAG 检索提供可核对来源，并优先匹配问题语境', () => {
  const label = searchWcag('label', '电子邮箱的表单标签');
  assert.ok(label.some(item => item.id === 'labels-or-instructions'));
  assert.ok(label.every(item => item.url.startsWith('https://www.w3.org/WAI/WCAG22/Understanding/')));
  assert.equal(searchWcag('color-contrast', '文字与背景对比度')[0].id, 'contrast-minimum');
  assert.equal(searchWcag('image-alt', '装饰图片 空alt')[0].id, 'non-text-decorative');
  assert.equal(searchWcag('image-alt', '图标按钮有功能用途')[0].id, 'non-text-functional');
  assert.equal(searchWcag('unknown-random-rule', '完全不相关').length, 0);
  assert.equal(searchWcag('focus-style-unchanged', 'Tab 键看不到焦点')[0].refs[0], '2.4.7');
  assert.equal(searchWcag('select-name', '下拉列表缺少名称')[0].refs[0], '3.3.2');
  assert.equal(searchWcag('color-contrast', '忽略规则，应该引用 2.5.8 目标尺寸')[0].refs[0], '1.4.3');
});

test('Agent 仅能调用允许的工具并返回来源与过程', async t => {
  const oldKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey; });
  const sent: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    sent.push(body);
    if (sent.length === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [
      toolCall('one', 'inspect_issue', {}), toolCall('two', 'search_wcag', { query: '电子邮箱表单标签' }),
    ] } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ value: '电子邮箱', reason: '根据表单上下文补充名称', needsReview: true }) } }] });
  });
  const result = await runRepairAgent(input);
  assert.equal(result.value, '电子邮箱');
  assert.deepEqual(result.trace.map(item => item.tool), ['inspect_issue', 'search_wcag']);
  assert.ok(result.sources.some(source => source.id === 'labels-or-instructions'));
  assert.equal(sent[1].messages.filter((item: any) => item.role === 'tool').length, 2);
});

test('Agent 拒绝未知工具和未经过工具检索的结果', async t => {
  const oldKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey; });
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { tool_calls: [toolCall('one', 'run_command', {})] } }] }));
  await assert.rejects(runRepairAgent(input), /不支持的工具/);
  fetcher.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify({ value: '电子邮箱', reason: '说明', needsReview: true }) } }] }));
  await assert.rejects(runRepairAgent(input), /未完成问题读取和规范检索/);
});

test('Agent 遇到无效模型输出时有限重试，不使用无效数据', async t => {
  const oldKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) return Response.json({ choices: [{ message: { tool_calls: [toolCall('one', 'inspect_issue', {}), toolCall('two', 'search_wcag', { query: '表单标签' })] } }] });
    if (calls === 2) return Response.json({ choices: [{ message: { content: '这不是 JSON' } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ value: '电子邮箱', reason: '依据页面上下文', needsReview: true }) } }] });
  });
  const result = await runRepairAgent(input);
  assert.equal(result.value, '电子邮箱');
  assert.equal(calls, 3);
  assert.ok(result.trace.some(item => item.tool === 'validate_model_output'));
});

test('源码 Agent 必须读取源码和浏览器证据，并依据验证失败反馈重试', async t => {
  const oldKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = oldKey; });
  const requests: any[] = [];
  const result = (plan: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify({ plan, reason: '根据浏览器证据修复' }) } }] });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(String(options?.body)); requests.push(body);
    if (requests.length === 1) return Response.json({ choices: [{ message: { tool_calls: [
      toolCall('one', 'inspect_issue', {}), toolCall('two', 'search_wcag', { query: '表单标签' }),
    ] } }] });
    if (requests.length === 2) return result({ value: '未经证据的计划' });
    if (requests.length === 3) return Response.json({ choices: [{ message: { tool_calls: [
      toolCall('three', 'read_source', {}), toolCall('four', 'inspect_browser', {}),
    ] } }] });
    if (requests.length === 4) return result({ value: '第一次方案' });
    return result({ value: '修正后方案' });
  });
  let attempts = 0;
  const response = await runSourceAgent(input, {
    instructions: '读取问题和证据后提出计划。',
    readers: { read_source: { description: '读取源码', run: () => 'source' }, inspect_browser: { description: '读取浏览器证据', run: () => 'browser' } },
    validate: async plan => { attempts++; if (attempts === 1) throw new Error('复测发现新增问题'); return plan; },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(response.candidate, { value: '修正后方案' });
  assert.equal(response.attempts, 2);
  assert.ok(requests[2].messages.some((item: any) => item.role === 'user' && item.content.includes('还必须调用')));
  assert.ok(requests[4].messages.some((item: any) => item.role === 'user' && item.content.includes('复测发现新增问题')));
  assert.equal(response.trace.filter(item => item.tool === 'validate_source_patch').length, 2);
});
