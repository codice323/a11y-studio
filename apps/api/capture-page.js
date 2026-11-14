globalThis.a11yStudioCapture=async(archivedImages={})=>{
  const originals=[document.documentElement,...document.documentElement.querySelectorAll('*')];
  if(originals.length>8000)throw new Error('页面元素超过 8000 个，请先缩小页面内容后重试。');
  const result=await globalThis.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']},iframes:false});
  const root=document.documentElement.cloneNode(true);
  const copies=[root,...root.querySelectorAll('*')];
  const properties=['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','margin','padding','color','background-color','border','border-radius','font-family','font-size','font-weight','font-style','line-height','letter-spacing','text-align','text-decoration','white-space','overflow','opacity','visibility','vertical-align'];
  const positioned=['inset','z-index'];
  const flex=['flex-direction','flex-wrap','align-items','justify-content','align-content','gap'];
  const grid=['grid-template-columns','grid-template-rows','grid-auto-flow','grid-auto-columns','grid-auto-rows','justify-items'];
  const conditional={transform:'none','transform-origin':'50% 50%',float:'none',clear:'none',
    'aspect-ratio':'auto','object-fit':'fill','object-position':'50% 50%','text-overflow':'clip','overflow-wrap':'normal',
    'word-break':'normal','box-shadow':'none','clip-path':'none','pointer-events':'auto','scrollbar-width':'auto',
    'text-indent':'0px','writing-mode':'horizontal-tb','direction':'ltr'};
  const imageBudget=1_500_000;
  let missedImages=0,shadowRoots=0,canvases=0,imageSize=0;
  const embedImage=(image,data)=>{
    if(data.length>400000 || imageSize+data.length>imageBudget) return false;
    image.setAttribute('src',data);
    imageSize+=data.length;
    return true;
  };
  for(let i=0;i<originals.length;i++){
    const original=originals[i],copy=copies[i];
    if(original.shadowRoot)shadowRoots++;
    if(original.tagName==='CANVAS')canvases++;
    const style=getComputedStyle(original);
    const names=[...properties];
    const parentDisplay=original.parentElement && getComputedStyle(original.parentElement).display;
    if(style.position!=='static')names.push(...positioned);
    if(/flex|grid/.test(style.display))names.push(...flex);
    if(style.display.includes('grid'))names.push(...grid);
    if(parentDisplay && /flex|grid/.test(parentDisplay))names.push('align-self','order');
    if(parentDisplay && parentDisplay.includes('flex'))names.push('flex');
    if(parentDisplay && parentDisplay.includes('grid'))names.push('grid-area','justify-self');
    names.push(...Object.keys(conditional).filter(name=>style.getPropertyValue(name)!==conditional[name] &&
      (name!=='transform-origin'||style.transform!=='none')));
    copy.setAttribute('style',names.map(name=>name+':'+style.getPropertyValue(name)).join(';'));
    for(const attribute of [...copy.attributes]){
      const name=attribute.name.toLowerCase();
      if(/^on/i.test(name)||name.startsWith('data-')||['srcdoc','action','formaction','nonce','integrity'].includes(name))copy.removeAttribute(attribute.name);
      if(name==='href'&&!attribute.value.startsWith('#'))copy.removeAttribute(attribute.name);
      if(name==='src'&&original.tagName!=='IMG')copy.removeAttribute(attribute.name);
    }
    if(original instanceof HTMLAnchorElement && original.hasAttribute('href')){
      try {
        const destination=new URL(original.href);
        if(['http:','https:'].includes(destination.protocol) && !destination.username && !destination.password && destination.href.length<=2048)
          copy.setAttribute('data-a11y-capture-href',destination.href);
      } catch {}
    }
    if(original instanceof HTMLInputElement){
      if(!['button','submit','reset'].includes(original.type))copy.removeAttribute('value');
      if(original.checked)copy.setAttribute('checked','');else copy.removeAttribute('checked');
    }
    if(original instanceof HTMLTextAreaElement)copy.textContent='';
    if(original instanceof HTMLOptionElement){if(original.selected)copy.setAttribute('selected','');else copy.removeAttribute('selected');}
    if(original instanceof HTMLImageElement){
      copy.removeAttribute('srcset');
      const archived=Object.hasOwn(archivedImages,original.currentSrc) ? archivedImages[original.currentSrc] : undefined;
      if(archived && embedImage(copy,archived))continue;
      try{
        if(!original.complete||!original.naturalWidth)throw new Error();
        const canvas=document.createElement('canvas');const scale=Math.min(1,960/Math.max(original.naturalWidth,original.naturalHeight));
        canvas.width=Math.max(1,Math.round(original.naturalWidth*scale));canvas.height=Math.max(1,Math.round(original.naturalHeight*scale));
        canvas.getContext('2d').drawImage(original,0,0,canvas.width,canvas.height);
        const data=canvas.toDataURL('image/webp',0.82);
        if(!embedImage(copy,data))throw new Error();
      }catch{copy.removeAttribute('src');missedImages++;}
    }
  }
  const iframeCount=root.querySelectorAll('iframe').length;
  root.querySelectorAll('script,noscript,iframe,object,embed,base,link[rel="stylesheet"],style,meta:not([charset]):not([name="viewport"])').forEach(node=>node.remove());
  const encode=new TextEncoder();
  const limit=4_000_000;
  const serialize=()=>'<!doctype html>'+root.outerHTML;
  let html=serialize();
  if(encode.encode(html).length>limit){
    // Share repeated declarations without changing the site's classes or IDs.
    const groups=new Map();
    for(const element of [root,...root.querySelectorAll('*')]){
      const value=element.getAttribute('style');
      if(!value)continue;
      if(!groups.has(value))groups.set(value,[]);
      groups.get(value).push(element);
    }
    const rules=[];
    for(const [value,elements] of groups){
      if(elements.length<2 || /[{}<>]/.test(value))continue;
      const key=String(rules.length+1);
      const selector='[data-a11y-capture-style="'+key+'"]';
      rules.push(selector+'{'+value+'}');
      for(const element of elements){
        element.removeAttribute('style');
        element.setAttribute('data-a11y-capture-style',key);
      }
    }
    const stylesheet=document.createElement('style');
    stylesheet.textContent=rules.join('');
    root.querySelector('head')?.append(stylesheet);
    html=serialize();
  }
  let excess=encode.encode(html).length-limit;
  if(excess>0){
    const embedded=[...root.querySelectorAll('img[src^="data:image/"]')];
    for(const image of embedded.reverse()){
      if(excess<=0)break;
      excess-=image.getAttribute('src').length;
      image.removeAttribute('src');
      missedImages++;
    }
    html=serialize();
  }
  if(encode.encode(html).length>limit)throw new Error('精简图片和样式后，页面副本仍超过 4 MB，请打开内容较少的页面再保存。');
  const limitations=['本地副本不运行原网站脚本，动态交互和外部资源可能与原页面不同。'];
  if(iframeCount)limitations.push(`页面包含 ${iframeCount} 个内嵌框架；此次只检测主页面，副本不包含框架内容。`);
  if(shadowRoots)limitations.push(`页面包含 ${shadowRoots} 个开放的 Shadow DOM；副本不包含其内部内容。`);
  if(canvases)limitations.push(`页面包含 ${canvases} 个 Canvas；副本可能无法还原画面。`);
  if(missedImages)limitations.push(`${missedImages} 张图片未能复制到本地副本。`);
  return {format:'a11y-studio-browser-capture',version:1,title:document.title.trim().slice(0,200)||'未命名网页',capturedAt:new Date().toISOString(),html,
    viewport:{width:innerWidth,height:innerHeight},violations:result.violations.slice(0,300).map(v=>({id:v.id.slice(0,100),help:v.help.slice(0,300),impact:v.impact||null,count:v.nodes.length})),
    incomplete:result.incomplete.length,limitations};
};
