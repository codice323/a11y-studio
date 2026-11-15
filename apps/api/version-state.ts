import type { Issue, Patch, Scan } from '../../packages/shared/types';
import { audit, db, project, snapshot } from './storage';
import { reviewRepairIssue } from '../../packages/shared/source-repair';
import { browserCapture } from './browser-capture';

export type Snapshot = {
  id: string; parent_id: string | null; hash: string; created_at: string; description: string; name: string | null;
};
type Verification = {
  id: string; fromSnapshot: string; toSnapshot: string; status: 'passed' | 'applied' | 'failed';
  sourceTarget?: string; baselineAudit: string; audit: string | null; resolved: Issue[]; patch?: Patch & {contrastTargets?: {issueId:string}[]}; targetFixed?:boolean; reviewedTarget?:Issue; panoramaState?:string;
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

// Keep the last measured entry findings available along the applied version's branch.
export function inheritedSnapshotAudit(projectId:string, snapshotId:string): Scan | null {
  const versions = new Map(validSnapshots(projectId).map(version=>[version.id,version]));
  const applied = new Map(projectVerifications(projectId).filter(item=>item.status==='applied').map(item=>[item.toSnapshot,item]));
  const addressed = new Set<string>();
  const visited = new Set<string>();
  for (let version=versions.get(snapshotId); version && !visited.has(version.id); version=versions.get(version.parent_id ?? '')) {
    visited.add(version.id);
    const scan=latestSnapshotAudit(projectId,version.id);
    if (scan) return {...scan,issues:scan.issues.filter(issue=>!addressed.has(issue.id))};
    const repair=applied.get(version.id);
    if (!repair || repair.fromSnapshot!==version.parent_id) return null;
    if (!repair.panoramaState && repair.patch) {
      addressed.add(repair.patch.issueId);
      for (const target of repair.patch.contrastTargets ?? []) addressed.add(target.issueId);
    }
  }
  return null;
}

export function projectState(projectId: string) {
  const p = project(projectId);
  const snapshots = validSnapshots(projectId);
  const verifications = projectVerifications(projectId);
  const byId = new Map(snapshots.map(item => [item.id, item]));
  const appliedByTarget = new Map(verifications.filter(item => item.status !== 'failed').map(item => [item.toSnapshot, item]));
  const originalSnapshotId = snapshots.find(item => item.parent_id === null)?.id ?? null;
  const baseline = originalSnapshotId ? latestSnapshotAudit(projectId, originalSnapshotId) : null;
  const current = latestSnapshotAudit(projectId, p.current_snapshot);
  const baselineIssues = baseline?.issues ?? [];
  const inheritedIssues = current ? null : inheritedSnapshotAudit(projectId,p.current_snapshot)?.issues ?? null;
  const currentIssues = current?.issues ?? inheritedIssues ?? [];
  const baseIds = new Set(baselineIssues.map(issue => issue.id));
  const currentIds = new Set(currentIssues.map(issue => issue.id));

  const reviewIds=new Set(current?.detection?.behavior.findings.map(finding=>reviewRepairIssue(finding)?.id));

  // Follow actual parent links from the selected snapshot, newest repair first.
  const seen = new Set<string>();
  const resolved = new Map<string, { issue: Issue; verificationId: string }>();
  for (let item = byId.get(p.current_snapshot); current && item?.parent_id && !seen.has(item.id); item = byId.get(item.parent_id)) {
    seen.add(item.id);
    const verification = appliedByTarget.get(item.id);
    if (verification?.fromSnapshot !== item.parent_id) continue;
    const reviewed = verification.targetFixed && verification.reviewedTarget && !reviewIds.has(verification.reviewedTarget.id) && !verification.panoramaState
      ? [verification.reviewedTarget] : [];
    const manualTarget = verification.status === 'applied' && !verification.panoramaState ? verification.reviewedTarget : undefined;
    const manuallyChecked = manualTarget && manualTarget.id === verification.patch?.issueId &&
      latestSnapshotAudit(projectId,verification.fromSnapshot)?.issues.some(issue => issue.id === manualTarget.id) &&
      !current.incomplete?.some(item => item.ruleId === manualTarget.ruleId) &&
      !currentIssues.some(issue => issue.ruleId === manualTarget.ruleId &&
        (issue.id === manualTarget.id || issue.selector === (verification.sourceTarget ?? manualTarget.selector) ||
          (manualTarget.source && issue.source?.file === manualTarget.source.file && issue.source.key === manualTarget.source.key)))
      ? [manualTarget] : [];
    for (const issue of [...verification.resolved,...reviewed,...manuallyChecked]) {
      if (!currentIds.has(issue.id) && !resolved.has(issue.id)) {
        resolved.set(issue.id, { issue, verificationId: verification.id });
      }
    }
  }

  return {
    project: { id: p.id, name: p.name, entry: p.entry, mode: p.mode, currentSnapshot: p.current_snapshot, createdAt: p.created_at },
    snapshots: snapshots.map(item => {
      const repair = appliedByTarget.get(item.id);
      const rule = repair?.patch?.ruleId ?? repair?.resolved[0]?.ruleId;
      return { ...item, name: item.name ?? (item.parent_id ? (rule && repairNames[rule]) || item.description : '原始版本') };
    }),
    originalSnapshotId, baseline, current, inheritedIssues, browserCapture:browserCapture(projectId),
    summary: {
      initial: baseline?.issues.length ?? null,
      resolved: resolved.size,
      remaining: current || inheritedIssues ? baselineIssues.filter(issue => currentIds.has(issue.id)).length : 0,
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
