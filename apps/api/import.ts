import fs from 'node:fs';import path from 'node:path';import yauzl from 'yauzl';import {promisify} from 'node:util';
import {buildReactProject,isReactProject} from './project-build';
import {db,id,now,ROOT,DATA,snapshotDir,safePath,treeHash,walk} from './storage';
const ALLOWED=new Set(['.html','.htm','.css','.png','.jpg','.jpeg','.gif','.webp','.woff','.woff2']);
function validName(name:string, engineering=false) { if(name.startsWith('/')||name.includes('\\')||name.includes('\0')||name.split('/').some(x=>x==='..'||x==='.'||!x)||name.length>240) throw new Error('压缩包包含不安全的路径。'); if(engineering&&name.split('/').some(part=>part.startsWith('.')||part==='node_modules'))throw new Error('源码工程不能包含隐藏文件或 node_modules。'); if(!ALLOWED.has(path.extname(name).toLowerCase())&&!(engineering&&/\.(?:[jt]sx?|json|md|txt)$/i.test(name))) throw new Error(`不支持文件类型：${name}`); }
async function extract(buffer:Buffer, dest:string, engineering:boolean) {
  const zip: yauzl.ZipFile = await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true,autoClose:true},(err,z)=>err||!z?reject(err):resolve(z)));
  return new Promise<void>((resolve,reject)=>{let count=0,total=0;const names=new Set<string>();let failed=false;
    const fail=(error:Error)=>{if(failed)return;failed=true;zip.close();reject(error)};
    zip.on('error',fail);zip.on('end',()=>{if(!failed)resolve()});zip.on('entry',(entry:yauzl.Entry)=>{
      if(failed)return;
      try {if(/\/$/.test(entry.fileName)){zip.readEntry();return;} count++;total+=entry.uncompressedSize;
        if(count>100||total>20*1024*1024||entry.uncompressedSize>5*1024*1024||entry.uncompressedSize>Math.max(1024*1024,entry.compressedSize*100)) throw new Error('压缩包超过文件数量或解压大小限制。');
        if(((entry.externalFileAttributes>>>16)&0o170000)===0o120000) throw new Error('压缩包不允许包含符号链接。');
        validName(entry.fileName,engineering);if(names.has(entry.fileName))throw new Error('压缩包包含重复文件。');names.add(entry.fileName);
        const target=safePath(dest,entry.fileName);fs.mkdirSync(path.dirname(target),{recursive:true});
        zip.openReadStream(entry,(err,stream)=>{if(err||!stream)return fail(err||new Error('无法读取压缩包。'));let bytes=0;const chunks:Buffer[]=[];stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>entry.uncompressedSize||bytes>5*1024*1024){stream.destroy();fail(new Error('解压文件超过限制。'));}else chunks.push(chunk)});stream.on('error',fail);stream.on('end',()=>{if(failed)return;fs.writeFileSync(target,Buffer.concat(chunks));zip.readEntry()})});
      } catch(e){fail(e as Error)}
    });zip.readEntry();
  });
}
export async function createProject(opts:{fixture?:string; file?:Express.Multer.File; engineering?:boolean; captured?: { name: string; files: Map<string, Buffer> }}) {
  const pid=id(),sid=id(), dest=snapshotDir(pid,sid);fs.mkdirSync(dest,{recursive:true});
  try {let name='未命名项目';
    if(opts.fixture){ if(!['demo-form','demo-contrast','demo-mixed'].includes(opts.fixture))throw new Error('示例不存在。');name=({'demo-form':'课程报名','demo-contrast':'自然笔记','demo-mixed':'慢绿生活'} as Record<string,string>)[opts.fixture];fs.cpSync(path.join(ROOT,'fixtures',opts.fixture),dest,{recursive:true}); }
    else if(opts.captured){
      name = opts.captured.name;
      for (const [filename, bytes] of opts.captured.files) {
        validName(filename);
        const file = safePath(dest, filename);
        fs.mkdirSync(path.dirname(file), {recursive:true});
        fs.writeFileSync(file, bytes);
      }
    }
    else if(opts.file){name=opts.file.originalname; const ext=path.extname(name).toLowerCase();if(ext==='.zip')await extract(opts.file.buffer,dest,Boolean(opts.engineering));else if(['.html','.htm'].includes(ext))fs.writeFileSync(path.join(dest,'index.html'),opts.file.buffer);else throw new Error('请上传 HTML 或 ZIP 文件。');}
    else throw new Error('请选择示例或上传项目。');
    const files=walk(dest);const html=files.filter(x=>/\.html?$/i.test(x)).sort();if(!html.length)throw new Error('项目中未找到 HTML 文件。');
    let entry=html.find(x=>x==='index.html')||html.find(x=>x.endsWith('/index.html'))||html[0];
    const mode = opts.engineering ? isReactProject(dest) ? 'react-source' : 'static-source' : 'snapshot';
    if (opts.engineering && (!opts.file || path.extname(opts.file.originalname).toLowerCase()!=='.zip')) throw new Error('源码工程必须上传 ZIP。');
    if (mode==='react-source'){
      if(!files.includes('index.html')) throw new Error('React 工程 ZIP 根目录需要 index.html 与 package.json。');
      entry='index.html';
      await buildReactProject(dest,entry);
    }else if(mode==='static-source'&&files.some(file=>/\.[jt]sx?$/i.test(file))) throw new Error('静态源码工程 V1 不运行脚本，请导入 HTML、CSS 和图片。');
    const created=now();
    db.transaction(()=>{db.prepare('INSERT INTO projects(id,name,entry,current_snapshot,created_at,mode) VALUES(?,?,?,?,?,?)').run(pid,name,entry,sid,created,mode);db.prepare('INSERT INTO snapshots(id,project_id,parent_id,entry,hash,created_at,description) VALUES(?,?,?,?,?,?,?)').run(sid,pid,null,entry,treeHash(dest),created,'原始版本 V0')})();
    return {id:pid,name,entry,mode,currentSnapshot:sid,createdAt:created};
  } catch(e){fs.rmSync(path.join(DATA,'projects',pid),{recursive:true,force:true});throw e;}
}
