import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { guestLifetimeHours, newPasswordError, passwordLimits } from '../../../packages/shared/account';

import { rememberProject } from './project-location';
import { AccountMail, readMailLink, type MailView } from './AccountMail';

export type Account = {id:string;name:string;email:string;isGuest?:boolean;expiresAt?:string;emailVerified?:boolean;needsEmailVerification?:boolean};
const sessionChanged = 'a11y-studio.account-changed';

async function accountRequest(path:string,body?:object) {
  const response = await fetch('/api/auth/'+path,{cache:'no-store',...(body && {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  })});
  if (!response.ok) {
    const data = await response.json().catch(()=>null);
    if (response.status===401 && path==='upgrade-guest') window.dispatchEvent(new Event('a11y-auth-required'));
    throw new Error(data?.error ?? '账号服务暂时不可用。');
  }
  return response.json();
}

function notifyTabs() {
  try {localStorage.setItem(sessionChanged,String(Date.now()));} catch { /* Cookie sessions still apply. */ }
}

export function AccountGate({children}:{children:(account:Account,signOut:()=>Promise<void>,openUpgrade:()=>void,openVerification:()=>void)=>ReactNode}) {
  const [mailView,setMailView]=useState(readMailLink);
  const [account,setAccount] = useState<Account|null|undefined>(undefined);
  const [loadingError,setLoadingError] = useState('');
  const check = useRef(0);
  const wasSignedIn=useRef(false);
  const [upgrading,setUpgrading]=useState(false);
  const upgradeDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    function consumeMailLink() {
      const link=readMailLink();
      if (!link) return;
      const url=new URL(window.location.href);
      url.hash='';
      window.history.replaceState(null,'',url);
      upgradeDialog.current?.close();
      setUpgrading(false);
      setMailView(link);
    }
    consumeMailLink();
    window.addEventListener('hashchange',consumeMailLink);
    let active = true;
    const refresh = async (clear=false) => {
      const currentCheck = ++check.current;
      if (clear) setAccount(undefined);
      try {
        const session = await accountRequest('get-session');
        if (active && currentCheck===check.current) {
          setAccount(session?.user??null);
          setLoadingError(!session?.user && wasSignedIn.current ? '会话已过期，请重新登录。' : '');
          wasSignedIn.current=Boolean(session?.user);
          if (!session?.user?.isGuest) setUpgrading(false);
        }
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
      window.removeEventListener('hashchange',consumeMailLink);
      window.removeEventListener('storage',onStorage);
      window.removeEventListener('a11y-auth-required',onUnauthorized);
      window.removeEventListener('focus',onFocus);
    };
  },[]);

  useEffect(()=>{
    if (upgrading && !upgradeDialog.current?.open) upgradeDialog.current?.showModal();
  },[upgrading]);

  function cancelUpgrade() {upgradeDialog.current?.close();setUpgrading(false);}

  function acceptAccount(user:Account) {
    check.current++;
    wasSignedIn.current=true;
    setLoadingError('');
    cancelUpgrade();
    setMailView(undefined);
    setAccount(user);
    notifyTabs();
  }

  async function signOut() {
    await accountRequest('sign-out',{});
    check.current++;
    wasSignedIn.current=false;
    rememberProject(null);
    setMailView(undefined);
    setAccount(null);
    setLoadingError('');
    notifyTabs();
  }

  if (account === undefined) return <main className="account-shell"><p role="status">正在读取登录状态…</p></main>;
  const activeMail=mailView ?? (account?.needsEmailVerification?{mode:'resend' as const,email:account.email}:undefined);
  if (activeMail) return <AccountMail key={activeMail.mode} view={activeMail} send={accountRequest}
    onBack={()=>{
      if (!mailView && account?.needsEmailVerification) {void signOut();return;}
      setMailView(undefined);
      if (activeMail.mode==='reset') window.dispatchEvent(new Event('a11y-auth-required'));
    }}
    onVerified={()=>{
      if (account) void accountRequest('get-session').then(session=>{
        if (session?.user && activeMail.mode==='upgrade') acceptAccount(session.user);
        else setAccount(session?.user??null);
      }).catch(()=>{});
    }}
    pending={!mailView && Boolean(account?.needsEmailVerification)} onSignOut={account ? signOut : undefined} />;
  if (!account) return <SignIn statusError={loadingError} onSignIn={acceptAccount} onMail={setMailView} />;
  return <>
    {children(account,signOut,()=>setUpgrading(true),()=>setMailView({mode:'resend',email:account.email}))}
    {upgrading && account.isGuest && <dialog className="account-upgrade-dialog" ref={upgradeDialog}
      aria-label="保存我的项目" onCancel={event=>{
        event.preventDefault();
        if (upgradeDialog.current?.querySelector('form')?.getAttribute('aria-busy')!=='true') cancelUpgrade();
      }}>
      <SignIn statusError="" onSignIn={acceptAccount} onCancel={cancelUpgrade} />
    </dialog>}
  </>;
}

