import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createInteractionAudit, readInteractionState } from '../apps/api/interaction-audit';
import { scanRules } from '../apps/api/scan-rules';

const cases = [
  {id:'dev-library', cohort:'development', label:'Open hours', action:'click', expected:'modal-focus-entry',
    html:'<button id="trigger" onclick="this.nextElementSibling.hidden=false">Open hours</button><section hidden role="dialog" aria-modal="true" aria-label="Hours"><button>Close</button></section>'},
  {id:'dev-service', cohort:'development', label:'Start application', action:'click', expected:null,
    html:'<button id="trigger" commandfor="application" command="show-modal">Start application</button><dialog id="application" aria-label="Application"><input aria-label="Reference" autofocus></dialog>'},
  {id:'dev-schedule', cohort:'development', label:'Filter', action:'click', expected:null, review:'expanded-state-mismatch',
    html:'<button id="trigger" aria-expanded="false" aria-controls="options" onclick="this.nextElementSibling.hidden=false">Filter</button><section id="options" hidden>Available now</section>'},
  {id:'dev-navigation', cohort:'development', label:'Details', action:'click', expected:null,
    html:'<button id="trigger" aria-expanded="false" aria-controls="options" onclick="this.setAttribute(\'aria-expanded\',\'true\');this.nextElementSibling.hidden=false">Details</button><section id="options" hidden>Open on Tuesday</section>'},
  {id:'holdout-garden', cohort:'holdout', label:'Preview plants', action:'click', expected:'modal-focus-entry',
    html:'<aside><button id="trigger" onclick="document.querySelector(\'article\').hidden=false">Preview plants</button></aside><article role="alertdialog" aria-modal="true" aria-label="Seed selection" hidden><h2>Seed selection</h2><button>Dismiss</button></article>'},
  {id:'holdout-station', cohort:'holdout', label:'Choose a ticket', action:'click', expected:null,
    html:'<nav><button id="trigger" onclick="const modal=document.querySelector(\'section\');modal.hidden=false;modal.querySelector(\'select\').focus()">Choose a ticket</button></nav><section hidden aria-modal="true" role="dialog" aria-label="Tickets"><label>Route <select><option>Express</option></select></label></section>'},
  {id:'holdout-directory', cohort:'holdout', label:'Show filters', action:'click', expected:null,
    html:'<button id="trigger" aria-expanded="false" aria-controls="filters" onclick="document.getElementById(\'filters\').showModal();this.setAttribute(\'aria-expanded\',\'true\')">Show filters</button><dialog id="filters" aria-label="Filters"><button autofocus>Close</button></dialog>'},
  {id:'holdout-catalog', cohort:'holdout', label:'Refresh availability', action:'click', expected:null, observed:'live-region-changed',
    html:'<button id="trigger" onclick="this.nextElementSibling.textContent=\'Three items available\'">Refresh availability</button><p role="status"></p>'},
] as const;

test('Chrome transitions preserve labelled positive and negative modal cases and keep advisory evidence separate', {timeout:60000}, async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const output = process.env.A11Y_PANORAMA_EVIDENCE;
  const results = [];
  try {
    for (const scenario of cases) {
      const context = await browser.newContext({viewport:{width:900,height:700}});
      try {
        const page = await context.newPage();
        await page.setContent('<!doctype html><html lang="en"><head><title>Task</title></head><body><main><h1>Task</h1>'+scenario.html+'</main></body></html>');
        const trigger = page.getByRole('button',{name:scenario.label,exact:true});
        await trigger.focus();
        const before = await readInteractionState(page);
        await trigger.click();
        const after = await readInteractionState(page);
        const started = performance.now();
        const base = await scanRules(page);
        const axeMs = performance.now() - started;
        const auditStart = performance.now();
        const findings = createInteractionAudit()(before,after,scenario.action,1,'#trigger');
        const evaluationMs = performance.now() - auditStart;
        assert.deepEqual(findings.filter(item=>item.status==='confirmed').map(item=>item.ruleId),scenario.expected ? [scenario.expected] : [],scenario.id);
        if ('review' in scenario) assert.ok(findings.some(item=>item.ruleId===scenario.review && item.status==='needs-review'));
        if ('observed' in scenario) assert.ok(findings.some(item=>item.ruleId===scenario.observed && item.status==='observed'));
        results.push({id:scenario.id,cohort:scenario.cohort,operation:scenario.label,expected:scenario.expected,
          baselineModalFinding:base.violations.some(rule => rule.id === 'modal-focus-entry' || rule.id === 'modal-tab-escape'),
          axeVersion:base.engine.version,axeViolations:base.violations.map(rule=>rule.id),
          findings,focus:[before.focus,after.focus],axeMs,evaluationMs});
      } finally { await context.close(); }
    }
    if (output) {
      await fs.mkdir(output,{recursive:true});
      await fs.writeFile(path.join(output,'interaction-results.json'),JSON.stringify({browser:browser.version(),results},null,2));
    }
  } finally { await browser.close(); }
});
