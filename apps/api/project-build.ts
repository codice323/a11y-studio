import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as cheerio from 'cheerio';
import { build, type Loader } from 'esbuild';
import { parseSync } from 'rolldown/utils';
import { hash, safePath, walk } from './storage';

const require = createRequire(import.meta.url);
const js = /\.[jt]sx?$/i;
const images = /\.(png|jpe?g|webp|gif)$/i;
const sourceMark = 'data-a11y-origin';
const runtime = new Set(['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']);
type JSXAttribute = { type: string; name?: {name?: string}; value?: {type:string;value?: unknown} | null; start: number; end: number };
export type SourceLocation = { key:string; file:string; tag:string; line:number };
export type JsxSite = SourceLocation & { start:number; end:number; insertion:number; attributes:JSXAttribute[] };

export const isReactProject = (dir:string) => fs.existsSync(path.join(dir,'package.json'));

export function jsxSites(file:string, source:string): JsxSite[] {
  const ast=parseSync(file,source);
  if(ast.errors.length) throw new Error(`无法解析源码 ${file}：${ast.errors[0].message}`);
  const sites:JsxSite[]=[];
  const counters=new Map<string,number>();
  function visit(node: unknown) {
    if(!node || typeof node!=='object') return;
    if(Array.isArray(node)){ for(const item of node) visit(item); return; }
    const item=node as Record<string,unknown>;
    if(item.type==='JSXElement'){
      const opening=item.openingElement as {name:{type:string;name:string;end:number};attributes:JSXAttribute[]};
      const {name,attributes}=opening;
      if(name.type==='JSXIdentifier'&&/^[a-z][a-z0-9]*$/.test(name.name)){
        if(attributes.some(attr=>attr.name?.name===sourceMark)) throw new Error('项目源码使用了保留的定位属性。');
        const sequence=(counters.get(name.name)??0)+1;
        counters.set(name.name,sequence);
        const start=item.start as number,end=item.end as number;
        sites.push({key:hash(file+'|'+name.name+'|'+sequence).slice(0,20),file,tag:name.name,line:source.slice(0,start).split('\n').length,
          start,end,insertion:name.end,attributes});
      }
    }
    for(const value of Object.values(item)) if(typeof value==='object') visit(value);
  }
  visit(ast.program);
  return sites;
}

