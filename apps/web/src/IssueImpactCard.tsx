import { Eye } from 'lucide-react';

export function IssueImpactCard({ problem, impact }: { problem: string; impact: string }) {
  return <section className="issue-impact" aria-label="问题对网页使用者的影响">
    <span className="issue-impact-icon" aria-hidden="true"><Eye size={19} /></span>
    <div className="issue-impact-copy">
      <span className="issue-impact-label">对网页使用者的影响</span>
      <h3>{problem}</h3>
      <p>{impact}</p>
    </div>
    <span className="issue-impact-review">自动检测 · 建议人工复核</span>
  </section>;
}
