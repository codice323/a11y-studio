import { useState } from 'react';
import { reviewRepairIssue } from '../../../packages/shared/source-repair';
import type { Issue } from './types';
import type { AiAuditFinding, DetectionEvidence } from '../../../packages/shared/types';

const behaviorStatus = {
  completed: '已完成',
  partial: '部分完成',
  unavailable: '行为检测不可用',
};

const aiDecision = { accepted: '人工认可', rejected: '人工排除', 'needs-review': '待复核' };

export function DetectionReview({ detection, report = false, aiConfigured = false, busy = false, onReview, onDecision, onRepair }: {
  detection?: DetectionEvidence; report?: boolean; aiConfigured?: boolean; busy?: boolean;
  onRepair?: (issue: Issue) => void;
  onReview?: () => void; onDecision?: (id: string, decision: AiAuditFinding['decision']) => void;
}) {
  const [consent, setConsent] = useState(false);
  if (!detection) return null;
  const { behavior, bestPractices, ai } = detection;
  const practices = [...bestPractices.violations, ...bestPractices.incomplete];
  const reviewCount = behavior.findings.filter(item => item.status === 'needs-review').length;
  const observationCount = behavior.findings.length - reviewCount;
  const content = <>
    <p>此处证据供人工判断，与待处理的确定违规分开统计。</p>
    <p><strong>浏览器行为 · {behaviorStatus[behavior.status]}</strong> · 待复核 {reviewCount} · 浏览器观测 {observationCount}</p>
    {behavior.findings.length > 0 && <ul>
      {behavior.findings.map(item => { const issue = reviewRepairIssue(item); return <li key={JSON.stringify([item.ruleId, item.selector, item.evidence])}>
        <strong>{item.status === 'needs-review' ? '待复核' : '浏览器观测'}</strong> · {item.explanation}
        <br /><code>{item.selector}</code>
        {onRepair && issue && <button type="button" className="record-link" disabled={busy}
          onClick={() => onRepair(issue)}>查看{item.ruleId === 'focus-style-unchanged' ? '焦点' : 'ARIA 引用'}修复 · {item.selector}</button>}
      </li>; })}
    </ul>}
    {behavior.tabSequence.length > 0 && <details>
      <summary>实际 Tab 顺序（{behavior.tabSequence.length} 个停靠点）</summary>
      <ol>{behavior.tabSequence.map(selector => <li key={selector}><code>{selector}</code></li>)}</ol>
    </details>}
    {behavior.limitations.length > 0 && <details>
      <summary>行为检测范围</summary>
      <ul>{behavior.limitations.map(note => <li key={note}>{note}</li>)}</ul>
    </details>}
    {practices.length > 0 && <details>
      <summary>axe 最佳实践（{practices.length} 条规则结果）</summary>
      <ul>{practices.map((rule, index) => <li key={rule.id + ':' + index}>{rule.help} · {rule.nodes.length} 个节点</li>)}</ul>
    </details>}
    {!report && !ai && <div className="ai-review-controls">
      <h4>AI 语义辅助复核</h4>
      <p>模型结合相关 WCAG 摘要，检查最多 20 个候选元素的名称、角色和附近文本；结果需人工确认。</p>
      <label><input type="checkbox" checked={consent} disabled={busy || !aiConfigured} onChange={event => setConsent(event.target.checked)} /> 我同意将上述页面文本发送给模型服务</label>
      <button type="button" className="secondary" disabled={busy || !aiConfigured || !consent || !behavior.semanticCandidates.length} onClick={onReview}>开始 AI 辅助复核</button>
      {!aiConfigured && <p>请先配置模型服务。</p>}
      {!behavior.semanticCandidates.length && <p>本次检测没有可复核的候选元素。</p>}
    </div>}
    {ai && <details open>
      <summary>AI 辅助复核（{ai.findings.length} 条疑似结果）</summary>
      <p>仅根据文本判断，不能代替人工或实际辅助技术测试。</p>
      {ai.findings.length === 0 && <p>模型未发现需要提示的疑点，不代表页面完全无障碍。</p>}
      {ai.findings.length > 0 && <ul>{ai.findings.map(item => <li key={item.id}>
        <strong>{aiDecision[item.decision]}</strong> · {item.explanation}
        <br /><code>{item.candidate.selector}</code>
        {item.sources && item.sources.length > 0 && <details>
          <summary>关联的规范参考</summary>
          <p>以下摘要按元素类型检索，具体是否适用需要人工核对。</p>
          <ul>{item.sources.map(source=><li key={source.id}>{source.title} · WCAG {source.refs.join('、')}：{source.text} <a href={source.url} target="_blank" rel="noreferrer">查看规范原文</a></li>)}</ul>
        </details>}
        {!report && onDecision && <div className="ai-review-actions" aria-label="人工复核结果">
          <button type="button" className="secondary" disabled={busy || item.decision === 'accepted'} onClick={() => onDecision(item.id, 'accepted')}>确认疑点</button>
          <button type="button" className="secondary" disabled={busy || item.decision === 'rejected'} onClick={() => onDecision(item.id, 'rejected')}>排除此项</button>
          {item.decision !== 'needs-review' && <button type="button" className="secondary" disabled={busy} onClick={() => onDecision(item.id, 'needs-review')}>恢复待复核</button>}
        </div>}
      </li>)}</ul>}
    </details>}
  </>;
  if (report) return <div className="detection-review"><h3>V2 检测证据</h3>{content}</div>;
  return <details className="detection-review workbench-review">
    <summary>V2 检测证据 · {behaviorStatus[behavior.status]}</summary>
    <div className="detection-review-body" role="region" aria-label="V2 检测证据" tabIndex={0}>{content}</div>
  </details>;
}
