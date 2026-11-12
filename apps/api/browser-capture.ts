import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createProject } from './import';
import { sanitizedHtml } from './scan';
import { DATA, db, project } from './storage';

const finding = z.object({id:z.string().max(100),help:z.string().max(300),impact:z.string().max(30).nullable(),
  count:z.number().int().min(0).max(50000)}).strict();
const captureSchema = z.object({format:z.literal('a11y-studio-browser-capture'),version:z.literal(1),
  title:z.string().trim().min(1).max(200),capturedAt:z.string().max(64),html:z.string().min(1).max(4_000_000),
  screenshot:z.string().max(6_000_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
  screenshotFullPage:z.boolean().optional(),
  viewport:z.object({width:z.number().int().min(1).max(10000),height:z.number().int().min(1).max(10000)}).strict(),
  violations:z.array(finding).max(300),incomplete:z.number().int().min(0).max(50000),
  limitations:z.array(z.string().max(300)).max(20)}).strict();
const dir = path.join(DATA,'browser-captures');

export async function importBrowserCaptureData(raw:unknown, ownerUserId?:string) {
  const parsed=captureSchema.safeParse(raw);
  if (!parsed.success) throw new Error('浏览器采集文件格式无效，请重新采集。');
  const data=parsed.data;
  if (Buffer.byteLength(data.html)>4_000_000) throw new Error('页面内容过大，请选择较小的页面。');
  const png=Buffer.from(data.screenshot.slice('data:image/png;base64,'.length),'base64');
  if (png.length>4_000_000 || png.length<24 || !png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      png.subarray(12,16).toString('ascii')!=='IHDR' || png.readUInt32BE(16)===0 || png.readUInt32BE(20)===0 ||
      png.readUInt32BE(16)>12000 || png.readUInt32BE(20)>12000 || png.readUInt32BE(16)*png.readUInt32BE(20)>60_000_000) throw new Error('浏览器截图无效或超过大小限制。');
  const created=await createProject({ownerUserId,captured:{name:'浏览器 · '+data.title,files:new Map([['index.html',Buffer.from(sanitizedHtml(data.html))]])}});
  try {
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,created.id+'.png'),png);
    const meta={title:data.title,capturedAt:data.capturedAt,viewport:data.viewport,screenshotFullPage:data.screenshotFullPage??false,violations:data.violations,
      incomplete:data.incomplete,limitations:data.limitations};
    fs.writeFileSync(path.join(dir,created.id+'.json'),JSON.stringify(meta));
  } catch(error) {
    db.transaction(()=>{db.prepare('DELETE FROM snapshots WHERE project_id=?').run(created.id);db.prepare('DELETE FROM projects WHERE id=?').run(created.id);})();
    fs.rmSync(path.join(DATA,'projects',created.id),{recursive:true,force:true});
    fs.rmSync(path.join(dir,created.id+'.png'),{force:true});
    fs.rmSync(path.join(dir,created.id+'.json'),{force:true});
    throw error;
  }
  return created;
}

export async function importBrowserCapture(file?: Express.Multer.File, ownerUserId?: string) {
  if (!file || !/\.json$/i.test(file.originalname)) throw new Error('请选择浏览器扩展生成的 JSON 采集文件。');
  let raw:unknown;
  try { raw=JSON.parse(file.buffer.toString('utf8')); } catch { throw new Error('浏览器采集文件不是有效的 JSON。'); }
  return importBrowserCaptureData(raw,ownerUserId);
}

export function browserCapture(projectId:string) {
  const file=path.join(dir,projectId+'.json');
  if (!fs.existsSync(file)) return null;
  return {...JSON.parse(fs.readFileSync(file,'utf8')),screenshot:`/api/projects/${projectId}/browser-capture/screenshot`};
}

export function browserCaptureScreenshot(projectId:string) {
  project(projectId);
  const file=path.join(dir,projectId+'.png');
  if (!fs.existsSync(file)) throw new Error('原始浏览器截图不存在。');
  return file;
}
