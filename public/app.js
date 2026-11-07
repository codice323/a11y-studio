const $ = (selector, root = document) => root.querySelector(selector);
const frame = $('#preview');
const scanButton = $('#scan');
const dialog = $('#issue-dialog');
let originalHtml = '';
let currentName = '示例网页';
let latestIssues = [];
let beforeCount = null;
let aiConfigured = false;
let engineReady = Promise.resolve();
frame.addEventListener('load', () => {
  engineReady = new Promise((resolve, reject) => {
    const script = frame.contentDocument.createElement('script');
    script.src = '/vendor/axe.min.js'; script.onload = resolve; script.onerror = () => reject(new Error('检测引擎加载失败'));
    frame.contentDocument.head.append(script);
  });
});

const sampleHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>慢绿生活</title><style>
*{box-sizing:border-box}body{margin:0;background:#fbfbf8;font-family:Arial,"Noto Sans SC",sans-serif;color:#28362d}header{height:56px;background:white;border-bottom:1px solid #eef0eb;display:flex;align-items:center;justify-content:space-between;padding:0 8%}.logo{font-weight:700;font-size:14px;color:#3e7652}.nav{display:flex;align-items:center;gap:24px;font-size:11px;color:#728373}.nav button{border:0;background:#eff5ed;color:#477a52;border-radius:50%;width:25px;height:25px}.main{padding:31px 8%;display:grid;grid-template-columns:1fr 145px;gap:22px;align-items:center}.tag{font-size:9px;letter-spacing:1.5px;color:#709d76;font-weight:700}.main h1{font-size:24px;line-height:1.3;margin:10px 0}.main p{font-size:11px;color:#b5bdb2;line-height:1.8;margin:0 0 15px}.main img{width:145px;height:125px;border-radius:10px;object-fit:cover}.join{display:flex;gap:7px}.join input{width:160px;border:1px solid #e4ebe1;border-radius:5px;padding:8px;font-size:10px}.join button{border:0;border-radius:5px;background:#4d8060;color:white;padding:8px 12px;font-size:10px}.cards{display:flex;gap:10px;padding:0 8% 22px}.card{background:white;border:1px solid #edf1eb;border-radius:7px;padding:10px;flex:1}.card strong{display:block;font-size:10px}.card span{font-size:9px;color:#8c9c8e}
</style></head><body><header><span class="logo">◒ &nbsp;慢绿生活</span><div class="nav"><span>生活灵感</span><span>关于我们</span><button></button></div></header><main class="main"><div><div class="tag">A LITTLE GREENER</div><h1>为生活，留一点<br>自然的空间。</h1><p>在忙碌的日常里，发现那些简单而美好的时刻。<br>从一株植物开始，慢慢创造自己的绿色角落。</p><div class="join"><input type="email"><button type="button">订阅灵感</button></div></div><img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 170'%3E%3Crect width='200' height='170' fill='%23e3ede0'/%3E%3Ccircle cx='155' cy='35' r='20' fill='%23f6f3df'/%3E%3Cpath d='M95 136 C92 87 86 48 60 25 M96 135 C101 85 116 53 145 30' fill='none' stroke='%236f9474' stroke-width='4'/%3E%3Cellipse cx='71' cy='54' rx='14' ry='28' transform='rotate(-44 71 54)' fill='%2391b399'/%3E%3Cellipse cx='126' cy='59' rx='14' ry='28' transform='rotate(43 126 59)' fill='%237da587'/%3E%3Cellipse cx='76' cy='92' rx='12' ry='24' transform='rotate(-55 76 92)' fill='%237ca487'/%3E%3Cpath d='M70 125h56l-8 35H78z' fill='%23c6a98e'/%3E%3C/svg%3E"></main><div class="cards"><div class="card"><strong>01 &nbsp; 选择植物</strong><span>找到适合你的绿色伙伴</span></div><div class="card"><strong>02 &nbsp; 记录成长</strong><span>留意每一天的小变化</span></div><div class="card"><strong>03 &nbsp; 分享灵感</strong><span>与更多人一起慢下来</span></div></div></body></html>`;

const explanations = {
  'image-alt': ['图片缺少替代文本', '屏幕阅读器无法向用户描述这张图片。请结合图片用途填写有意义的描述；装饰图片可以留空。', '图片替代文本', 'alt'],
  'label': ['表单控件缺少标签', '使用屏幕阅读器时，用户可能不知道这个输入框的用途。', '输入框的名称', 'aria-label'],
  'button-name': ['按钮缺少可访问名称', '屏幕阅读器无法准确读出按钮的用途。', '按钮的名称', 'aria-label'],
  'color-contrast': ['文字与背景对比不足', '低视力用户或在强光环境下，可能难以看清这段文字。', '文字颜色（十六进制）', 'color'],
  'link-name': ['链接缺少可访问名称', '用户可能无法了解链接的目标或用途。', '链接的名称', 'aria-label'],
  'html-has-lang': ['页面缺少语言声明', '屏幕阅读器可能无法选择合适的朗读语言。', '页面语言代码', 'lang'],
  'document-title': ['页面缺少标题', '浏览器标签页和屏幕阅读器缺少可辨识的页面名称。', '页面标题', 'title']
};
const impactLabels = {critical:'严重', serious:'较严重', moderate:'中等', minor:'轻微'};
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 3200); }
function escapeText(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function safeDocument(input) {
  const clean = DOMPurify.sanitize(input, {WHOLE_DOCUMENT:true, FORBID_TAGS:['script','iframe','object','embed','form','base','link'], FORBID_ATTR:['srcset','action','formaction']});
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  const csp = doc.createElement('meta'); csp.httpEquiv='Content-Security-Policy'; csp.content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'self'; font-src data:; base-uri 'none'; form-action 'none'";
  doc.head.prepend(csp);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}
function render(input, name) {
  originalHtml = input; currentName = name; beforeCount = null; latestIssues = [];
  $('#preview-name').textContent = name.startsWith('http') ? '网址预览' : name; $('#address-name').textContent = name === '示例网页' ? 'sample-page.html' : name === '自定义网页' ? 'pasted-page.html' : name;
  const loaded = new Promise((resolve, reject) => frame.addEventListener('load', () => engineReady.then(resolve, reject), {once:true}));
  frame.srcdoc = safeDocument(input);
  $('#issue-count').textContent='—'; $('#list-count').textContent='0'; $('#result-badge').textContent='等待检测'; $('#result-badge').className='result-badge'; $('#scan-state').textContent='尚未开始';
  $('#preview-hint').textContent = name.startsWith('http') ? '网页已导入，可以开始检测' : `${name}已就绪，可以开始检测`;
  $('#result-list').innerHTML = '<div class="empty-state"><span class="empty-icon"><svg><use href="#i-scan"/></svg></span><b>准备好开始了吗？</b><p>点击“开始检测”，查看页面中可以改进的地方。</p></div>';
  return loaded;
}
function sortedIssues(items) { const weight={critical:0,serious:1,moderate:2,minor:3}; return [...items].sort((a,b)=>(weight[a.impact]??4)-(weight[b.impact]??4)); }
async function runScan() {
  if (!frame.contentDocument?.body) return toast('页面正在加载，请稍后再试。');
  scanButton.disabled=true; scanButton.querySelector('span').textContent='检测中…';
  try {
    await engineReady;
    const results = await frame.contentWindow.axe.run( {runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}});
    latestIssues = sortedIssues(results.violations);
    const count = latestIssues.reduce((sum, issue) => sum + issue.nodes.length, 0);
    if (beforeCount === null) beforeCount = count;
    $('#issue-count').textContent=count; $('#list-count').textContent=count; $('#result-badge').textContent='检测完成'; $('#result-badge').className='result-badge done';
    $('#scan-state').textContent = count < beforeCount ? `较首次减少 ${beforeCount-count} 项` : '检测完成';
    $('#preview-hint').textContent = results.incomplete.length ? `检测完成 · ${results.incomplete.length} 类检测项需进一步判断` : '检测完成 · 仍需人工检查';
    const list = $('#result-list'); list.replaceChildren();
    if (!latestIssues.length) { list.innerHTML='<div class="empty-state"><span class="empty-icon"><svg><use href="#i-check"/></svg></span><b>未发现自动检测问题</b><p>仍建议进行键盘操作和屏幕阅读器等人工检查。</p></div>'; }
    for (const [index, issue] of latestIssues.entries()) {
      const text = explanations[issue.id] || [issue.help, issue.description];
      const btn=document.createElement('button'); btn.type='button'; btn.className='issue-card';
      btn.innerHTML=`<span class="issue-icon">!</span><span class="issue-card-text"><span class="issue-card-title">${escapeText(text[0])}</span><span class="issue-card-desc">${escapeText(text[1])}</span><span class="issue-card-meta"><span class="severity ${issue.impact==='critical'?'critical':''}">${escapeText(impactLabels[issue.impact] || '待检查')}</span><span>${issue.nodes.length} 个元素</span></span></span><span class="issue-chevron">›</span>`;
      btn.addEventListener('click',()=>openIssue(index)); list.append(btn);
    }
  } catch (error) { console.error(error); toast('检测失败：' + error.message); }
  finally { scanButton.disabled=false; scanButton.querySelector('span').textContent='重新检测'; }
}
function openIssue(index) {
  const issue=latestIssues[index]; if (!issue) return;
  const node=issue.nodes[0]; const info=explanations[issue.id] || [issue.help, issue.description];
  const fixable=Boolean(info[3]); const detail=$('#issue-detail');
  detail.innerHTML=`<div class="dialog-kicker">ISSUE DETAIL · ${escapeText(issue.id)}</div><h2>${escapeText(info[0])}</h2><p class="dialog-lead">${escapeText(info[1])}</p><div class="detail-box"><b>受影响的元素 · 第 1 / ${issue.nodes.length} 个</b><div class="detail-code"></div></div><p class="dialog-message">自动检测提供线索；修复内容需要结合页面语境核对。<br><a href="${escapeText(issue.helpUrl)}" target="_blank" rel="noopener noreferrer">查看检测规则说明 ↗</a></p>${fixable?`<label class="detail-label" for="fix-value">${escapeText(info[2])}</label><input class="detail-input" id="fix-value" ${info[3]==='color'?'value="#233c2b" placeholder="#233c2b"':'placeholder="输入适合这个元素的内容"'}><div class="dialog-actions"><button type="button" id="apply-fix" class="button primary">应用到预览 <svg><use href="#i-arrow"/></svg></button><button type="button" id="ai-explain" class="button ghost">${aiConfigured?'AI 解释问题':'AI 解释 · 未配置'}</button></div><p class="dialog-message">${info[3]==='alt'?'装饰图片可以留空。': '修复仅应用于当前预览，完成后请重新检测。'}</p>`:`<div class="dialog-actions"><button type="button" id="ai-explain" class="button ghost">${aiConfigured?'AI 解释问题':'AI 解释 · 未配置'}</button></div><p class="dialog-message">此规则目前提供诊断信息，请手动检查和修复。</p>`}<div id="ai-answer" class="ai-answer" role="status"></div>`;
  $('.detail-code',detail).textContent=node.html;
  if (fixable) $('#apply-fix',detail).addEventListener('click',()=>applyFix(issue,node,info[3]));
  $('#ai-explain',detail).addEventListener('click',async(event)=>{
    const output=$('#ai-answer',detail);
    if(!aiConfigured) {output.textContent='请在项目目录的 .env 文件中配置 AI_API_KEY，并重启本地服务。配置说明见 README。';return;}
    event.currentTarget.disabled=true; output.textContent='正在获取解释…';
    try { const res=await fetch('/api/explain',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rule:issue.id,description:issue.description,html:node.html,fixType:info[3] || ''})}); const data=await res.json(); if(!res.ok) throw new Error(data.error || '请求失败'); output.textContent=data.text; if (data.suggestedValue && fixable) { const adopt=document.createElement('button'); adopt.type='button'; adopt.className='button ghost'; adopt.textContent='填入 AI 建议'; adopt.addEventListener('click',()=>{$('#fix-value',detail).value=data.suggestedValue; toast('已填入建议，请核对后应用。');}); output.append(document.createElement('br'),adopt); } } catch(error) {output.textContent='AI 解释失败：'+error.message;} finally {event.currentTarget.disabled=false;}
  });
  dialog.showModal();
}
function applyFix(issue,node,kind) {
  const value=$('#fix-value').value.trim();
  if (!value && kind!=='alt') return toast('请先填写修复内容。');
  if (kind==='color' && !/^#[0-9a-fA-F]{6}$/.test(value)) return toast('请输入六位十六进制颜色，例如 #233c2b。');
  const selector=node.target?.[0]; let element;
  try { element = typeof selector==='string' ? frame.contentDocument.querySelector(selector) : null; } catch { element=null; }
  if (!element) return toast('无法定位该元素，请重新检测。');
  if(kind==='color') element.style.setProperty('color',value,'important');
  else if(kind==='title') frame.contentDocument.title=value;
  else element.setAttribute(kind,value);
  dialog.close(); $('#preview-hint').textContent='预览已修改，请重新检测验证'; $('#result-badge').textContent='等待复测'; $('#result-badge').className='result-badge';
  toast('修复已应用到预览，请重新检测。');
}
$('#url-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button=$('#load-url'); const status=$('#url-status');
  button.disabled=true; button.querySelector('span').textContent='正在导入…'; status.textContent='正在获取网页，请稍候。';
  try {
    const response=await fetch('/api/import-url',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:$('#url-input').value.trim()})});
    const data=await response.json(); if(!response.ok) throw new Error(data.error || '导入失败');
    await render(data.html,data.url);
    status.textContent=`网页已导入，加载 ${data.stylesheetsLoaded}/${data.stylesheetsFound} 个外部样式表。动态内容、图片和部分资源可能缺失，请结合原网页人工核查。`;
    await runScan();
  } catch(error) {status.textContent='导入失败：'+error.message; toast(status.textContent);}
  finally {button.disabled=false;button.querySelector('span').textContent='导入并检测';}
});
$('#load-example').addEventListener('click',()=>{render(sampleHtml,'示例网页');toast('已加载示例网页。');});
$('#load-html').addEventListener('click',()=>{const html=$('#html-input').value.trim();if(!html)return toast('请先粘贴 HTML 内容。');render(html,'自定义网页');toast('已加载自定义网页。');});
$('#reset').addEventListener('click',()=>{render(originalHtml,currentName);toast('已恢复初始页面。');});
scanButton.addEventListener('click',runScan);
fetch('/api/status').then(r=>r.json()).then(data=>{aiConfigured=data.configured;}).catch(()=>{});
render(sampleHtml,'示例网页');
