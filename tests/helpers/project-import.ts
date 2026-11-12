import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';

export async function importProjectFixture(page: Page, origin: string, file: {
  name: string; mimeType: string; buffer: Buffer;
}, mode?: 'source', diagnostics=false) {
  return page.request.post(origin + '/api/projects', {
    headers: { origin },
    multipart: { file, ...(mode ? { mode } : {}), ...(diagnostics ? {diagnostics:'true'} : {}) },
  });
}

export async function openImportedFixture(page: Page, origin: string, file: {
  name: string; mimeType: string; buffer: Buffer;
}, mode?: 'source', diagnostics=false) {
  const response = await importProjectFixture(page, origin, file, mode, diagnostics);
  assert.ok(response.ok(), await response.text());
  const project = await response.json();
  await page.goto(origin);
  await page.getByRole('button', { name: project.name, exact: true }).click();
  await page.getByRole('heading', { name: '网页无障碍工作台', exact: true }).waitFor();
  await page.locator('.busy').waitFor({ state: 'hidden' });
}
