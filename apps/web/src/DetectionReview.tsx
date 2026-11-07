import type { DetectionEvidence } from '../../../packages/shared/types';

const behaviorStatus = {
  completed: '已完成',
  partial: '部分完成',
  unavailable: '行为检测不可用',
};

const aiDecision = { accepted: '人工认可', rejected: '人工排除', 'needs-review': '待复核' };

export function DetectionReview({ detection, report = false }: { detection?: DetectionEvidence; report?: boolean }) {
  if (!detection) return null;
  const { behavior, bestPractices, ai } = detection;
  const practices = [...bestPractices.violations, ...bestPractices.incomplete];
  const reviewCount = behavior.findings.filter(item => item.status === 'needs-review').length;
  const observationCount = behavior.findings.length - reviewCount;
  const content = <>
    <p>此处证据供人工判断，与待处理的确定违规分开统计。</p>
    <p><strong>浏览器行为 · {behaviorStatus[behavior.status]}</strong> · 待复核 {reviewCount} · 浏览器观测 {observationCount}</p>
    {behavior.findings.length > 0 && <ul>
      {behavior.findings.map(item => <li key={JSON.stringify([item.ruleId, item.selector, item.evidence])}>
        <strong>{item.status === 'needs-review' ? '待复核' : '浏览器观测'}</strong> · {item.explanation}
        <br /><code>{item.selector}</code>
      </li>)}
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
    {ai && <details>
      <summary>AI 辅助复核（{ai.findings.length} 条疑似结果）</summary>
      {ai.findings.length > 0 && <ul>{ai.findings.map(item => <li key={item.id}>
        <strong>{aiDecision[item.decision]}</strong> · {item.explanation}
        <br /><code>{item.candidate.selector}</code>
      </li>)}</ul>}
    </details>}
  </>;
  if (report) return <div className="detection-review"><h3>V2 检测证据</h3>{content}</div>;
  return <details className="detection-review workbench-review">
    <summary>V2 检测证据 · {behaviorStatus[behavior.status]}</summary>
    <div className="detection-review-body" role="region" aria-label="V2 检测证据" tabIndex={0}>{content}</div>
  </details>;
}
