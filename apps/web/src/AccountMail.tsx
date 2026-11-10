import { useRef, useState, type FormEvent } from 'react';
import { newPasswordError, passwordLimits } from '../../../packages/shared/account';

export type MailMode = 'forgot'|'resend'|'verify'|'reset'|'upgrade';
export type MailView = {mode:MailMode;token?:string;email?:string};

export function readMailLink():MailView|undefined {
  const hash=new URLSearchParams(window.location.hash.slice(1));
  const mode=hash.get('account');
  if (mode==='verify' || mode==='reset' || mode==='upgrade') return {mode,token:hash.get('token')??''};
}

export function AccountMail({view,send,onBack,onVerified,onSignOut,pending}:{view:MailView;
  send:(path:string,body:object)=>Promise<{mailAvailable?:boolean}>;onBack:()=>void;onVerified:()=>void;onSignOut?:()=>Promise<void>;pending?:boolean}) {
  const [email,setEmail]=useState(view.email??'');
  const [password,setPassword]=useState('');
  const [confirm,setConfirm]=useState('');
  const [show,setShow]=useState(false);
  const [busy,setBusy]=useState(false);
  const [success,setSuccess]=useState('');
  const [error,setError]=useState('');
  const [passwordInvalid,setPasswordInvalid]=useState(false);
  const lock=useRef(false);
  const title={forgot:'找回密码',resend:'验证邮箱',verify:'确认验证邮箱',reset:'设置新密码',upgrade:'确认保存游客项目'}[view.mode];
  const requestEmail=view.mode==='forgot'||view.mode==='resend';
  async function submit(event:FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    setError('');setSuccess('');setPasswordInvalid(false);
    if(view.mode==='reset'){
      const invalid=newPasswordError(password);
      if(invalid||password!==confirm){setPasswordInvalid(true);setError(invalid??'两次输入的密码不一致。');return;}
    }
    lock.current=true;setBusy(true);
    try {
      if(view.mode==='upgrade'){
        await send('complete-guest-upgrade',{token:view.token});
        setSuccess('项目已保存到正式账号。');
        onVerified();
      } else if(view.mode==='verify'){
        await send('confirm-email',{token:view.token});
        setSuccess('邮箱验证成功，可以返回登录。');
        onVerified();
      } else if(view.mode==='reset'){
        await send('complete-password-reset',{token:view.token,newPassword:password});
        setPassword('');setConfirm('');
        setSuccess('密码已重置。请使用新密码重新登录。');
      } else {
        const result=await send(view.mode==='forgot'?'forgot-password':'resend-verification',{email:email.trim().toLowerCase()});
        setSuccess(result.mailAvailable===false?'此环境尚未配置邮件发送。':view.mode==='forgot'?'如果该邮箱已验证且可以找回密码，你将收到重置邮件。':'如果该邮箱需要验证，你将收到验证邮件。');
      }
    } catch(problem){setError((problem as Error).message);}
    finally {lock.current=false;setBusy(false);}
  }
  return <main className="account-shell"><section className="panel account-card" aria-labelledby="mail-title">
    <div className="account-brand">A11y Studio</div>
    <h1 id="mail-title">{title}</h1>
    {view.mode==='resend' && <p className="muted">请打开邮件中的验证链接，也可以在这里重新申请。</p>}
    {view.mode==='upgrade' && <p className="muted">请在申请时使用的游客会话中确认此操作。</p>}
    {view.mode==='verify' && <p className="muted">确认使用本邮件链接验证邮箱。</p>}
    <form onSubmit={submit} aria-busy={busy}>
      {requestEmail && <label>邮箱<input name="username" type="email" autoComplete="username" required maxLength={254}
        value={email} onChange={event=>setEmail(event.target.value)} /></label>}
      {view.mode==='reset' && !success && <>
        <div className="account-password"><label>新密码<input name="password" type={show?'text':'password'} autoComplete="new-password"
          value={password} required aria-describedby={'reset-rules'+(passwordInvalid?' mail-error':'')} aria-invalid={passwordInvalid}
          onChange={event=>setPassword(event.target.value)} /></label>
          <button className="secondary" type="button" onClick={()=>setShow(!show)}>{show?'隐藏密码':'显示密码'}</button></div>
        <p id="reset-rules" className="muted">使用 {passwordLimits.min}–{passwordLimits.max} 个字符。</p>
        <label>确认新密码<input name="confirm-password" type={show?'text':'password'} autoComplete="new-password" required
          value={confirm} onChange={event=>setConfirm(event.target.value)} /></label>
      </>}
      {error && <p id="mail-error" className="account-error" role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
      {(!success||requestEmail) && <button type="submit" className="button dark" disabled={busy}>{busy?'处理中…':
        {forgot:'发送重置邮件',resend:'发送验证邮件',verify:'验证邮箱',reset:'保存新密码',upgrade:'确认保存项目'}[view.mode]}</button>}
    </form>
    {!pending && <button type="button" className="secondary" disabled={busy} onClick={onBack}>{onSignOut?'返回工作区':'返回登录'}</button>}
    {onSignOut && <button type="button" className="secondary" disabled={busy} onClick={()=>{
      if(lock.current) return;
      lock.current=true;setBusy(true);
      void onSignOut().catch(problem=>setError((problem as Error).message)).finally(()=>{lock.current=false;setBusy(false);});
    }}>退出登录</button>}
  </section></main>;
}
