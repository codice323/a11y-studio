import { auditCandidate } from './scan';
import { walk } from './storage';

type Scope = { dir: string; entry: string; projectId: string; snapshotId: string };

export async function checkOtherPages(ctx: Scope, dir: string, signal?: AbortSignal) {
  const pages = walk(ctx.dir).filter(file => /\.html?$/i.test(file) && file !== ctx.entry).sort();
  const pending: string[] = [];
  if (pages.length > 8) pending.push(`附页扫描上限为 8 页，另有 ${pages.length-8} 页待验证。`);
  let completed = 0;
  for (const page of pages.slice(0,8)) {
    signal?.throwIfAborted();
    const audits = await (async () => {
      try {
        const before = await auditCandidate(ctx.projectId, ctx.snapshotId, ctx.dir, page, signal, undefined, true);
        const after = await auditCandidate(ctx.projectId, ctx.snapshotId, dir, page, signal, undefined, true);
        return {before,after};
      } catch (error) {
        signal?.throwIfAborted();
        pending.push(`${page}：附页扫描未完成（${(error as Error).message}）。`);
      }
    })();
    if (!audits) continue;
    completed++;
    const {before,after} = audits;
    const previous = new Set(before.issues.map(issue => issue.id));
    const added = after.issues.filter(issue => !previous.has(issue.id));
    if (added.length) throw new Error(`跨页回归：${page} 新增 ${added.map(issue => issue.ruleId + ' ' + issue.selector).join('、')}。`);
    if (JSON.stringify(before.functionChecks) !== JSON.stringify(after.functionChecks)) {
      throw new Error(`跨页回归：${page} 的控件交互属性发生变化。`);
    }
    const a = before.detection.behavior, b = after.detection.behavior;
    if (a.status !== 'completed' || b.status !== 'completed' ||
      JSON.stringify([a.tabSequence,a.findings]) !== JSON.stringify([b.tabSequence,b.findings])) {
      pending.push(`${page}：键盘证据不完整或焦点顺序需要复核。`);
    }
    for (const [index, capture] of (before.regression ?? []).entries()) {
      const candidate = after.regression?.[index];
      if (!candidate || capture.semantics !== candidate.semantics || capture.style !== candidate.style) {
        pending.push(`${page}：${capture.width}px 下的视觉或语义差异待验证。`);
      }
    }
  }
  return {name:'跨页复测',detail:pages.length ? `${completed}/${pages.length} 个附页已完成页面扫描` : '当前快照没有其他 HTML 页面',pending};
}
