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
  await page.getByRole('heading', { name: '网页无障碍审阅', exact: true }).waitFor();
  await page.locator('.busy').waitFor({ state: 'hidden' });
}

// Seed saved captures directly so the tests also exercise projects created by older versions.
export async function seedBrowserCapture(page: Page, origin: string, dataDir: string, payload: unknown) {
  const session = await page.request.get(origin + '/api/auth/get-session');
  assert.ok(session.ok());
  const { user } = await session.json() as { user: { id: string } };
  process.env.A11Y_DATA_DIR = dataDir;
  const { importBrowserCaptureData } = await import('../../apps/api/browser-capture');
  return importBrowserCaptureData(payload, user.id);
}
