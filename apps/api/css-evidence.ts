import type { Page } from 'playwright-core';
import { measurePageContrast } from './scan';

export async function inspectCssEvidence(page: Page, selector: string) {
  const session = await page.context().newCDPSession(page);
  const sources = new Map<string,string>();
  try {
    await session.send('DOM.enable');
    session.on('CSS.styleSheetAdded', ({header}) => {
      sources.set(header.styleSheetId, header.sourceURL + (header.isInline ? ` (页内，行 ${header.startLine + 1})` : ''));
    });
    await session.send('CSS.enable');
    const viewports = [];
    for (const width of [900,390]) {
      await page.setViewportSize({width,height:700});
      const {root} = await session.send('DOM.getDocument');
      const {nodeIds} = await session.send('DOM.querySelectorAll',{nodeId:root.nodeId,selector});
      if (nodeIds.length !== 1) throw new Error('无法在浏览器中唯一定位样式目标。');
      const read = async () => {
        const {computedStyle} = await session.send('CSS.getComputedStyleForNode',{nodeId:nodeIds[0]});
        const matched = await session.send('CSS.getMatchedStylesForNode',{nodeId:nodeIds[0]});
        type Match = NonNullable<typeof matched.matchedCSSRules>[number];
        type Style = NonNullable<typeof matched.inlineStyle>;
        const properties = (style?: Style) => style?.cssProperties.filter(p =>
          !p.disabled && p.parsedOk !== false && /^(--|color$|background|opacity$|outline|box-shadow$)/.test(p.name))
          .slice(-20).map(p=>({name:p.name,value:p.value,important:Boolean(p.important)}));
        const describe = ({rule,matchingSelectors}: Match) => ({
          source:sources.get(rule.styleSheetId ?? '') ?? rule.origin,
          line:(rule.style.range?.startLine ?? -1) + 1,
          selectors:matchingSelectors.map(i=>rule.selectorList.selectors[i]?.text),
          media:rule.media?.map(m=>m.text), layers:rule.layers?.map(l=>l.text),
          properties:properties(rule.style),
        });
        const rules = (list?: Match[]) => (list ?? []).filter(m=>properties(m.rule.style)?.length).slice(-10).map(describe);
        return {
          computed:computedStyle.filter(p=>/^(color$|background-color$|background-image$|outline|box-shadow$|opacity$)/.test(p.name)),
          inline:properties(matched.inlineStyle),
          matchedRules:rules(matched.matchedCSSRules),
          inherited:matched.inherited?.slice(0,5).map(item=>({inline:properties(item.inlineStyle),rules:rules(item.matchedCSSRules)})),
          pseudoElements:matched.pseudoElements?.slice(0,4).map(item=>({type:item.pseudoType,rules:rules(item.matches)})),
        };
      };
      const normal = await read();
      await session.send('CSS.forcePseudoState',{nodeId:nodeIds[0],forcedPseudoClasses:['focus','focus-visible']});
      const focused = await read();
      await session.send('CSS.forcePseudoState',{nodeId:nodeIds[0],forcedPseudoClasses:[]});
      viewports.push({width,contrast:await measurePageContrast(page,selector),normal,focused});
    }
    return viewports;
  } finally { await session.detach(); }
}
