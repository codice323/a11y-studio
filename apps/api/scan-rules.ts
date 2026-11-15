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

// Criteria whose automated failures establish a barrier for nonvisual or low-vision access.
const visionCriteria = new Set([
  '111','123','125','131','132','133','141','143','144','145','1410','1411','1412','1413',
  '211','212','214','221','222','241','242','243','244','245','246','247','2411',
  '251','253','311','312','321','322','331','332','333','334','337','338','412','413',
]);

export function visionFindings(rules: AxeResults['violations']) {
  return rules.filter(rule=>rule.tags.some(tag=>tag.startsWith('wcag') && visionCriteria.has(tag.slice(4))))
    .flatMap(rule=>{
      const nodes=rule.nodes.filter(node=>node.target.length>0 && [...node.any,...node.all,...node.none].some(check=>Boolean(check.message?.trim())));
      return nodes.length ? [{...rule,nodes}] : [];
    });
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
