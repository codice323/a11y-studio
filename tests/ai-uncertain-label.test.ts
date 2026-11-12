import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';

test('线索不足时调用模型提供待确认候选，明确标签仍使用本地证据', {timeout:60000}, async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-uncertain-name-'));
  process.env.A11Y_DATA_DIR=directory;
  const oldKey=process.env.AI_API_KEY;
  process.env.AI_API_KEY='mock-key';
  const {db}=await import('../apps/api/storage');
  try{
    const {createProject}=await import('../apps/api/import');
    const {runAudit}=await import('../apps/api/scan');
    const {createSourceProposal}=await import('../apps/api/repair');
    const html='<!doctype html><html lang="zh-CN"><title>报名</title><main><h1>报名</h1><form><input id="email"><input id="contact" type="email"><button>提交</button></form><a id="details" href="https://example.org/?token=topsecret"><svg aria-hidden="true"></svg></a></main></html>';
    const project=await createProject({captured:{name:'报名',files:new Map([['index.html',Buffer.from(html)]])}});
    const scan=await runAudit(project.id,project.currentSnapshot);
    const ambiguous=scan.issues.find(issue=>issue.ruleId==='label'&&issue.html.includes('id="email"'));
    const certain=scan.issues.find(issue=>issue.ruleId==='label'&&issue.html.includes('id="contact"'));
    const ambiguousLink=scan.issues.find(issue=>issue.ruleId==='link-name'&&issue.html.includes('id="details"'));
    assert.ok(ambiguous&&certain&&ambiguousLink);
    let calls=0;
    let isLink=false;
    const fetcher=t.mock.method(globalThis,'fetch',async (_url,options)=>{
      calls++;
      const request=JSON.parse(String(options?.body));
      if(calls===1){
        assert.ok(request.tools.some((tool:any)=>tool.function.name==='inspect_issue'));
        return Response.json({choices:[{message:{tool_calls:[
          {id:'one',type:'function',function:{name:'inspect_issue',arguments:'{}'}},
          {id:'two',type:'function',function:{name:'search_wcag',arguments:'{"query":"表单名称"}'}},
        ]}}],usage:{prompt_tokens:20,completion_tokens:8}});
      }
      const evidence=request.messages.find((message:any)=>message.role==='tool'&&message.tool_call_id==='one');
      if(isLink)assert.ok(!evidence.content.includes('topsecret'));
      else assert.ok(evidence.content.includes('email'));
      return Response.json({choices:[{message:{content:JSON.stringify({value:isLink?'查看报名详情':'邮箱',reason:'请确认实际用途。',needsReview:true})}}],
        usage:{prompt_tokens:30,completion_tokens:10}});
    });
    const result=await createSourceProposal(project.id,ambiguous.id,project.currentSnapshot,undefined);
    assert.equal('patch' in result,false);
    assert.equal(result.labelDecision,'needs-input');
    assert.equal(result.suggestedValue,'邮箱');
    assert.equal(result.agentRun.usage.requests,2);
    assert.equal(result.agentRun.usage.inputTokens,50);
    assert.ok(result.agentTrace.some((item:any)=>item.tool==='search_wcag'));
    assert.equal((db.prepare('SELECT count(*) AS n FROM proposals').get() as {n:number}).n,0);
    const clear=await createSourceProposal(project.id,certain.id,project.currentSnapshot,undefined);
    assert.equal(calls,2);
    assert.equal(clear.analysis?.agentRun?.usage.requests,0);
    calls=0;isLink=true;
    const link=await createSourceProposal(project.id,ambiguousLink.id,project.currentSnapshot,undefined);
    assert.equal('patch' in link,false);
    assert.equal(link.linkDecision,'needs-input');
    assert.equal(link.suggestedValue,'查看报名详情');
    assert.equal(link.agentRun.usage.requests,2);
    fetcher.mock.mockImplementationOnce(async()=>new Response('{}',{status:503}));
    const unavailable=await createSourceProposal(project.id,ambiguous.id,project.currentSnapshot,undefined);
    assert.equal('patch' in unavailable,false);
    assert.equal(unavailable.agentRun.usage.complete,false);
    assert.match(unavailable.reason,/AI 分析未完成/);
  }finally{
    if(oldKey===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=oldKey;
    db.close();fs.rmSync(directory,{recursive:true,force:true});
  }
});
