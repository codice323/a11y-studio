import fs from 'node:fs';
import postcss from 'postcss';
import { jsxSites, sourceSelector, type SourceLocation } from './project-build';
import { safePath, walk } from './storage';
import type { SourceChange } from '../../packages/shared/source-repair';

type ReactPlan =
  | {kind:'label'|'button'|'link'|'alt';value:string}
  | {kind:'contrast';value:string;file:string}
  | {kind:'focus';file:string};

export function compileReactRepair(dir:string, location:SourceLocation|undefined, plan:ReactPlan, reason:string) {
  if(!location)throw new Error('无法把浏览器元素唯一映射到 JSX/TSX，请人工定位源码。');
  const file=location.file;
  const before=fs.readFileSync(safePath(dir,file),'utf8');
  const site=jsxSites(file,before).find(node=>node.key===location.key && node.tag===location.tag && node.line===location.line);
  if(!site)throw new Error('浏览器与原始组件的源码映射已变化，请重新扫描。');
  if(site.attributes.some(attr=>attr.type==='JSXSpreadAttribute'))throw new Error('组件包含展开属性，无法确认修复优先级，请人工检查。');
  const attribute=(name:string)=>site.attributes.find(attr=>attr.name?.name===name);
  const stableId=attribute('id')?.value;
  const id=stableId?.type==='Literal' && typeof stableId.value==='string' ? stableId.value : undefined;
  const change=(name:string,old:string,updated:string):SourceChange=>({
    file:name,selector:`${file}:${site.line} <${site.tag}>`,reason,before:old,after:updated,
    verification:'重新构建原始工程并在真实 Chromium 中复测',
  });
  const target=sourceSelector(site.key);
  if(plan.kind==='contrast'||plan.kind==='focus'){
    if(!id||!/^[_a-zA-Z][\w-]*$/.test(id))throw new Error('CSS 工程修复需要目标的唯一静态 ID，请人工确认样式范围。');
    if(!/\.css$/i.test(plan.file)||!walk(dir).includes(plan.file))throw new Error('请选择工程中已加载的本地 CSS 文件。');
    if(walk(dir).filter(name=>/\.html?$/i.test(name)).length!==1)throw new Error('多入口 React 工程的共享 CSS 需人工处理。');
    const old=fs.readFileSync(safePath(dir,plan.file),'utf8');
    const css=postcss.parse(old);
    const selector='#'+id+(plan.kind==='focus'?':focus-visible':'');
    const existing=css.nodes.filter((node):node is postcss.Rule=>node.type==='rule'&&node.selector===selector);
    if(existing.length>1)throw new Error('存在多个候选样式规则，请人工确认 CSS 层叠来源。');
    const rule=existing[0]??postcss.rule({selector});
    const properties=plan.kind==='contrast'?[['color',plan.value]]:[['outline','3px solid #101010'],['outline-offset','2px'],['box-shadow','0 0 0 2px #fff']];
    for(const [prop,value] of properties){
      const matches=(rule.nodes??[]).filter((node):node is postcss.Declaration=>node.type==='decl'&&node.prop.toLowerCase()===prop);
      const declaration=matches.filter(node=>node.important).at(-1)??matches.at(-1);
      if(declaration)declaration.value=value;
      else rule.append(postcss.decl({prop,value}));
    }
    if(!existing.length)css.append(rule);
    return {changes:[change(plan.file,old,css.toString())],target};
  }

  const replace=(name:string,value:string)=>{
    const old=attribute(name);
    if(old&&old.value?.type!=='Literal')throw new Error(`属性 ${name} 为动态表达式，请人工确认组件数据来源。`);
    const at=old?.start??site.insertion;
    return before.slice(0,at)+(old?'':' ')+`${name}={${JSON.stringify(value)}}`+before.slice(old?.end??at);
  };
  let after:string;
  let newId:string|undefined;
  if(plan.kind==='label'){
    if(!['input','select','textarea'].includes(site.tag)||attribute('aria-labelledby')||attribute('aria-label')||
      (attribute('id')&&!id))throw new Error('仅支持可确认用途、无动态关联的原生表单控件。');
    if(id&&/\s/.test(id))throw new Error('控件 ID 无法建立可靠的标签关联。');
    newId=id?undefined:'a11y-field-'+site.key;
    const labelFor=id??newId!;
    const opening=newId?replace('id',labelFor):before;
    const inserted=opening.length-before.length;
    after=opening.slice(0,site.start)+`<><label htmlFor={${JSON.stringify(labelFor)}}>{${JSON.stringify(plan.value)}}</label>`+
      opening.slice(site.start,site.end+inserted)+'</>'+opening.slice(site.end+inserted);
  }else{
    const expected={alt:'img',button:'button',link:'a'}[plan.kind];
    if(site.tag!==expected||((plan.kind==='button'||plan.kind==='link')&&attribute('aria-labelledby')))throw new Error('只支持可验证的原生图片、按钮或链接。');
    after=replace(plan.kind==='alt'?'alt':'aria-label',plan.value);
  }
  jsxSites(file,after);
  return {changes:[change(file,before,after)],target:newId?'#'+newId:target,newId};
}
