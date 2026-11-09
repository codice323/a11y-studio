import AxeBuilder from '@axe-core/playwright';
import type { AxeResults } from 'axe-core';
import type { Page } from 'playwright-core';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ADDITIONAL_TAGS = ['wcag22a', 'best-practice'];
const EXPERIMENTAL = ['focus-order-semantics', 'hidden-content'];

export function classifyAxeResults(results: AxeResults, extended = true) {
  // Keep the original WCAG filter for issue IDs, repair, and regression checks.
  const isWcag = ({ tags }: { tags: string[] }) => tags.some(tag => WCAG_TAGS.includes(tag) || (extended && tag === 'wcag22a'));
  const violations = results.violations.filter(isWcag);
  const incomplete = results.incomplete.filter(isWcag);
  return {
    violations,
    incomplete,
    passes: results.passes.filter(isWcag).length,
    bestPractices: {
      violations: results.violations.filter(rule => !isWcag(rule)),
      incomplete: results.incomplete.filter(rule => !isWcag(rule)),
    },
  };
}

export async function scanRules(page: Page, extended = true) {
  const tags = extended ? [...WCAG_TAGS, ...ADDITIONAL_TAGS] : WCAG_TAGS;
  const builder = new AxeBuilder({ page }).withTags(tags);
  if (extended) builder.disableRules(EXPERIMENTAL);
  const results = await builder.analyze();
  return {
    ...classifyAxeResults(results, extended),
    rules: (['violations', 'incomplete', 'passes', 'inapplicable'] as const).flatMap(outcome =>
      results[outcome].map(rule => ({ id: rule.id, outcome }))),
    engine: { name: results.testEngine.name, version: results.testEngine.version, tags },
  };
}
