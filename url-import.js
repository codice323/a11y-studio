import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import * as cheerio from 'cheerio';

const MAX_HTML = 2 * 1024 * 1024;
const MAX_CSS = 256 * 1024;
function publicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
async function resolvePublicFallback(hostname) {
  const resolver = new URL('https://dns.alidns.com/resolve');
  resolver.searchParams.set('name', hostname); resolver.searchParams.set('type', 'A');
  const response = await fetch(resolver, {signal:AbortSignal.timeout(5000), headers:{Accept:'application/json'}});
  if (!response.ok) throw new Error('无法解析该网页地址。');
  const data = await response.json();
  if (data.Status !== 0) throw new Error('无法解析该网页地址。');
  return (data.Answer || []).filter(item => item.type === 1 && net.isIP(item.data) === 4).map(item => ({address:item.data, family:4}));
}
async function safeUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('请输入完整的 http 或 https 网页地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port))) throw new Error('仅支持不含账号信息、使用常规端口的 HTTP 或 HTTPS 地址。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = net.isIP(hostname) ? [{address: hostname, family: net.isIP(hostname)}] : await dns.lookup(hostname, {all:true, verbatim:true}); }
  catch { throw new Error('无法解析该网页地址。'); }
  // Some local proxy environments return synthetic benchmark-range DNS addresses.
  // Resolve those names via public DNS and connect to the verified real address instead.
  if (!net.isIP(hostname) && addresses.length && addresses.every(item => /^198\.(18|19)\./.test(item.address))) {
    try { addresses = await resolvePublicFallback(hostname); } catch { throw new Error('无法解析该网页地址。'); }
  }
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('仅支持公网网页地址。');
  addresses.sort((a,b) => a.family - b.family);
  return {url, selected: addresses[0]};
}
async function requestResource(input, maxBytes, redirects = 0) {
  if (redirects > 4) throw new Error('网页重定向次数过多。');
  const {url, selected} = await safeUrl(input);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve,reject) => {
    const req = transport.get(url, {headers:{'User-Agent':'Mozilla/5.0 (compatible; A11yStudio/0.1)', 'Accept':'text/html,text/css;q=0.9,*/*;q=0.1', 'Accept-Encoding':'identity'}, signal:AbortSignal.timeout(8000), family:selected.family, lookup:(_host, options, callback) => options.all ? callback(null,[selected]) : callback(null,selected.address,selected.family)}, res => {
      const status = res.statusCode || 0;
      if ([301,302,303,307,308].includes(status)) {
        const location = res.headers.location; res.resume();
        if (!location) return reject(new Error('网页重定向地址无效。'));
        let next; try { next = new URL(location,url).href; } catch { return reject(new Error('网页重定向地址无效。')); }
        requestResource(next,maxBytes,redirects+1).then(resolve,reject); return;
      }
      if (status < 200 || status >= 300) { res.resume(); return reject(new Error(`网页返回 HTTP ${status}。`)); }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {res.resume(); return reject(new Error('网页使用了暂不支持的压缩格式。'));}
      let bytes=0; const chunks=[];
      res.on('data', chunk => { bytes+=chunk.length; if(bytes>maxBytes){res.destroy(new Error('网页内容超过大小限制。'));} else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end',()=>{
        const contentType = String(res.headers['content-type'] || '');
        const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || 'utf-8';
        let text; try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { text = new TextDecoder('utf-8').decode(Buffer.concat(chunks)); }
        resolve({text,contentType,url:url.href});
      });
    });
    req.on('error', error => reject(new Error(error.name === 'AbortError' ? '网页请求超时。' : `网页读取失败：${error.message}`)));
  });
}
export async function importPage(input) {
  const page = await requestResource(input,MAX_HTML);
  if (!/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(page.contentType)) throw new Error('该地址返回的不是 HTML 网页。');
  const $ = cheerio.load(page.text);
  const links = $('link[rel~="stylesheet"][href]').toArray().slice(0,5);
  let loaded = 0;
  await Promise.all(links.map(async element => {
    let href; try { href = new URL($(element).attr('href'),page.url).href; } catch { return; }
    try {
      const css = await requestResource(href,MAX_CSS);
      if (!/text\/css/i.test(css.contentType)) return;
      const style = $('<style></style>'); style.text(css.text.replace(/<\/style/gi,'<\\/style')); $(element).replaceWith(style); loaded++;
    } catch { /* Some public sites block stylesheet fetching. Preview remains usable. */ }
  }));
  return {html:$.html(), url:page.url, stylesheetsFound:$('link[rel~="stylesheet"][href]').length + loaded, stylesheetsLoaded:loaded};
}
