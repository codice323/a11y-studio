import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.A11Y_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'a11y-v261-eval-'));
const {db,id,snapshotDir,treeHash}=await import('../apps/api/storage');
const {exploreSite}=await import('../apps/api/panorama');
const html=(content:string)=>'<!doctype html><html lang="en"><head><title>Public information</title></head><body>'+content+'</body></html>';

const samples = [
  {set:'development',name:'municipal-media',mode:'snapshot',files:{
    'index.html':html('<main><h1>Municipal archives</h1><nav><a href="films.html">Films</a><a href="locations.html">Locations</a></nav></main>'),
    'films.html':html('<main><h1>Films</h1><details><summary>About the recording</summary><video controls aria-label="Council recording"></video><button id="film-positive"><span aria-hidden="true">▶</span></button><button id="film-negative">Read transcript</button></details><a href="index.html">Archives</a></main>'),
    'locations.html':html('<main><h1>Locations</h1><a href="films.html">Films</a></main>'),
  },pages:['/index.html','/films.html','/locations.html'],states:[['/films.html','button "Read transcript"']],
  labels:[['/films.html','#film-positive',true],['/films.html','#film-negative',false]]},
  {set:'holdout',name:'library-registration',mode:'snapshot',files:{
    'index.html':html('<main><h1>Library registration</h1><a href="eligibility.html">Eligibility</a><form><label for="zip">Postal code</label><input id="zip" required><button>Check eligibility</button></form></main>'),
    'eligibility.html':html('<main><h1>Eligibility</h1><details><summary>Proof of residence</summary><button id="library-positive"><span aria-hidden="true">?</span></button><button id="library-negative">Print instructions</button></details><a href="index.html">Registration</a></main>'),
  },pages:['/index.html','/eligibility.html'],states:[['/eligibility.html','button "Print instructions"']],
  labels:[['/eligibility.html','#library-positive',true],['/eligibility.html','#library-negative',false]]},
  {set:'holdout',name:'supply-dispatch',mode:'react-source',files:{
    'package.json':JSON.stringify({dependencies:{react:'*','react-dom':'*'}}),
    'index.html':html('<div id="root"></div><script type="module" src="/src/index.tsx"></script>'),
    'src/index.tsx':`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
function Dispatch(){
 const [route,setRoute]=useState(false),[panel,setPanel]=useState(false);
 return <main><h1>{route?'Dispatch':'Warehouse'}</h1>{route ?
 <><button aria-expanded={panel} aria-controls="dispatch-panel" onClick={()=>setPanel(!panel)}>Instructions</button>
 <section hidden={!panel} id="dispatch-panel"><button id="dispatch-positive"><span aria-hidden="true">!</span></button>
 <button id="dispatch-negative">Review packing list</button></section></> :
 <nav><a href="/dispatch" onClick={e=>{e.preventDefault();history.pushState({},'','/dispatch');setRoute(true)}}>Dispatch</a></nav>}</main>
}
createRoot(document.getElementById('root')!).render(<Dispatch/>);`
  },pages:['/index.html','/dispatch'],states:[['/dispatch','button "Review packing list"']],
  labels:[['/dispatch','#dispatch-positive',true],['/dispatch','#dispatch-negative',false]]},
] satisfies {set:string;name:string;mode:string;files:Record<string,string>;pages:string[];states:[string,string][];labels:[string,string,boolean][]}[];

try {
  for (const sample of samples) {
    const project=id(),snapshot=id(),dir=snapshotDir(project,snapshot);
    for (const [name,value] of Object.entries(sample.files)) {
      fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});
      fs.writeFileSync(path.join(dir,name),value);
    }
    db.prepare('INSERT INTO projects (id,name,entry,current_snapshot,mode) VALUES(?,?,?,?,?)').run(project,sample.name,'index.html',snapshot,sample.mode);
    db.prepare('INSERT INTO snapshots (id,project_id,entry,hash) VALUES(?,?,?,?)').run(snapshot,project,'index.html',treeHash(dir));
    const {graph}=await exploreSite(project,snapshot,false,new AbortController().signal,()=>{});
    const evidence=(db.prepare('SELECT data FROM panorama_captures WHERE project_id=?').all(project) as {data:string}[])
      .map(row=>JSON.parse(row.data).capture);
    const labeled={tp:0,tn:0,fp:0,fn:0};
    for (const [url,selector,expected] of sample.labels) {
      const found=evidence.some(item=>item.path===url && item.issues.some((issue:{ruleId:string;selector:string})=>issue.ruleId==='button-name' && issue.selector===selector));
      labeled[expected ? (found?'tp':'fn') : (found?'fp':'tn')]++;
    }
    console.log(JSON.stringify({name:sample.name,set:sample.set,pages:[sample.pages.filter(url=>graph.pages.some(p=>p.path===url && p.status==='visited')).length,sample.pages.length],
      states:[sample.states.filter(([url,ax])=>evidence.some(item=>item.path===url && item.ax.includes(ax))).length,sample.states.length],
      attempts:graph.edges.filter(edge=>edge.status!=='skipped').length,duplicates:graph.edges.filter(edge=>edge.status==='duplicate').length,
      failed:graph.edges.filter(edge=>edge.status==='failed').length,scanned:evidence.length,labeled,elapsedMs:graph.elapsedMs,stop:graph.stop,
      replay:graph.edges.map(({path,step,status,reason})=>({path,step,status,reason}))}));
  }
} finally {
  db.close();
  fs.rmSync(process.env.A11Y_DATA_DIR,{recursive:true,force:true});
}