type Product = { files:Map<string,{body:Buffer|string;type:string}>; sources:Map<string,SourceLocation>; milliseconds:number };
export async function buildReactProject(dir:string, entry:string):Promise<Product> {
  const started=performance.now();
  const packageJson=JSON.parse(fs.readFileSync(safePath(dir,'package.json'),'utf8'));
  const dependencies=Object.keys({...packageJson.dependencies,...packageJson.optionalDependencies,...packageJson.peerDependencies});
  if(!dependencies.includes('react')||!dependencies.includes('react-dom')||dependencies.some(name=>!['react','react-dom'].includes(name))) {
    throw new Error('React 工程 V1 仅支持 React 和 React DOM 运行依赖。');
  }
  const files=new Set(walk(dir));
  const html=fs.readFileSync(safePath(dir,entry),'utf8');
  const $=cheerio.load(html);
  const scripts=$('script').toArray();
  const script=scripts.length===1?$(scripts[0]):null;
  const src=script?.attr('src');
  if(!src||script?.attr('type')!=='module'||!js.test(src)) throw new Error('入口 HTML 必须仅包含一个本地 JSX/TSX 模块入口。');

  function resolveLocal(spec:string, importer:string) {
    if(!/^(?:\.{1,2}\/|\/)[\w./-]+$/.test(spec)||spec.startsWith('//')) throw new Error('仅支持本地相对路径或工程根路径：'+spec);
    const base=path.posix.normalize(spec.startsWith('/')?spec.slice(1):path.posix.join(path.posix.dirname(importer),spec));
    const candidates=[base,...(!path.posix.extname(base)?['.tsx','.jsx','.ts','.js','/index.tsx','/index.jsx'].map(ext=>base+ext):[])];
    const matches=candidates.filter(file=>files.has(file)&&(js.test(file)||images.test(file)||/\.css$/i.test(file)));
    if(matches.length!==1) throw new Error('本地依赖不存在或路径有歧义：'+spec);
    return matches[0];
  }

  const main=resolveLocal(src,entry);
  const sources=new Map<string,SourceLocation>();
  // Only the trusted application toolchain runs in Node. User modules are loaded
  // from the bounded ZIP allowlist and are emitted as browser code, never evaluated.
  const vendorRoot=(name:string)=>path.dirname(require.resolve(name+'/package.json'))+path.sep;
  const vendors=['react','react-dom','scheduler'].map(vendorRoot);
  const result=await build({
    entryPoints:[main],bundle:true,write:false,outfile:'__a11y_bundle.js',platform:'browser',format:'iife',
    jsx:'automatic',tsconfigRaw:{compilerOptions:{}},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent',
    plugins:[{name:'project-allowlist',setup(plugin){
      plugin.onResolve({filter:/.*/},args=>{
        if(args.namespace==='file'&&args.importer) {
          if(!vendors.some(root=>args.importer.startsWith(root))) throw new Error('未知的构建模块来源。');
          if(args.path.startsWith('.')){
            const resolved=require.resolve(path.resolve(path.dirname(args.importer),args.path));
            if(vendors.some(root=>resolved.startsWith(root)))return {path:resolved};
          } else if (runtime.has(args.path) || args.path === 'scheduler') {
            const resolved = require.resolve(args.path);
            if (vendors.some(root => resolved.startsWith(root))) return { path: resolved };
          }
          throw new Error('不受支持的工具链依赖：' + args.path);
        }
        if(args.kind==='entry-point')return {path:main,namespace:'project'};
        if(args.kind==='dynamic-import')throw new Error('V1 不支持动态 import。');
        if(runtime.has(args.path))return {path:require.resolve(args.path)};
        const local=args.kind==='url-token'&&!args.path.startsWith('.')&&!args.path.startsWith('/') ? './'+args.path : args.path;
        return {path:resolveLocal(local,args.importer),namespace:'project'};
      });
      plugin.onLoad({filter:/.*/,namespace:'project'},args=>{
        const bytes=fs.readFileSync(safePath(dir,args.path));
        if(images.test(args.path))return {contents:bytes,loader:'dataurl'};
        const extension=path.extname(args.path).slice(1) as Loader;
        let source=bytes.toString('utf8');
        if(js.test(args.path)){
          const sites=jsxSites(args.path,source);
          for(const site of sites)sources.set(site.key,{key:site.key,file:site.file,tag:site.tag,line:site.line});
          for(const site of sites.sort((a,b)=>b.insertion-a.insertion)) {
            source=source.slice(0,site.insertion)+` ${sourceMark}="${site.key}"`+source.slice(site.insertion);
          }
        }
        return {contents:source,loader:extension};
      });
    }}],
  });
  $('script,iframe,object,embed,base,meta[http-equiv]').remove();
  $('*').each((_,element)=>{
    for(const attr of Object.keys('attribs' in element ? element.attribs : {})) if(/^on/i.test(attr)||attr==='srcdoc')$(element).removeAttr(attr);
  });
  $('body').append('<script src="/__a11y_bundle.js" defer></script>');
  const built=new Map<string,{body:Buffer|string;type:string}>();
  for(const output of result.outputFiles) {
    const name=path.basename(output.path);
    built.set(name,{body:Buffer.from(output.contents),type:name.endsWith('.css')?'text/css':'application/javascript'});
    if(name.endsWith('.css'))$('head').append('<link rel="stylesheet" href="/'+name+'">');
  }
  built.set(entry,{body:$.html(),type:'text/html; charset=utf-8'});
  return {files:built,sources,milliseconds:Math.round(performance.now()-started)};
}

export const sourceSelector=(key:string)=>`[${sourceMark}="${key}"]`;
export const originAttribute=sourceMark;
