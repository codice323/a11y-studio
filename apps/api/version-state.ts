import type { Issue, Patch, Scan } from '../../packages/shared/types';
import { audit, db, project, snapshot } from './storage';

export type Snapshot = {
  id: string; parent_id: string | null; hash: string; created_at: string; description: string; name: string | null;
};
type Verification = {
  id: string; fromSnapshot: string; toSnapshot: string; status: 'passed' | 'failed';
  sourceTarget?: string; baselineAudit: string; audit: string | null; resolved: Issue[]; patch?: Patch;
};

const repairNames: Record<string, string> = {
  'image-alt': '图片替代文本修复',
  'button-name': '按钮名称修复',
  'link-name': '链接名称修复',
  label: '表单标签优化',
  'color-contrast': '文字对比度修复',
};

export function latestSnapshotAudit(projectId: string, snapshotId: string): Scan | null {
  const row = db.prepare("SELECT id FROM audits WHERE project_id=? AND snapshot_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1")
    .get(projectId, snapshotId) as { id: string } | undefined;
  return row ? audit(row.id).result : null;
}

export function validSnapshots(projectId: string) {
  return db.prepare("SELECT id,parent_id,hash,created_at,description,name FROM snapshots WHERE project_id=? AND description NOT IN ('验证失败','待验证修复') ORDER BY (parent_id IS NOT NULL), rowid ASC")
    .all(projectId) as Snapshot[];
}

export function projectVerifications(projectId: string) {
  return db.prepare('SELECT data FROM verifications WHERE project_id=? ORDER BY rowid DESC')
    .all(projectId).map(row => JSON.parse((row as { data: string }).data) as Verification);
}

export function projectState(projectId: string) {
  const p = project(projectId);
  const snapshots = validSnapshots(projectId);
  const verifications = projectVerifications(projectId);
  const byId = new Map(snapshots.map(item => [item.id, item]));
  const passedByTarget = new Map(verifications.filter(item => item.status === 'passed').map(item => [item.toSnapshot, item]));
  const originalSnapshotId = snapshots.find(item => item.parent_id === null)?.id ?? null;
  const baseline = originalSnapshotId ? latestSnapshotAudit(projectId, originalSnapshotId) : null;
  const current = latestSnapshotAudit(projectId, p.current_snapshot);
  const baselineIssues = baseline?.issues ?? [];
  const currentIssues = current?.issues ?? [];
  const baseIds = new Set(baselineIssues.map(issue => issue.id));
  const currentIds = new Set(currentIssues.map(issue => issue.id));

  // Follow actual parent links from the selected snapshot, newest repair first.
  const seen = new Set<string>();
  const resolved = new Map<string, { issue: Issue; verificationId: string }>();
  for (let item = byId.get(p.current_snapshot); current && item?.parent_id && !seen.has(item.id); item = byId.get(item.parent_id)) {
    seen.add(item.id);
    const verification = passedByTarget.get(item.id);
    if (verification?.fromSnapshot !== item.parent_id) continue;
    for (const issue of verification.resolved) {
      if (!currentIds.has(issue.id) && !resolved.has(issue.id)) {
        resolved.set(issue.id, { issue, verificationId: verification.id });
      }
    }
  }

  return {
    project: { id: p.id, name: p.name, entry: p.entry, currentSnapshot: p.current_snapshot, createdAt: p.created_at },
    snapshots: snapshots.map(item => {
      const repair = passedByTarget.get(item.id);
      const rule = repair?.patch?.ruleId ?? repair?.resolved[0]?.ruleId;
      return { ...item, name: item.name ?? (item.parent_id ? (rule && repairNames[rule]) || item.description : '原始版本') };
    }),
    originalSnapshotId, baseline, current,
    summary: {
      initial: baseline?.issues.length ?? null,
      resolved: resolved.size,
      remaining: current ? baselineIssues.filter(issue => currentIds.has(issue.id)).length : 0,
      added: currentIssues.filter(issue => !baseIds.has(issue.id)).length,
    },
    resolved: [...resolved.values()],
    verifications,
  };
}

export function renameSnapshot(projectId: string, snapshotId: string, value: unknown) {
  const name = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!name || [...name].length > 48 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new Error('请输入 1–48 个字符的版本名称，名称须为单行。');
  }
  const item = snapshot(projectId, snapshotId);
  if (item.description === '验证失败' || item.description === '待验证修复') throw new Error('只能重命名有效版本。');
  db.prepare('UPDATE snapshots SET name=? WHERE id=? AND project_id=?').run(name, snapshotId, projectId);
  return { id: snapshotId, name };
}
