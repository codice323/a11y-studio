import fs from 'node:fs';
import path from 'node:path';
import { DATA, db, safePath } from './storage';

export function migrateProjectDeletion() {
  db.exec(`CREATE TABLE IF NOT EXISTS project_file_cleanup (
    project_id TEXT PRIMARY KEY, files TEXT NOT NULL
  )`);
}

export function eraseProjectRecords(projectId:string, ownerId:string) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_user_id=?').get(projectId,ownerId)) return false;
  const files=[
    ['browser-captures',projectId+'.png'],
    ['browser-captures',projectId+'.json'],
    ...(db.prepare('SELECT id FROM audits WHERE project_id=?').all(projectId) as {id:string}[])
      .map(({id})=>['screenshots',id+'.png']),
    ...(db.prepare('SELECT id FROM panorama_captures WHERE project_id=?').all(projectId) as {id:string}[])
      .flatMap(({id})=>[['panorama',id+'-full.jpg'],['panorama',id+'-viewport.jpg']]),
  ];
  db.prepare('INSERT INTO project_file_cleanup (project_id,files) VALUES (?,?)').run(projectId,JSON.stringify(files));
  for (const table of ['live_state_audits','panorama_attempts','panorama_captures','panorama_recipes',
    'jobs','verifications','proposals','audits','snapshots','legacy_project_claims']) {
    db.prepare('DELETE FROM '+table+' WHERE project_id=?').run(projectId);
  }
  db.prepare('DELETE FROM projects WHERE id=? AND owner_user_id=?').run(projectId,ownerId);
  return true;
}

export function flushProjectFiles() {
  const pending=db.prepare('SELECT project_id,files FROM project_file_cleanup LIMIT 20').all() as {project_id:string;files:string}[];
  for (const {project_id,files} of pending) {
    try {
      for (const [directory,name] of JSON.parse(files) as [string,string][]) {
        fs.rmSync(safePath(path.join(DATA,directory),name),{force:true});
      }
      fs.rmSync(safePath(path.join(DATA,'projects'),project_id),{recursive:true,force:true});
      db.prepare('DELETE FROM project_file_cleanup WHERE project_id=?').run(project_id);
    } catch { console.warn('[account-security] project-file-cleanup-pending'); }
  }
}
