import fs from 'node:fs';
import path from 'node:path';
import { safePath, snapshotDir } from '../storage';
import { isRasterImage } from '../url-snapshot';
import { withSnapshotPage } from '../scan';

const maxImageChars = 1_500_000;
const maxImageBytes = Math.floor(maxImageChars * 0.74);
const imageTypes = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'],
]);

function snapshotPixels(directory: string, source: string) {
  try {
    const url = new URL(source);
    if (url.origin !== 'http://a11y.local') return null;
    const name = decodeURIComponent(url.pathname.slice(1));
    const type = imageTypes.get(name.split('.').pop()?.toLowerCase() ?? '');
    if (!type) return null;
    const file = safePath(directory, name);
    if (!fs.realpathSync(file).startsWith(fs.realpathSync(directory) + path.sep)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxImageBytes) return null;
    const body = fs.readFileSync(file);
    if (body.length > maxImageBytes || !isRasterImage({type, body})) return null;
    return 'data:' + type + ';base64,' + body.toString('base64');
  } catch { return null; }
}

export const missingImageEvidence = '视觉证据缺失：浏览器未能解码目标图片。若只上传了 HTML，请将 HTML 和关联图片、CSS 按原目录打包为 ZIP 后重新导入。';

export type VisualTarget = {
  projectId: string;
  snapshotId: string;
  selector: string;
  mode: 'image-resource' | 'element' | 'surroundings';
};

export async function collectVisualContext({projectId,snapshotId,selector,mode}: VisualTarget) {
  return withSnapshotPage(projectId, snapshotId, undefined, async page => {
    const target = page.locator(selector);
    if (await target.count() !== 1) return null;
    await target.scrollIntoViewIfNeeded({timeout:2500}).catch(() => {});
    if (mode === 'image-resource') {
      const loaded = await page.waitForFunction(query => {
        const element = document.querySelector(query);
        return element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0;
      }, selector, {timeout:2500}).then(async handle => { await handle.dispose(); return true; }, () => false);
      if (!loaded) return null;
    }
    const evidence = await target.evaluate(element => {
      const control = element.closest('a[href],button,label,summary,[role="link"],[role="button"],[role="menuitem"],[tabindex]');
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        source: element instanceof HTMLImageElement ? element.currentSrc : '',
        context: {
          lang: document.documentElement.lang.slice(0,30),
          tag: element.localName,
          caption: (element.closest('figure')?.querySelector('figcaption')?.textContent ?? '').trim().slice(0,240),
          nearbyText: (element.parentElement?.innerText ?? '').trim().slice(0,380),
          heading: (element.closest('section,article,main,header,nav')?.querySelector('h1,h2,h3,h4,h5,h6')?.textContent ?? '').trim().slice(0,140),
          control: control ? {role:control.getAttribute('role') || control.localName,
            label:(control.getAttribute('aria-label') ?? '').trim().slice(0,120),
            text:(control.textContent ?? '').trim().slice(0,140)} : null,
          styles: {color:style.color, backgroundColor:style.backgroundColor, outline:style.outline, display:style.display},
          bounds: {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
        },
      };
    });
    const context = {...evidence.context, semantics:(await target.ariaSnapshot({timeout:1000}).catch(() => '')).slice(0,240)};
    // Do not include URLs or file names in the evidence sent to the model.
    if (mode === 'image-resource') {
      const original = snapshotPixels(snapshotDir(projectId, snapshotId), evidence.source);
      if (original) return {context, pixels:original, source:'snapshot-resource'};
      const decoded = await target.evaluate(element => {
        if (!(element instanceof HTMLImageElement)) return null;
        try {
          const scale = Math.min(1,960 / Math.max(element.naturalWidth,element.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(element.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(element.naturalHeight * scale));
          const drawing = canvas.getContext('2d');
          if (!drawing) return null;
          drawing.drawImage(element,0,0,canvas.width,canvas.height);
          return canvas.toDataURL('image/webp',0.9);
        } catch { return null; }
      });
      if (decoded && decoded.length <= maxImageChars) return {context,pixels:decoded,source:'decoded-image'};
    }
    const bounds = await target.boundingBox({timeout:2000});
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || bounds.width > 1200 || bounds.height > 1200) return null;
    const options = {type:'png' as const,timeout:3000,animations:'disabled' as const};
    const viewport = page.viewportSize();
    const clip = viewport && {
      x:Math.max(0,bounds.x-64),y:Math.max(0,bounds.y-64),
      width:Math.min(viewport.width,bounds.x+bounds.width+64)-Math.max(0,bounds.x-64),
      height:Math.min(viewport.height,bounds.y+bounds.height+64)-Math.max(0,bounds.y-64),
    };
    // Page screenshot clips use document coordinates. Apply the current scroll offset.
    if (mode === 'surroundings' && clip && clip.width > 0 && clip.height > 0) {
      const scroll = await page.evaluate(() => ({x:window.scrollX,y:window.scrollY}));
      const bytes = await page.screenshot({...options,clip:{...clip,x:clip.x+scroll.x,y:clip.y+scroll.y}}).catch(() => null);
      if (bytes && bytes.length <= maxImageBytes) return {context,pixels:'data:image/png;base64,'+bytes.toString('base64'),source:'surroundings-screenshot'};
    }
    const screenshot = await target.screenshot(options).catch(() => null);
    if (!screenshot || screenshot.length > maxImageBytes) return null;
    return {context,pixels:'data:image/png;base64,'+screenshot.toString('base64'),source:'element-screenshot'};
  });
}
