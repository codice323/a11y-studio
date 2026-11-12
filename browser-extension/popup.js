const button=document.getElementById('capture');
const status=document.getElementById('status');
const live=document.getElementById('live');
live.addEventListener('click',async()=>{
  live.disabled=true;button.disabled=true;
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id || !tab.url || !/^https?:/i.test(tab.url))throw new Error('请先打开需要操作的 HTTP 或 HTTPS 网页。');
    status.textContent='正在连接原网页，请保持 A11y Studio 服务运行。';
    const result=await chrome.runtime.sendMessage({type:'start-original-live',tabId:tab.id});
    if(!result?.ok)throw new Error(result?.error||'连接失败。');
  } catch(error){status.textContent=error instanceof Error?error.message:'连接失败。';}
  finally {live.disabled=false;button.disabled=false;}
});
button.addEventListener('click',async()=>{
  button.disabled=true;
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error('请打开需要检测的 HTTP 或 HTTPS 网页。');
    status.textContent='正在读取当前页面并运行无障碍检测…';
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['axe.min.js','capture.js']});
    const [item]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>await globalThis.a11yStudioCapture()});
    if (!item?.result) throw new Error('未能采集页面。');
    const [current]=await chrome.tabs.query({active:true,currentWindow:true});
    if(current?.id!==tab.id || current.url!==tab.url)throw new Error('采集期间页面或标签页发生变化，请回到目标页面重试。');
    let shot;
    let attached=false;
    try {
      await chrome.debugger.attach({tabId:tab.id},'1.3');
      attached=true;
      shot=await globalThis.a11yStudioCaptureScreenshot({tabId:tab.id});
    } catch {
      const screenshot=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
      if((screenshot.length-'data:image/png;base64,'.length)*0.75>4000000)throw new Error('截图超过 4 MB，请缩小浏览器窗口后重试。');
      shot={data:screenshot.slice('data:image/png;base64,'.length),fullPage:false};
    } finally {
      if(attached)try{await chrome.debugger.detach({tabId:tab.id});}catch{}
    }
    const data={...item.result,screenshot:'data:image/png;base64,'+shot.data,screenshotFullPage:shot.fullPage};
    if(!shot.fullPage)data.limitations.push('原始截图受浏览器限制，仅覆盖当前可见区域。');
    const bytes=new TextEncoder().encode(JSON.stringify(data));
    if(bytes.length>8*1024*1024)throw new Error('采集文件超过 8 MB，请尝试较小的页面。');
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'}));
    try {
      const downloadId=await chrome.downloads.download({url,filename:'a11y-studio-capture.json',saveAs:false,conflictAction:'uniquify'});
      await new Promise((resolve,reject)=>{
        let finished=false;
        const timer=setTimeout(()=>finish(new Error('保存超时，请重试。')),60000);
        function finish(error){if(finished)return;finished=true;clearTimeout(timer);chrome.downloads.onChanged.removeListener(changed);error?reject(error):resolve();}
        function changed(delta){if(delta.id!==downloadId)return;if(delta.state?.current==='complete')finish();else if(delta.state?.current==='interrupted')finish(new Error('下载中断，请重试。'));}
        chrome.downloads.onChanged.addListener(changed);
        chrome.downloads.search({id:downloadId}).then(items=>{if(items[0]?.state==='complete')finish();else if(items[0]?.state==='interrupted')finish(new Error('下载中断，请重试。'));}).catch(finish);
      });
    } finally {URL.revokeObjectURL(url);}
    status.textContent=`已保存${shot.fullPage?'整页':'当前可见区域'}采集文件。请在 A11y Studio 中选择「URL → 已登录页面」并导入。`;
  } catch(error) {status.textContent=error instanceof Error?error.message:'采集失败，请重试。';}
  finally {button.disabled=false;}
});
