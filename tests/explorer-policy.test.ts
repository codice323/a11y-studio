import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorerBudget, explorerPlanner, safeExplorerLink } from '../apps/api/explorer';

test('Explorer rejects external, write-like and query-bearing navigation', () => {
  const allowed = (path:string,name='Documentation')=>safeExplorerLink(new URL(path,'http://a11y.local'),name);
  assert.ok(allowed('/guides/introduction'));
  assert.ok(allowed('/index.html#/guides'));
  assert.ok(allowed('/guides/a%20b.html'));
  for (const path of ['/checkout','/account/delete','/account/%6cogout','/guide?submit=true',
    '/account/register','/guide.zip','/guide#download','http://127.0.0.1/private','https://example.org/guide']) {
    assert.equal(allowed(path),false,path);
  }
  assert.equal(allowed('/other','确认付款'),false);
});

test('Explorer budgets cannot be raised by an environment override, and guests get lower caps', () => {
  const current = process.env.A11Y_EXPLORER_PAGES;
  try {
    process.env.A11Y_EXPLORER_PAGES = '50000';
    assert.equal(explorerBudget(false).pages,20);
    assert.equal(explorerBudget(true).pages,4);
    process.env.A11Y_EXPLORER_PAGES = '2';
    assert.equal(explorerBudget(false).pages,2);
    process.env.A11Y_EXPLORER_PAGES = '0';
    assert.equal(explorerBudget(true).pages,4);
  } finally {
    if (current === undefined) delete process.env.A11Y_EXPLORER_PAGES;
    else process.env.A11Y_EXPLORER_PAGES = current;
  }
});

test('Planner ranks opaque indices only, falls back on invalid indices, and respects its call cap', async t => {
  const settings = ['AI_API_KEY','A11Y_EXPLORER_AI_CALLS'] as const;
  const saved = settings.map(key=>process.env[key]);
  t.after(()=>settings.forEach((key,index)=>{
    if (saved[index] === undefined) delete process.env[key];
    else process.env[key] = saved[index];
  }));
  process.env.AI_API_KEY='test-key';
  process.env.A11Y_EXPLORER_AI_CALLS='2';
  const signal=new AbortController().signal;
  const steps=[
    {action:'click',target:{role:'link',name:'Private label'},navigationPath:'/private-path',explorer:true},
    {action:'toggle-details',name:'Private accordion'},
  ] as const;
  let calls = 0;
  const request=t.mock.method(globalThis,'fetch',async (_url:unknown,init:RequestInit)=>{
    const payload=JSON.parse(String(init.body));
    assert.doesNotMatch(JSON.stringify(payload),/Private|private-path/);
    const index=++calls === 1 ? 1 : 999;
    return Response.json({choices:[{message:{content:JSON.stringify({index})}}],usage:{prompt_tokens:40,completion_tokens:5}});
  });
  assert.equal(await explorerPlanner(false).choose([...steps],signal),undefined);
  const first=explorerPlanner(true);
  assert.equal(await first.choose([...steps],signal),1);
  assert.equal(await first.choose([...steps],signal),undefined);
  assert.equal(first.stats.inputTokens,40);
  const invalid=explorerPlanner(true);
  assert.equal(await invalid.choose([...steps],signal),undefined);
  assert.equal(invalid.stats.fallbacks,1);
  assert.equal(await explorerPlanner(true).choose([...steps],signal),undefined);
  assert.equal(request.mock.callCount(),2);
});
