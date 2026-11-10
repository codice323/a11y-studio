import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const testDirectory = process.env.NODE_ENV === 'production' ? undefined : process.env.A11Y_MAIL_TEST_DIR;
const apiKey = process.env.A11Y_RESEND_API_KEY;
const from = process.env.A11Y_MAIL_FROM;
export const mailEnabled = Boolean(testDirectory || (apiKey && from));

export async function deliverAccountMail(to:string, purpose:'verify'|'reset'|'upgrade', link:URL) {
  const subject = {verify:'验证 A11y Studio 邮箱',reset:'重置 A11y Studio 密码',upgrade:'确认保存 A11y Studio 游客项目'}[purpose];
  const text = subject+'\n'+link.href+'\n如果你没有发起此操作，可以忽略此邮件。';
  if (testDirectory) {
    await mkdir(testDirectory,{recursive:true,mode:0o700});
    const file = path.join(testDirectory, randomUUID()+'.json');
    const pending = file+'.tmp';
    try {
      await writeFile(pending,JSON.stringify({to,purpose,link:link.href}),{mode:0o600,flag:'wx'});
      await rename(pending,file);
    } finally {
      await rm(pending,{force:true});
    }
    return;
  }
  if (!apiKey || !from) throw new Error('Account mail disabled');
  const response = await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({from,to:[to],subject,text}),signal:AbortSignal.timeout(10_000),redirect:'error',
  });
  if (!response.ok) throw new Error('Account mail delivery rejected');
}