function SignIn({statusError,onSignIn,onCancel,onMail}:{statusError:string;onSignIn:(user:Account)=>void;onCancel?:()=>void;onMail?:(view:MailView)=>void}) {
  const upgrade=Boolean(onCancel);
  const [register,setRegister] = useState(upgrade);
  const fieldId=useId();
  const [showPassword,setShowPassword]=useState(false);
  const inFlight=useRef(false);
  const [email,setEmail] = useState('');
  const [password,setPassword] = useState('');
  const [confirmation,setConfirmation] = useState('');
  const [error,setError] = useState<{message:string;field?:'email'|'password'|'confirmation'}>();
  const [notice,setNotice] = useState('');
  const [verificationSent,setVerificationSent]=useState(false);
  const [busy,setBusy] = useState<'form'|'guest'|null>(null);
  const passwordProblem = register && password ? newPasswordError(password) : undefined;

  function switchMode(next:boolean) {
    setRegister(next);setError(undefined);setPassword('');setConfirmation('');setNotice('');setShowPassword(false);
  }

  async function submit(event:FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError(undefined);setNotice('');
    const invalidPassword = register && newPasswordError(password);
    if (invalidPassword) {setError({message:invalidPassword,field:'password'});return;}
    if (register && password!==confirmation) {setError({message:'两次输入的密码不一致。',field:'confirmation'});return;}
    inFlight.current=true;
    setBusy('form');
    try {
      const address = email.trim().toLowerCase();
      if (upgrade) {
        const session=await accountRequest('upgrade-guest',{email:address,password});
        if (session.pendingUpgrade) {
          setPassword('');setConfirmation('');
          setNotice('若邮箱可用于注册，请在当前浏览器打开邮件链接，确认保存项目。');
          return;
        }
        if (!session?.user || session.user.isGuest) throw new Error('无法读取正式登录会话，请重试。');
        onSignIn(session.user);
      } else if (register) {
        const result=await accountRequest('sign-up/email',{email:address,password,name:address.split('@')[0]});
        switchMode(false);
        setVerificationSent(Boolean(result.verificationRequired));
        setNotice(result.verificationRequired?'注册请求已处理。若邮箱可用于注册，请查收验证邮件。':'注册请求已处理，请使用邮箱和密码登录。');
        if(result.verificationRequired)onMail?.({mode:'resend',email:address});
      } else {
        await accountRequest('sign-in/email',{email:address,password,rememberMe:true});
        const session = await accountRequest('get-session');
        if (!session?.user) throw new Error('浏览器未建立登录会话。');
        onSignIn(session.user);
      }
    } catch (problem) {
      const message=(problem as Error).message;
      setError({message,field:register && message.includes('邮箱')?'email':message.includes('密码')?'password':undefined});
    } finally {inFlight.current=false;setBusy(null);}
  }

  async function signInGuest() {
    if (inFlight.current) return;
    setError(undefined);setNotice('');inFlight.current=true;setBusy('guest');
    try {
      const session = await accountRequest('sign-in/anonymous',{});
      if (!session?.user?.isGuest) throw new Error('未能建立游客会话，请重试。');
      onSignIn(session.user);
    } catch (problem) {setError({message:(problem as Error).message});}
    finally {inFlight.current=false;setBusy(null);}
  }

  function fieldError(field:NonNullable<typeof error>['field']) {
    return error?.field===field && <p className="account-error" role="alert" id={fieldId+'-'+field}>{error?.message}</p>;
  }
  const card=<section className="panel account-card" aria-labelledby={fieldId+'-title'}>
      <div className="account-brand">A11y Studio</div>
      <h1 id={fieldId+'-title'}>{upgrade?'保存我的项目':register?'注册账号':'登录'}</h1>
      <p className="muted">{upgrade?'注册后，当前游客项目和修复历史会保存在正式账号中。':'使用个人账号访问项目、检测记录和修复历史。'}</p>
      <form onSubmit={submit} aria-busy={Boolean(busy)}>
        <label>邮箱<input name="username" type="email" autoComplete="username" required maxLength={254} value={email}
          aria-invalid={error?.field==='email'} aria-describedby={error?.field==='email'?fieldId+'-email':undefined}
          onChange={event=>{setEmail(event.target.value);if(error?.field==='email') setError(undefined);}} /></label>
        {fieldError('email')}
        <div className="account-password">
          <label>密码<input name="password" type={showPassword?'text':'password'} autoComplete={register?'new-password':'current-password'}
            required value={password}
            aria-describedby={[register?fieldId+'-rules':'',error?.field==='password'?fieldId+'-password':''].filter(Boolean).join(' ')||undefined}
            aria-invalid={Boolean(passwordProblem || error?.field==='password')} onChange={event=>{setPassword(event.target.value);if(error?.field==='password') setError(undefined);}} /></label>
          <button className="secondary" type="button" onClick={()=>setShowPassword(!showPassword)}>{showPassword?'隐藏密码':'显示密码'}</button>
        </div>
        {fieldError('password')}
        {register && <>
          <p className="muted" id={fieldId+'-rules'}>使用 {passwordLimits.min}–{passwordLimits.max} 个字符。{passwordProblem && error?.field!=='password' && <span className="account-error"> {passwordProblem}</span>}</p>
          <label>确认密码<input name="confirm-password" type={showPassword?'text':'password'} autoComplete="new-password" required value={confirmation}
            aria-invalid={error?.field==='confirmation'} aria-describedby={error?.field==='confirmation'?fieldId+'-confirmation':undefined}
            onChange={event=>{setConfirmation(event.target.value);if(error?.field==='confirmation') setError(undefined);}} /></label>
          {fieldError('confirmation')}
        </>}
        {(error && !error.field || statusError) && <p role="alert" className="account-error">{error?.message || statusError}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="button dark" disabled={Boolean(busy)} type="submit">{busy==='form'?'处理中…':upgrade?'注册并保存项目':register?'注册':'登录'}</button>
      </form>
      <div className="account-entry-actions">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>upgrade?onCancel?.():switchMode(!register)}>
          {upgrade?'取消':register?'返回登录':'前往注册'}
        </button>
        {!register && <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>void signInGuest()}>
          {busy==='guest'?'正在进入…':'游客登录'}
        </button>}
      </div>
      {!register && <div className="account-entry-actions">
        <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>onMail?.({mode:'forgot',email})}>忘记密码</button>
        {verificationSent && <button className="secondary" type="button" disabled={Boolean(busy)} onClick={()=>onMail?.({mode:'resend',email})}>验证邮箱</button>}
      </div>}
      {!register && <small className="muted">游客数据临时保存 {guestLifetimeHours} 小时。</small>}
    </section>;
  return upgrade?card:<main className="account-shell">{card}</main>;
}
