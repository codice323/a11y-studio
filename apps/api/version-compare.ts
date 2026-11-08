import fs from 'node:fs';
import { project, safePath, snapshotDir, walk } from './storage';
import { latestSnapshotAudit, projectVerifications, validSnapshots } from './version-state';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const maxFileBytes = 512 * 1024;
const maxDiffBytes = 2 * 1024 * 1024;

function compareFiles(projectId: string, left: string, right: string) {
  const leftDir = snapshotDir(projectId, left);
  const rightDir = snapshotDir(projectId, right);
  const leftFiles = new Set(walk(leftDir));
  const rightFiles = new Set(walk(rightDir));
  let remaining = maxDiffBytes;
  return [...new Set([...leftFiles, ...rightFiles])].sort().flatMap(file => {
    const before = leftFiles.has(file) ? fs.readFileSync(safePath(leftDir, file)) : null;
    const after = rightFiles.has(file) ? fs.readFileSync(safePath(rightDir, file)) : null;
    if (before && after && before.equals(after)) return [];
    const kind = !before ? 'added' as const : !after ? 'removed' as const : 'modified' as const;
    const bytes = (before?.length ?? 0) + (after?.length ?? 0);
    let source: { before: string; after: string } | null = null;
    if (bytes <= maxFileBytes && bytes <= remaining && !before?.includes(0) && !after?.includes(0)) {
      try {
        source = { before: before ? utf8.decode(before) : '', after: after ? utf8.decode(after) : '' };
        remaining -= bytes;
      } catch {
        // Non-text files still appear in the summary.
      }
    }
    return [{ file, kind, source }];
  });
}

export function compareSnapshots(projectId: string, leftId: string, rightId: string, issueId?: string, selector?: string) {
  project(projectId);
  const snapshots = validSnapshots(projectId);
  const byId = new Map(snapshots.map(item => [item.id, item]));
  const left = byId.get(leftId);
  const right = byId.get(rightId);
  if (!left || !right) throw new Error('请选择当前项目中的两个有效版本。');

  const verifiedByTarget = new Map(projectVerifications(projectId)
    .filter(item => item.status === 'passed' && item.fromSnapshot === byId.get(item.toSnapshot)?.parent_id)
    .map(item => [item.toSnapshot, item]));
  function side(id: string) {
    const scan = latestSnapshotAudit(projectId, id);
    const issue = scan?.issues.find(item => item.id === issueId);
    const positional = selector && /:(?:nth-|first-|last-|only-)/i.test(selector);
    let target = issue?.selector || (positional ? undefined : selector);
    // A structural repair may have assigned a new locator. It only applies on its actual descendant branch.
    const visited = new Set<string>();
    if (!issue && selector) {
      for (let item = byId.get(id); item?.parent_id && !visited.has(item.id); item = byId.get(item.parent_id)) {
        visited.add(item.id);
        const repair = verifiedByTarget.get(item.id);
        if (repair?.sourceTarget && (repair.patch?.issueId === issueId || repair.patch?.selector === selector)) {
          target = repair.sourceTarget;
          break;
        }
      }
    }
    const review = [
      ...(scan?.incomplete ?? []).map(item => ({ label: item.help, detail: `${item.ruleId} · ${item.count} 项需复核` })),
      ...(scan?.detection?.behavior.findings ?? []).filter(item => item.status === 'needs-review')
        .map(item => ({ label: item.ruleId, detail: item.selector + ' · ' + item.explanation })),
      ...(scan?.detection?.ai?.findings ?? []).filter(item => item.decision === 'needs-review')
        .map(item => ({ label: 'AI 语义复核', detail: item.candidate.selector + ' · ' + item.explanation })),
    ];
    return { scan, evidence: { id, auditId: scan?.id, screenshot: scan?.screenshot, selector: target }, review };
  }

  const before = side(leftId);
  const after = leftId === rightId ? before : side(rightId);
  const brief = ({ id, ruleId, selector, help }: { id: string; ruleId: string; selector: string; help: string }) => ({ id, ruleId, selector, help });
  const findings = before.scan && after.scan ? (() => {
    const old = new Set(before.scan.issues.map(issue => issue.id));
    const next = new Set(after.scan.issues.map(issue => issue.id));
    return {
      resolved: before.scan.issues.filter(issue => !next.has(issue.id)).map(brief),
      added: after.scan.issues.filter(issue => !old.has(issue.id)).map(brief),
    };
  })() : null;
  return {
    left: before.evidence,
    right: after.evidence,
    files: left.hash === right.hash ? [] : compareFiles(projectId, leftId, rightId),
    findings,
    review: { left: before.review, right: after.review },
  };
}
