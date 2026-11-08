import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fieldRecommendation, type FieldEvidence } from '../apps/api/field-label';

test('占位提示可补足用途，具体示例值不能单独命名字段', () => {
  const bare: FieldEvidence = { id:'', name:'', type:'text', autocomplete:'', placeholder:'', cue:'',
    nearby:'', formTitle:'', groupTitle:'', relatedName:'', description:'' };
  assert.equal(fieldRecommendation({ ...bare, placeholder:'请输入邮政编码' }).value,'邮政编码');
  assert.equal(fieldRecommendation({ ...bare, placeholder:'name@example.test' }).value,undefined);
});

const cases = [
  { key:'education-camel', expected:'学生姓名', body:'<section><h2>在线课程</h2><form><div><input id="learnerFullName"></div></form></section>' },
  { key:'application-name', expected:'申请人姓名', body:'<form><fieldset><legend>补助申请</legend><div><input name="applicant_name"></div></fieldset></form>' },
  { key:'misleading-email-id', expected:'电话号码', body:'<form><div><input type="tel" id="email"></div></form>' },
  { key:'misleading-phone-id', expected:'电子邮箱', body:'<form><p><input id="phone" autocomplete="email"></p></form>' },
  { key:'two-identifiers', expected:'邮政编码', body:'<form><div><div><input id="postalCode" name="postal_code"></div></div></form>' },
  { key:'visible-field-caption', expected:'Course topic', body:'<form><div><span>Course topic:</span><input name="field_3"></div></form>' },
  { key:'url-field', expected:'网址', body:'<form><p><input id="web_contact" type="url" autocomplete="url"></p></form>' },
  { key:'related-description', expected:'监护人姓名', body:'<form><p id="note">未成年人须提供监护资料。</p><div><input id="guardianName" aria-describedby="note"></div></form>' },
  { key:'id-only', expected:null, body:'<form><input id="email"><button>提交</button></form>' },
  { key:'conflicting-identifiers', expected:null, body:'<form><div><input id="postalCode" name="street_address"></div></form>' },
  { key:'no-context', expected:null, body:'<div><input></div>' },
  { key:'contradicting-native-hints', expected:null, body:'<form><div><input id="contact" type="email" autocomplete="tel"></div></form>' },
  { key:'unrelated-form-heading', expected:null, body:'<article><h2>购物结算</h2><form><div><input id="studentName"></div></form></article>' },
] as const;

test('13 种独立表单经真实浏览器扫描和原生标签预检，冲突或弱证据要求人工补充', {timeout:120000}, async () => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-field-context-'));
  const socket=net.createServer();
  socket.listen(0,'127.0.0.1');
  await once(socket,'listening');
  const port=(socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const base='http://127.0.0.1:'+port;
  const server=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{
    env:{...process.env,PORT:String(port),A11Y_DATA_DIR:temp,AI_API_KEY:''},stdio:'ignore',
  });
  const stopped=once(server,'exit');
  async function api(route:string, body?:FormData|object) {
    const response=await fetch(base+route,body===undefined?{}:body instanceof FormData?{method:'POST',body}:{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    });
    const data=await response.json();
    assert.ok(response.ok, data.error);
    return data;
  }
  async function job(task:{id:string}) {
    for(let i=0;i<160;i++){
      const current=await api('/api/jobs/'+task.id);
      if(current.status==='completed')return current.result;
      if(current.status==='failed'||current.status==='cancelled')assert.fail(current.error);
      await delay(200);
    }
    assert.fail('任务超时');
  }
  const results=[];
  try {
    for(let i=0;i<50;i++){
      if(await fetch(base+'/api/status').then(r=>r.ok,()=>false))break;
      await delay(100);
    }
    for(const sample of cases){
      const form=new FormData();
      form.set('file',new Blob([`<!doctype html><html lang="zh-CN"><title>表单</title><main><h1>数据录入</h1>${sample.body}</main></html>`]),sample.key+'.html');
      const project=await api('/api/projects',form);
      const route='/api/projects/'+project.id;
      const audit=await job(await api(route+'/audits',{}));
      const issue=audit.issues.find((item:{ruleId:string})=>item.ruleId==='label');
      assert.ok(issue,sample.key);
      const result=await job(await api(route+'/issues/'+issue.id+'/proposals',{
        source:'agent',sourceRepair:true,snapshotId:project.currentSnapshot,
      }));
      const analysis=result.analysis ?? result;
      results.push({ key:sample.key, expected:sample.expected, actual:analysis.suggestedValue, preview:Boolean(result.patch), decision:analysis.labelDecision });
      assert.equal(analysis.suggestedValue,sample.expected,sample.key);
      if(sample.expected===null){
        assert.equal(result.patch,undefined,sample.key);
        assert.equal(analysis.labelDecision,'needs-input',sample.key);
        assert.match(analysis.reason,/字段|用途/);
      }else{
        assert.equal(analysis.labelDecision,'confirm',sample.key);
        assert.equal(result.patch.operation,'source',sample.key);
        assert.ok(result.after.includes('>'+sample.expected+'</label>'),sample.key);
        assert.ok(result.sourceReview.checks.length>0,sample.key);
        const current=await api(route);
        assert.equal(current.project.currentSnapshot,project.currentSnapshot);
      }
    }
  } finally {
    console.info('FIELD_CONTEXT '+JSON.stringify(results));
    server.kill('SIGTERM');
    await stopped;
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
