/** Normalize the URL entry before opening a capture session. */
export function normalizeCaptureUrl(input:string):string {
  const value=input.trim();
  if(!value || value.length>2048 || /\s/.test(value)) throw new Error('请输入有效的网页地址，例如 baidu.com。');
  const candidate=/^[a-z][a-z0-9+.-]*:/i.test(value)?value:'https://'+value.replace(/^\/\//,'');
  let url:URL;
  try {url=new URL(candidate);} catch {throw new Error('请输入有效的网页地址，例如 baidu.com。');}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持不含账号信息的 HTTP 或 HTTPS 网页地址。');
  return url.href;
}
