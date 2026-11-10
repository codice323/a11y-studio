import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorerBudget, safeExplorerLink } from '../apps/api/explorer';

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
