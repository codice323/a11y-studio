import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { guestLifetimeHours, newPasswordError, passwordLimits } from '../../../packages/shared/account';

export type Account = {id:string;name:string;email:string;isGuest?:boolean;expiresAt?:string};
const sessionChanged = 'a11y-studio.account-changed';

async function accountRequest(path:string,body?:object) {
  const response = await fetch('/api/auth/'+path,{cache:'no-store',...(body && {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  })});
  if (!response.ok) {
    const data = await response.json().catch(()=>null);
    throw new Error(data?.error ?? '账号服务暂时不可用。');
  }
  return response.json();
}

function notifyTabs() {
  try {localStorage.setItem(sessionChanged,String(Date.now()));} catch { /* Cookie sessions still apply. */ }
}

export function AccountGate({children}:{children:(account:Account,signOut:()=>Promise<void>)=>ReactNode}) {
  const [account,setAccount] = useState<Account|null|undefined>(undefined);
  const [loadingError,setLoadingError] = useState('');
  const check = useRef(0);
  useEffect(()=>{
    let active = true;
    const refresh = async (clear=false) => {
      const currentCheck = ++check.current;
      if (clear) setAccount(undefined);
      try {
        const session = await accountRequest('get-session');
        if (active && currentCheck===check.current) {setAccount(session?.user??null);setLoadingError('');}
      } catch {
        if (active && currentCheck===check.current) {setAccount(null);setLoadingError('暂时无法读取登录状态，请重试。');}
      }
    };
    void refresh();
    const onStorage = (event:StorageEvent) => {if (event.key===sessionChanged) void refresh(true);};
    const onUnauthorized = () => {void refresh(true);};
    const onFocus = () => {void refresh();};
    window.addEventListener('storage',onStorage);
    window.addEventListener('a11y-auth-required',onUnauthorized);
    window.addEventListener('focus',onFocus);
    return ()=>{
      active=false;
      window.removeEventListener('storage',onStorage);
      window.removeEventListener('a11y-auth-required',onUnauthorized);
      window.removeEventListener('focus',onFocus);
    };
  },[]);

  if (account === undefined) return <main className="account-shell"><p role="status">正在读取登录状态…</p></main>;
  if (!account) return <SignIn statusError={loadingError} onSignIn={user=>{check.current++;setAccount(user);notifyTabs();}} />;
  return children(account,async()=>{
    await accountRequest('sign-out',{});
    check.current++;
    setAccount(null);
    notifyTabs();
  });
}

function SignIn({statusError,onSignIn}:{statusError:string;onSignIn:(user:Account)=>void}) {
  const [register,setRegister] = useState(false);
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [confirmation,setConfirmation] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [busy,setBusy] = useState<'form'|'guest'|null>(null);
  const passwordProblem = register && password ? newPasswordError(password) : undefined;

  function switchMode(next:boolean) {
    setRegister(next);setError('');setPassword('');setConfirmation('');setNotice('');
  }

  async function submit(event:FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');setNotice('');
    const invalidPassword = register && newPasswordError(password);
    if (invalidPassword) {setError(invalidPassword);return;}
    if (register && password!==confirmation) {setError('两次输入的密码不一致。');return;}
    setBusy('form');
    try {
      const address = email.trim().toLowerCase();
      if (register) {
        await accountRequest('sign-up/email',{email:address,password,name:address.split('@')[0]});
        switchMode(false);
        setNotice('注册请求已处理，请使用邮箱和密码登录。');
      } else {
        await accountRequest('sign-in/email',{email:address,password,rememberMe:true});
        const session = await accountRequest('get-session');
        if (!session?.user) throw new Error('浏览器未建立登录会话。');
        onSignIn(session.user);
      }
    } catch (problem) {setError((problem as Error).message);}
    finally {setBusy(null);}
  }

  async function signInGuest() {
    if (busy) return;
    setError('');setNotice('');setBusy('guest');
    try {
      const session = await accountRequest('sign-in/anonymous',{});
      if (!session?.user?.isGuest) throw new Error('未能建立游客会话，请重试。');
      onSignIn(session.user);
    } catch (problem) {setError((problem as Error).message);}
    finally {setBusy(null);}
  }

  return <main className="account-shell">
    <section className="panel account-card" aria-labelledby="account-title">
      <div className="account-brand">A11y Studio</div>
      <h1 id="account-title">{register?'注册账号':'登录'}</h1>
      <p className="muted">使用个人账号访问项目、检测记录和修复历史。</p>
      <form onSubmit={submit} aria-busy={Boolean(busy)}>
        <label>邮箱<input type="email" autoComplete="email" required maxLength={254} value={email}
          onChange={event=>setEmail(event.target.value)} /></label>
        <label>密码<input type="password" autoComplete={register?'new-password':'current-password'}
          required value={password}
          aria-describedby={register?'account-password-rules':undefined} aria-invalid={Boolean(passwordProblem)} onChange={event=>setPassword(event.target.value)} /></label>
        {register && <>
          <p className="muted" id="account-password-rules">使用 {passwordLimits.min}–{passwordLimits.max} 个字符。{passwordProblem && <span className="account-error"> {passwordProblem}</span>}</p>
          <label>确认密码<input type="password" autoComplete="new-password" required value={confirmation} onChange={event=>setConfirmation(event.target.value)} /></label>
        </>}
        {(error || statusError) && <p role="alert" className="account-error">{error || statusError}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="button dark" disabled={Boolean(busy)} type="submit">{busy==='form'?'处理中…':register?'注册':'登录'}</button>
      </form>
      <div className="account-entry-actions">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>switchMode(!register)}>
          {register?'返回登录':'前往注册'}
        </button>
        {!register && <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>void signInGuest()}>
          {busy==='guest'?'正在进入…':'游客登录'}
        </button>}
      </div>
      {!register && <small className="muted">游客数据临时保存 {guestLifetimeHours} 小时。</small>}
    </section>
  </main>;
}
