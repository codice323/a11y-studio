import './helpers/account';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('未配置发信服务时拒绝新注册', {timeout:30000}, async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'a11y-mail-config-'));
  const probe=createServer().listen(0,'127.0.0.1');
  await once(probe,'listening');
  const port=(probe.address() as AddressInfo).port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const origin=`http://127.0.0.1:${port}`;
  const service=spawn(process.execPath,['--import','tsx','apps/api/server.ts'],{
    env:{...process.env,NODE_ENV:'test',PORT:String(port),BETTER_AUTH_URL:origin,A11Y_DATA_DIR:data,
      A11Y_MAIL_TEST_DIR:'',A11Y_RESEND_API_KEY:'',A11Y_MAIL_FROM:'',A11Y_ALLOW_UNVERIFIED_REGISTRATION:'',AI_API_KEY:''},
    stdio:'ignore',
  });
  try{
    for(let i=0;!(await fetch(origin+'/api/health').then(response=>response.ok,()=>false));i++){
      if(i>120||service.exitCode!==null)throw new Error('测试服务未能启动');
      await delay(100);
    }
    const response=await fetch(origin+'/api/auth/sign-up/email',{method:'POST',headers:{
      'content-type':'application/json',origin,
    },body:JSON.stringify({email:'mail-disabled@example.test',password:'Example-Password-123',name:'Test'})});
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:'账号邮件服务尚未配置。'});
  }finally{
    service.kill('SIGTERM');
    if(service.exitCode===null)await once(service,'exit');
    await rm(data,{recursive:true,force:true});
  }
});
