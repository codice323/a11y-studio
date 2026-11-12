globalThis.a11yStudioCapture=async()=>{
  const originals=[document.documentElement,...document.documentElement.querySelectorAll('*')];
  if(originals.length>8000)throw new Error('页面元素超过 8000 个，请先缩小页面内容后重试。');
  const result=await globalThis.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']},iframes:false});
  const root=document.documentElement.cloneNode(true);
  const copies=[root,...root.querySelectorAll('*')];
  const properties=['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','margin','padding','color','background-color','border','border-radius','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','white-space','overflow','opacity','visibility','vertical-align','flex','flex-direction','flex-wrap','align-items','justify-content','gap','grid-template-columns','grid-template-rows'];
  let missedImages=0,shadowRoots=0,canvases=0;
  for(let i=0;i<originals.length;i++){
    const original=originals[i],copy=copies[i];
    if(original.shadowRoot)shadowRoots++;
    if(original.tagName==='CANVAS')canvases++;
    const style=getComputedStyle(original);
    copy.setAttribute('style',properties.map(name=>name+':'+style.getPropertyValue(name)).join(';'));
    for(const attribute of [...copy.attributes]){
      const name=attribute.name.toLowerCase();
      if(/^on/i.test(name)||name.startsWith('data-')||['srcdoc','action','formaction','nonce','integrity'].includes(name))copy.removeAttribute(attribute.name);
      if(name==='href'&&!attribute.value.startsWith('#'))copy.removeAttribute(attribute.name);
      if(name==='src'&&original.tagName!=='IMG')copy.removeAttribute(attribute.name);
    }
    if(original instanceof HTMLInputElement){
      if(!['button','submit','reset'].includes(original.type))copy.removeAttribute('value');
      if(original.checked)copy.setAttribute('checked','');else copy.removeAttribute('checked');
    }
    if(original instanceof HTMLTextAreaElement)copy.textContent='';
    if(original instanceof HTMLOptionElement){if(original.selected)copy.setAttribute('selected','');else copy.removeAttribute('selected');}
    if(original instanceof HTMLImageElement){
      copy.removeAttribute('srcset');
      try{
        if(!original.complete||!original.naturalWidth)throw new Error();
        const canvas=document.createElement('canvas');const scale=Math.min(1,960/Math.max(original.naturalWidth,original.naturalHeight));
        canvas.width=Math.max(1,Math.round(original.naturalWidth*scale));canvas.height=Math.max(1,Math.round(original.naturalHeight*scale));
        canvas.getContext('2d').drawImage(original,0,0,canvas.width,canvas.height);
        const data=canvas.toDataURL('image/png');if(data.length>400000)throw new Error();copy.setAttribute('src',data);
      }catch{copy.removeAttribute('src');missedImages++;}
    }
  }
  const iframeCount=root.querySelectorAll('iframe').length;
  root.querySelectorAll('script,noscript,iframe,object,embed,base,link[rel="stylesheet"],style,meta:not([charset]):not([name="viewport"])').forEach(node=>node.remove());
  const html='<!doctype html>'+root.outerHTML;
  if(new TextEncoder().encode(html).length>4000000)throw new Error('页面副本超过 4 MB，请尝试内容较少的页面。');
  const limitations=['本地副本不运行原网站脚本，动态交互和外部资源可能与原页面不同。'];
  if(iframeCount)limitations.push(`页面包含 ${iframeCount} 个内嵌框架；此次只检测主页面，副本不包含框架内容。`);
  if(shadowRoots)limitations.push(`页面包含 ${shadowRoots} 个开放的 Shadow DOM；副本不包含其内部内容。`);
  if(canvases)limitations.push(`页面包含 ${canvases} 个 Canvas；副本可能无法还原画面。`);
  if(missedImages)limitations.push(`${missedImages} 张图片未能复制到本地副本。`);
  return {format:'a11y-studio-browser-capture',version:1,title:document.title.trim().slice(0,200)||'未命名网页',capturedAt:new Date().toISOString(),html,
    viewport:{width:innerWidth,height:innerHeight},violations:result.violations.slice(0,300).map(v=>({id:v.id.slice(0,100),help:v.help.slice(0,300),impact:v.impact||null,count:v.nodes.length})),
    incomplete:result.incomplete.length,limitations};
};
