import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchWcag } from '../apps/api/knowledge-search';
import { runRepairAgent } from '../apps/api/repair-agent';

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
  assert.equal(searchWcag('unknown-random-rule', '完全不相关').length, 0);
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
