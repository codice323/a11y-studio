import { diffArrays, diffLines } from 'diff';

export type PatchFile = { file: string; selector: string; before: string; after: string };
type Part = { value: string; added?: boolean; removed?: boolean };
export type Change = { old: string; next: string; before: string; after: string; line: number; label: string };

function tokens(source: string, file: string) {
  if (/\.html?$/i.test(file)) {
    // Keep quoted attribute values intact, even when a tag contains ">".
    return (source.match(/<!--[\s\S]*?-->|<(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+|</g) ?? []).flatMap(value =>
      value.startsWith('<') && !value.startsWith('<!--')
        ? value.match(/<\/?[\w:-]+|\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?|[^\s]+?(?=[\s>])|[\s\S]/g) ?? []
        : value.match(/\s+|[^\s]+/g) ?? []);
  }
  return source.match(/#[\da-f]{3,8}\b|[\w-]+|\s+|[\s\S]/gi) ?? [];
}

export function patchDiff(file: PatchFile) {
  let parts: Part[] | undefined;
  let fallback = false;
  if (file.before.length + file.after.length <= 180_000) {
    const old = tokens(file.before, file.file), next = tokens(file.after, file.file);
    if (old.join('') === file.before && next.join('') === file.after) {
      parts = diffArrays(old, next, { maxEditLength: 2500, timeout: 100 })?.map(part => ({ ...part, value: part.value.join('') }));
    }
  }
  if (!parts) {
    fallback = true;
    parts = diffLines(file.before, file.after, { timeout: 100 }) ??
      [{ value: file.before, removed: true }, { value: file.after, added: true }];
  }
  const changes: Change[] = [];
  let line = 1;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!part.added && !part.removed) { line += part.value.split('\n').length - 1; i++; continue; }
    const leading = parts[i - 1]?.value ?? '';
    let old = '', next = '';
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const edit = parts[i++];
      if (edit.removed) old += edit.value;
      else next += edit.value;
    }
    const trailing = parts[i]?.value ?? '';
    const startLine = line;
    line += old.split('\n').length - 1;
    const attr = old.trim().match(/^([\w:-]+)\s*=/)?.[1] ?? next.trim().match(/^([\w:-]+)\s*=/)?.[1];
    const node = (next.trim() || old.trim()).match(/^<([\w:-]+)/)?.[1];
    const property = /\.css$/i.test(file.file) && leading.match(/([\w-]+):\s*$/)?.[1];
    const label = attr ? `${old.trim() ? next.trim() ? '修改' : '删除' : '添加'} ${attr} 属性`
      : /\.css$/i.test(file.file) ? property ? `修改 CSS 声明 ${property}` : next.includes('{') ? '新增 CSS 规则' : '修改 CSS 声明'
      : node ? `${!old.trim() ? '新增' : !next.trim() ? '删除' : '修改'} <${node}> 节点` : '修改源码文字';
    // Trim a compact display window only. Full-file mode retains every byte.
    const format = (fragment: string) => /\.html?$/i.test(file.file) ? fragment.replace(/>(?=<)/g, '>\n') : fragment;
    let before = format(leading).split('\n').slice(-3).join('\n').slice(-180);
    let after = format(trailing).split('\n').slice(0, 3).join('\n').slice(0, 180);
    const quoted = /^(\s*[\w:-]+\s*=\s*["'])([\s\S]*)(["'])$/;
    const oldAttr = attr && old.match(quoted), newAttr = attr && next.match(quoted);
    if (oldAttr && newAttr && oldAttr[1] === newAttr[1] && oldAttr[3] === newAttr[3]) {
      before += oldAttr[1];
      after = oldAttr[3] + after;
      old = oldAttr[2];
      next = newAttr[2];
    }
    changes.push({ old, next, before, after, line: startLine, label });
  }
  return { parts, changes, fallback };
}
