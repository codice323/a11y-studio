import type { BehaviorFinding, Issue } from './types';

export const sourceRepairKinds: Record<string, string> = {
  label: 'label', 'button-name': 'button', 'link-name': 'link', 'color-contrast': 'contrast',
  'focus-style-unchanged': 'focus', 'aria-valid-attr-value': 'aria', 'aria-broken-idref': 'aria',
};

export function reviewRepairIssue(finding: BehaviorFinding): Issue | undefined {
  const focus = finding.ruleId === 'focus-style-unchanged';
  if (!focus && finding.ruleId !== 'aria-broken-idref') return undefined;
  return {
    id: (focus ? 'focus:' : 'aria-ref:') + finding.selector, ruleId: finding.ruleId, selector: finding.selector,
    impact: 'unknown', description: finding.explanation, help: focus ? '焦点样式待复核' : 'ARIA 引用待复核',
    helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/' + (focus ? 'focus-visible' : 'name-role-value') + '.html',
    html: '', wcag: [focus ? '2.4.7' : '4.1.2'], bounds: null,
  };
}

export type SourceChange = {
  file: string;
  selector: string;
  reason: string;
  verification: string;
  before: string;
  after: string;
};

export type SourceReview = {
  changes: SourceChange[];
  checks: { name: string; detail: string }[];
  attempts: number;
  elapsedMs: number;
  usage: { requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; complete: boolean };
};
