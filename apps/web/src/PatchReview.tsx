import { useMemo, useState } from 'react';
import { patchDiff, type PatchFile } from './patch-diff';
import type { Proposal, Verification } from './types';
import type { ContrastEvidence } from './semantics';

type Mode = 'changes' | 'context' | 'full';
const modes: [Mode, string][] = [['changes', '只看改动'], ['context', '查看上下文'], ['full', '查看完整文件']];

export function PatchReview({ proposal, verification, problem, impact, rule, contrast }: {
  proposal: Proposal | null; verification?: Verification; problem: string; impact: string; rule?: string;
  contrast?: { before: ContrastEvidence | null; after: ContrastEvidence | null };
}) {
  const [mode, setMode] = useState<Mode>('changes');
  const [fullSide, setFullSide] = useState<'before' | 'after'>('after');
  const files = useMemo<PatchFile[]>(() => proposal
    ? proposal.sourceReview?.changes ?? [{ file: proposal.patch.targetFile, selector: proposal.patch.selector, before: proposal.before, after: proposal.after }]
    : verification?.sourceReview?.changes ?? verification?.reviewFiles ?? [], [proposal, verification]);
  const diffs = useMemo(() => files.map(file => ({ file, ...patchDiff(file) })), [files]);
  const first = diffs[0];
  const headline = diffs.flatMap(item => item.changes.map(change => change.label));
  const measure = (value?: ContrastEvidence | null) => value && !value.uncertain ? value.ratio.toFixed(2) + ':1' : '暂无可靠测量';
  const check = contrast?.after ?? verification?.contrastCheck;
  const beforeContrast = contrast?.before ?? verification?.contrastBefore;
  const outcome: Record<string, string> = {
    'image-alt': '替代文本与图片语义', 'link-name': '链接可访问名称', label: '表单标签关联',
    'aria-valid-attr-value': 'ARIA 引用及可访问名称', 'aria-broken-idref': 'ARIA 引用及可访问名称',
    'color-contrast': '实测对比度', 'focus-style-unchanged': 'Tab 可达性与焦点提示', 'button-name': '按钮可访问名称',
  };
  return <>
    <section className="repair-summary" aria-label="修复摘要">
      <h3>修复摘要</h3>
      <dl>
        <dt>问题</dt><dd>{problem}</dd>
        <dt>原因</dt><dd>{impact}</dd>
        <dt>位置</dt><dd>{first ? <><code>{first.file.file}</code> · <code>{first.file.selector}</code>{files.length > 1 && ` 等 ${files.length} 个文件`}</> : <code>{verification?.patch?.targetFile ?? '历史补丁'}</code>}</dd>
        <dt>方案</dt><dd>{[...new Set(headline)].join('、') || '按历史补丁记录核对变更'}</dd>
        <dt>结果</dt><dd>{verification ? verification.status === 'passed' ? '已应用 · 自动复测通过' : '验证未通过'
          : proposal?.sourceReview ? '待应用 · 隔离验证通过，应用后再次复测' : '待应用 · 确认后运行自动复测'}{rule && outcome[rule] && <> · 核对{outcome[rule]}</>}</dd>
      </dl>
      {check && <p className="contrast-proof">
        {beforeContrast?.foreground && check.foreground && <>实测文字颜色 <code>{beforeContrast.foreground}</code> → <code>{check.foreground}</code><br /></>}
        对比度 {measure(beforeContrast)} → <strong>{measure(check)}</strong> · 要求 {check.required}:1 · {check.uncertain ? '需人工复核' : check.valid ? '对比度达标' : '对比度未达标'}
      </p>}
    </section>
    {diffs.length > 0 ? <>
      <div className="shot-options patch-modes" role="group" aria-label="代码显示范围">
        {modes.map(([id, label]) => <button key={id} type="button" aria-pressed={mode === id} onClick={() => setMode(id)}>{label}</button>)}
      </div>
      {mode === 'full' && <div className="shot-options patch-modes" role="group" aria-label="完整文件版本">
        <button type="button" aria-pressed={fullSide === 'before'} onClick={() => setFullSide('before')}>修复前源码</button>
        <button type="button" aria-pressed={fullSide === 'after'} onClick={() => setFullSide('after')}>修复后源码</button>
      </div>}
      <div className="diff-legend"><span>− 删除</span><span>+ 新增</span></div>
      {diffs.map(({file, parts, changes, fallback}) => <section key={file.file} className="patch-file">
        <h4>{file.file}<small>{changes.length} 处变更{fallback && ' · 行级差异'}</small></h4>
        <p className="muted">目标 <code>{file.selector}</code> · 影响范围以此文件下的实际修改为准</p>
        <div role="region" aria-label={verification ? '已保存的源码差异' : proposal?.sourceReview ? file.file + ' 源码差异' : '待审核的源码差异'}>
          {mode === 'full' ? <pre className="diff" tabIndex={0}>{parts.filter(part => fullSide === 'after' ? !part.removed : !part.added).map((part, i) =>
            part.added ? <ins key={i}>{part.value}</ins> : part.removed ? <del key={i}>{part.value}</del> : <span key={i}>{part.value}</span>)}</pre>
          : changes.map((change, i) => <article key={i} className="patch-change">
            <h5>{change.label}<small>原文件约第 {change.line} 行</small></h5>
            <div className="patch-pair">
              {([[change.old, '原值'], [change.next, '新值']] as const).map(([value, label]) =>
                <div key={label}><span>{label}</span><pre className="diff" tabIndex={0}>{mode === 'context' && change.before}
                  {value ? label === '原值' ? <del>{value}</del> : <ins>{value}</ins> : <i>（无）</i>}
                  {mode === 'context' && change.after}
                </pre></div>)}
            </div>
          </article>)}
        </div>
      </section>)}
    </> : verification?.diff && <><p className="muted">此历史记录仅保留了统一差异，可展开查看原始记录。</p>
      <details><summary>查看历史补丁</summary><pre className="diff unified-diff" tabIndex={0} aria-label="已保存的源码差异">{verification.diff}</pre></details></>}
    {Boolean(proposal?.sourceReview?.checks.length || proposal?.reason) && <details className="patch-details">
      <summary>查看验证依据与技术说明</summary>
      {proposal?.reason && <p>{proposal.reason}</p>}
      {proposal?.sourceReview && <ul>{proposal.sourceReview.checks.map(check => <li key={check.name}>{check.name} · {check.detail}</li>)}</ul>}
    </details>}
  </>;
}
