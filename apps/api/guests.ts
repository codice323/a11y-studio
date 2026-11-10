import fs from 'node:fs';
import path from 'node:path';
import { guestLifetimeHours } from '../../packages/shared/account';
import { DATA, db, safePath } from './storage';

export const guestLifetimeMs = guestLifetimeHours * 60 * 60 * 1000;
const limits = {projects:3,ai:5,operations:40,reads:20} as const;
type Budget = keyof typeof limits;

export function useGuestBudget(userId:string, kind:Budget) {
  return db.prepare(`INSERT INTO guest_usage (user_id,kind,count) VALUES (?,?,1)
    ON CONFLICT(user_id,kind) DO UPDATE SET count=count+1 WHERE count < ?`)
    .run(userId,kind,limits[kind]).changes === 1;
}

export function releaseGuestProject(userId:string) {
  db.prepare("UPDATE guest_usage SET count=count-1 WHERE user_id=? AND kind='projects' AND count>0").run(userId);
}

const deleteGuest = db.transaction((userId:string) => {
  const ids = (sql:string, key:string) => (db.prepare(sql).all(key) as {id:string}[]).map(row=>row.id);
  const remove = (dir:string,file:string,recursive=false) =>
    fs.rmSync(safePath(path.join(DATA,dir),file),{recursive,force:true});

  for (const projectId of ids('SELECT id FROM projects WHERE owner_user_id=?',userId)) {
    for (const auditId of ids('SELECT id FROM audits WHERE project_id=?',projectId)) remove('screenshots',auditId+'.png');
    for (const captureId of ids('SELECT id FROM panorama_captures WHERE project_id=?',projectId)) {
      for (const kind of ['full','viewport']) remove('panorama',captureId+'-'+kind+'.jpg');
    }
    remove('projects',projectId,true);
    for (const table of ['live_state_audits','panorama_attempts','panorama_captures','panorama_recipes',
      'jobs','verifications','proposals','audits','snapshots','legacy_project_claims']) {
      db.prepare('DELETE FROM '+table+' WHERE project_id=?').run(projectId);
    }
    db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }
  for (const table of ['session','account','guest_usage']) db.prepare('DELETE FROM '+table+' WHERE '+(table==='guest_usage'?'user_id':'userId')+'=?').run(userId);
  db.prepare('DELETE FROM user WHERE id=? AND isAnonymous=1').run(userId);
});

export function cleanExpiredGuests(now=Date.now()) {
  // Allow running work to settle after access expires. Failed deletions remain eligible for retry.
  const cutoff = new Date(now-guestLifetimeMs-60*60*1000).toISOString();
  const users = db.prepare(`SELECT u.id FROM user u WHERE u.isAnonymous=1 AND julianday(u.createdAt)<=julianday(?)
    AND NOT EXISTS (SELECT 1 FROM jobs j JOIN projects p ON p.id=j.project_id
      WHERE p.owner_user_id=u.id AND j.status IN ('queued','running'))
    ORDER BY u.createdAt LIMIT 20`).all(cutoff) as {id:string}[];
  for (const {id} of users) {
    try { deleteGuest(id); }
    catch { console.error('游客数据清理失败，将在下次清理时重试。'); }
  }
}
