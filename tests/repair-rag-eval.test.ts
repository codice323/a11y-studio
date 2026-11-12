import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

test('修复评估对每个案例以相同页面证据调用两种方案并保存人工审核字段', {timeout:30000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'a11y-rag-eval-'));
  const requests: any[] = [];
  const server = http.createServer(async (req,res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({suggestion:null,reason:'需要确认用途',refs:['WCAG 1.1.1']})}}],usage:{prompt_tokens:1,completion_tokens:1}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const output = path.join(dir,'report.json');
    const runner = spawn(process.execPath,['--import','tsx','scripts/evaluate-repair-rag.ts','--live','--output',output],{
      cwd:process.cwd(),env:{...process.env,AI_API_KEY:'test-key',AI_BASE_URL:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,A11Y_DATA_DIR:dir},stdio:['ignore','ignore','pipe'],
    });
    let stderr = '';
    runner.stderr.on('data',chunk=>{stderr+=chunk;});
    const exit = await new Promise<number|null>((resolve,reject)=>{runner.once('error',reject);runner.once('exit',resolve);});
    assert.equal(exit,0,stderr);
    assert.equal(requests.length,16);
    const first = JSON.parse(requests[0].messages[1].content), second = JSON.parse(requests[1].messages[1].content);
    assert.equal(first.evidence,second.evidence);
    assert.equal(first.wcag.length,0);
    assert.ok(second.wcag.length>0);
    const report = JSON.parse(fs.readFileSync(output,'utf8'));
    assert.equal(report.cases.length,8);
    assert.equal(report.cases[0].withRetrieval.humanReview.appropriate,null);
    assert.equal(report.cases[0].withoutRetrieval.referenceMatched,true);
    assert.equal(report.cases[0].withoutRetrieval.answer.suggestion,null);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
