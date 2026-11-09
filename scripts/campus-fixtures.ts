import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {strToU8,zipSync} from 'fflate';
import {Campus,pages,type CampusPage} from '../tests/fixtures/campus/src/campus';

const source=fileURLToPath(new URL('../tests/fixtures/campus/',import.meta.url));
const landing = (body:string, style:string, script='') =>
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>校园综合服务平台</title>'+style+'</head><body>'+body+script+'</body></html>';

export async function campusFixtures(destination:string) {
  await fs.mkdir(destination,{recursive:true});
  const image=await fs.readFile(path.join(source,'public/campus.png'));
  const css=await fs.readFile(path.join(source,'src/campus.css'),'utf8');
  const markup=(initial:CampusPage,variant:'zip'|'html',url:string)=>
    renderToStaticMarkup(createElement(Campus,{initial,variant,image:url}));
  const zipFiles:Record<string,Uint8Array>={'assets/campus.png':image,'assets/campus.css':strToU8(css)};
  for(const page of pages){
    const assets=page==='home'?'./assets/':'../assets/';
    const file=page==='home'?'index.html':'pages/'+page+'.html';
    zipFiles[file]=strToU8(landing(markup(page,'zip',assets+'campus.png'),'<link rel="stylesheet" href="'+assets+'campus.css">'));
  }
  const rootFiles=['index.html','package.json','public/campus.png','src/main.tsx','src/campus.tsx','src/campus.css','src/media.ts'];
  const sourceFiles=Object.fromEntries(await Promise.all(rootFiles.map(async name=>[name,await fs.readFile(path.join(source,name))])));
  const generated={
    html: path.join(destination,'campus-single.html'),
    zip: path.join(destination,'campus-multipage.zip'),
    project: path.join(destination,'campus-react-source.zip'),
    url: path.join(destination,'url-site'),
  };
  await fs.writeFile(generated.html,landing(markup('home','html','data:image/png;base64,'+image.toString('base64')),'<style>'+css+'</style>'));
  await fs.writeFile(generated.zip,zipSync(zipFiles));
  await fs.writeFile(generated.project,zipSync(sourceFiles));
  for(const [name,bytes] of Object.entries(zipFiles)){
    const file=path.join(generated.url,name);
    await fs.mkdir(path.dirname(file),{recursive:true});
    if(name==='index.html'){
      const html=Buffer.from(bytes).toString().replace('</body>','<script src="/announcement.js"></script></body>');
      await fs.writeFile(file,html);
    }else await fs.writeFile(file,bytes);
  }
  await fs.writeFile(path.join(generated.url,'announcement.js'),"fetch('/announcements.json').then(response=>response.json()).then(data=>{document.querySelector('#live-announcement').textContent=data.message;document.querySelector('#live-announcement').dataset.rendered='true';});");
  await fs.writeFile(path.join(generated.url,'announcements.json'),JSON.stringify({message:'实时公告：周五的开放科学工作坊已开放预约。'}));
  return generated;
}

export function campusUpstream(root:string, hits:string[] = []) {
  return http.createServer(async (req,res)=>{
    const url = new URL(req.url ?? '/','http://localhost');
    hits.push(url.pathname);
    if(url.pathname==='/private-redirect'){res.writeHead(302,{Location:'http://127.0.0.1/private'}).end();return;}
    const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const types:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css','.png':'image/png','.js':'text/javascript','.json':'application/json'};
    if(req.method!=='GET'||!/^[-a-zA-Z0-9_/]+\.(html|css|png|js|json)$/.test(filename)){
      res.writeHead(404).end('No such fixture');return;
    }
    try {
      const bytes=await fs.readFile(path.join(root,filename));
      res.writeHead(200,{'Content-Type':types[path.extname(filename)]}).end(bytes);
    } catch {
      res.writeHead(404).end('No such fixture');
    }
  });
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dir=path.resolve(process.argv[2]??'data/campus-fixtures');
  const generated=await campusFixtures(dir);
  console.log(generated);
  if(process.argv.includes('--serve'))campusUpstream(generated.url).listen(4191,'127.0.0.1',()=>console.log('校园测试源站 http://127.0.0.1:4191'));
}
