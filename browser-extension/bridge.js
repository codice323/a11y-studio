if(window.top===window && location.origin==='http://127.0.0.1:4173' && location.hash==='#original-live'){
  const port=chrome.runtime.connect({name:'a11y-original-live'});
  let connected=true,notified=false;
  port.onMessage.addListener(message=>{if(message.event==='disconnected')notified=true;window.postMessage({channel:'a11y-original-response',...message},location.origin);});
  port.onDisconnect.addListener(()=>{connected=false;if(!notified)window.postMessage({channel:'a11y-original-response',event:'disconnected',reason:'扩展连接已关闭，可能是扩展被重新加载或浏览器停止了连接。请回到原网页重新连接。'},location.origin);});
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='a11y-original-request')return;
    const {id,command,payload}=event.data;
    if(typeof id!=='string'||id.length>80||typeof command!=='string')return;
    if(!connected){window.postMessage({channel:'a11y-original-response',id,error:'扩展连接已断开。'},location.origin);return;}
    port.postMessage({id,command,payload});
  });
}
