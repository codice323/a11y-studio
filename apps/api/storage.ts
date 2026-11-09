import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA = process.env.A11Y_DATA_DIR ? path.resolve(process.env.A11Y_DATA_DIR) : path.join(ROOT,'data');
fs.mkdirSync(DATA,{recursive:true});
export const db = new Database(path.join(DATA,'studio.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS live_state_audits(project_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,state_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,snapshot_id,state_id));
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT,entry TEXT,current_snapshot TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,project_id TEXT,parent_id TEXT,entry TEXT,hash TEXT,created_at TEXT,description TEXT);
CREATE TABLE IF NOT EXISTS audits(id TEXT PRIMARY KEY,project_id TEXT,snapshot_id TEXT,status TEXT,result TEXT,error TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,project_id TEXT,snapshot_id TEXT,issue_id TEXT,status TEXT,data TEXT,created_at TEXT);
CREATE TABLE IF NOT EXISTS verifications(id TEXT PRIMARY KEY,project_id TEXT,proposal_id TEXT,status TEXT,data TEXT,created_at TEXT);`);
if (!db.prepare("PRAGMA table_info(snapshots)").all().some(column => (column as { name: string }).name === 'name')) {
  db.exec('ALTER TABLE snapshots ADD COLUMN name TEXT');
}
if (!db.prepare("PRAGMA table_info(projects)").all().some(column => (column as { name: string }).name === 'mode')) {
  db.exec("ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'snapshot'");
}
export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const hash = (data:Buffer|string) => crypto.createHash('sha256').update(data).digest('hex');
export const snapshotDir = (project:string,snapshot:string) => path.join(DATA,'projects',project,snapshot);
export function project(id:string):any { const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id); if(!p) throw new Error('项目不存在。'); return p; }
export function snapshot(projectId:string,snapshotId:string):any { const s=db.prepare('SELECT * FROM snapshots WHERE id=? AND project_id=?').get(snapshotId,projectId); if(!s) throw new Error('版本不存在。');return s; }
export function audit(id:string):any { const a:any=db.prepare('SELECT * FROM audits WHERE id=?').get(id); if(!a) throw new Error('扫描记录不存在。'); return {...a,result:a.result?JSON.parse(a.result):null}; }
export function proposal(id:string):any { const p:any=db.prepare('SELECT * FROM proposals WHERE id=?').get(id); if(!p) throw new Error('修复建议不存在。');return {...p,data:JSON.parse(p.data)}; }
export function safePath(root:string,relative:string) { if(!relative || relative.includes('\\') || relative.startsWith('/') || relative.includes('\0')) throw new Error('文件路径无效。'); const normalized=path.posix.normalize(relative); if(normalized==='..'||normalized.startsWith('../')||normalized!==relative) throw new Error('文件路径无效。'); const resolved=path.resolve(root,relative); if(!resolved.startsWith(path.resolve(root)+path.sep)) throw new Error('文件路径无效。');return resolved; }
export function walk(dir:string, base=dir):string[] {return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name),base):e.isFile()?[path.relative(base,path.join(dir,e.name)).split(path.sep).join('/')]:[]);}
export function treeHash(dir:string) {return hash(walk(dir).sort().map(f=>`${f}:${hash(fs.readFileSync(safePath(dir,f)))}`).join('\n'));}
