import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForModel, redactModelText } from '../apps/api/ai/redact';
import { runSourceAgent } from '../apps/api/repair-agent';

const call = (id: string, name: string, args: object = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('模型文本证据遮蔽常见身份信息和凭据，同时保留普通上下文', () => {
  const sample = '<input type="password" value="hello123"> 邮箱 xiaoli@example.com 手机 13812345678 sk-abcdefghijklmnop123456789';
  const result = redactModelText(sample);
  for (const secret of ['hello123', 'xiaoli@example.com', '13812345678', 'sk-abcdefghijklmnop123456789']) assert.ok(!result.includes(secret));
  assert.match(result, /input type="password"/);
  assert.deepEqual(redactForModel({apiKey:'private-value',label:'搜索',nested:['Bearer abc.def-123']}),
    {apiKey:'[已遮蔽凭据]',label:'搜索',nested:['Bearer [已遮蔽凭据]']});
});

test('图标 Agent 在可用时必须读取视觉证据，并且不会向模型发送原始敏感文本', async t => {
  const previousKey = process.env.AI_API_KEY;
  process.env.AI_API_KEY = 'local-test';
  t.after(() => { if (previousKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = previousKey; });
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push(body);
    if (requests.length === 1) return Response.json({choices:[{message:{tool_calls:[
      call('a','inspect_issue'),call('b','search_wcag',{query:'图标按钮名称'}),call('c','read_source'),call('d','inspect_browser'),
    ]}}]});
    if (requests.length === 2) return Response.json({choices:[{message:{content:JSON.stringify({plan:{kind:'button',value:'搜索'},reason:'根据上下文'})}}]});
    if (requests.length === 3) return Response.json({choices:[{message:{tool_calls:[call('e','read_visual')]}}]});
    return Response.json({choices:[{message:{content:JSON.stringify({plan:{kind:'button',value:'搜索'},reason:'图标与搜索框的上下文一致'})}}]});
  });
  let visualCalls = 0, validations = 0;
  const result = await runSourceAgent({issue:{ruleId:'button-name',html:'<button>邮箱 xiaoli@example.com</button>',selector:'button',help:'按钮缺少名称'},operation:'button',context:{}}, {
    instructions:'读取所需证据。', requiredReaders:['read_visual'],
    readers:{read_source:{description:'源码',run:()=>({html:'电话 13812345678'})},inspect_browser:{description:'浏览器',run:()=>({role:'button'})},
      read_visual:{description:'视觉',run:()=>{visualCalls++;return {suggestedValue:'搜索'};}}},
    validate:async plan=>{validations++;return plan;},
  });
  assert.equal(visualCalls,1);
  assert.equal(validations,1);
  assert.deepEqual(result.candidate,{kind:'button',value:'搜索'});
  assert.ok(requests[2].messages.some((message:any)=>message.role==='user'&&message.content.includes('read_visual')));
  assert.ok(!JSON.stringify(requests).includes('xiaoli@example.com'));
  assert.ok(!JSON.stringify(requests).includes('13812345678'));
});

test('源码 Agent 可以主动验证候选、根据失败调整，并复用已通过的候选', async t => {
  const previousKey=process.env.AI_API_KEY;
  process.env.AI_API_KEY='local-test';
  t.after(()=>{if(previousKey===undefined)delete process.env.AI_API_KEY;else process.env.AI_API_KEY=previousKey;});
  const requests:any[]=[];
  const first={kind:'button',value:'按钮',mode:'aria'};
  const improved={kind:'button',value:'搜索',mode:'aria'};
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const body=JSON.parse(String(options?.body));requests.push(body);
    if(requests.length===1)return Response.json({choices:[{message:{tool_calls:[
      call('early','validate_candidate',{plan:first}),
    ]}}]});
    if(requests.length===2)return Response.json({choices:[{message:{tool_calls:[
      call('issue','inspect_issue'),call('wcag','search_wcag',{query:'按钮 accessible name'}),
      call('source','read_source'),call('browser','inspect_browser'),
    ]}}]});
    if(requests.length===3)return Response.json({choices:[{message:{tool_calls:[call('bad','validate_candidate',{plan:first})]}}]});
    if(requests.length===4)return Response.json({choices:[{message:{tool_calls:[call('good','validate_candidate',{plan:improved})]}}]});
    return Response.json({choices:[{message:{content:JSON.stringify({plan:{mode:'aria',value:'搜索',kind:'button'},reason:'根据搜索框语境与复测结果'})}}]});
  });
  const checked:unknown[]=[];
  const result=await runSourceAgent({issue:{ruleId:'button-name',html:'<button></button>',selector:'button',help:'按钮缺少名称'},operation:'button',context:{}},{
    instructions:'先获取证据，验证计划。',readers:{
      read_source:{description:'读取源码',run:()=>({html:'<button></button>'})},
      inspect_browser:{description:'读取浏览器证据',run:()=>({nearby:'搜索'})},
    },validate:async plan=>{
      checked.push(plan);
      if((plan as {value:string}).value==='按钮')throw new Error('名称过于笼统');
      return {plan,checks:[{name:'无障碍复测',detail:'目标问题消失'}]};
    },
    summarizeValidation:candidate=>candidate.checks,
  });
  assert.equal(checked.length,2);
  assert.equal(result.attempts,2);
  assert.deepEqual(result.candidate,{plan:improved,checks:[{name:'无障碍复测',detail:'目标问题消失'}]});
  assert.ok(requests[1].messages.some((message:any)=>message.role==='tool'&&message.content.includes('验证前需要')));
  assert.ok(requests[3].messages.some((message:any)=>message.role==='tool'&&message.content.includes('名称过于笼统')));
  assert.ok(requests[4].messages.some((message:any)=>message.role==='tool'&&message.content.includes('"passed":true')));
  assert.ok(requests[4].messages.some((message:any)=>message.role==='tool'&&message.content.includes('目标问题消失')));
  assert.equal(result.trace.filter(item=>item.tool==='validate_source_patch').length,2);
});
