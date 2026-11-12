import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Resend 请求包含验证链接，拒绝时不会报告发送成功',async()=>{
  const saved={key:process.env.A11Y_RESEND_API_KEY,from:process.env.A11Y_MAIL_FROM,testDir:process.env.A11Y_MAIL_TEST_DIR,nodeEnv:process.env.NODE_ENV,fetch:globalThis.fetch};
  process.env.A11Y_RESEND_API_KEY='test-only';process.env.A11Y_MAIL_FROM='verify@example.test';delete process.env.A11Y_MAIL_TEST_DIR;process.env.NODE_ENV='test';
  try{
    const {mailEnabled,deliverAccountMail}=await import('../apps/api/mail-delivery');
    assert.equal(mailEnabled,true);
    let payload:any,headers:HeadersInit|undefined;
    globalThis.fetch=async(input,init)=>{
      assert.equal(String(input),'https://api.resend.com/emails');headers=init?.headers;payload=JSON.parse(String(init?.body));
      return new Response('{}',{status:200});
    };
    await deliverAccountMail('recipient@example.test','verify',new URL('http://127.0.0.1:4173/#account=verify&token=example'));
    assert.deepEqual(payload.to,['recipient@example.test']);
    assert.match(payload.text,/account=verify/);
    assert.equal(new Headers(headers).get('authorization'),'Bearer test-only');
    globalThis.fetch=async()=>new Response('{}',{status:403});
    await assert.rejects(deliverAccountMail('recipient@example.test','verify',new URL('http://127.0.0.1:4173/')),/rejected/);
  }finally{
    globalThis.fetch=saved.fetch;
    for(const [key,value] of [['A11Y_RESEND_API_KEY',saved.key],['A11Y_MAIL_FROM',saved.from],['A11Y_MAIL_TEST_DIR',saved.testDir],['NODE_ENV',saved.nodeEnv]] as const){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
