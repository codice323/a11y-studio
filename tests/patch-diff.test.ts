import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchDiff } from '../apps/web/src/patch-diff';

function compare(before: string, after: string, file = 'index.html') {
  const result = patchDiff({ file, selector: '#x', before, after });
  assert.equal(result.parts.filter(part => !part.added).map(part => part.value).join(''), before);
  assert.equal(result.parts.filter(part => !part.removed).map(part => part.value).join(''), after);
  return result.changes;
}

test('压缩 HTML 中只标记新增 alt，保留其他源码', () => {
  const before = '<main><img id="x" src="asset.png"><p>Other text</p></main>';
  const changes = compare(before, before.replace('asset.png"', 'asset.png" alt="盆栽"'));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].old, '');
  assert.equal(changes[0].next.trim(), 'alt="盆栽"');
  assert.equal(changes[0].label, '添加 alt 属性');
});

test('分别展示新增 label、ID、ARIA 值和 CSS 色值', () => {
  const edits = compare('<main><input><button aria-labelledby="old"></button></main>',
    '<main><label for="x">姓名</label><input id="x"><button aria-labelledby="new"></button></main>');
  assert.equal(edits.length, 3);
  assert.equal(edits[0].next, '<label for="x">姓名</label>');
  assert.equal(edits[1].next.trim(), 'id="x"');
  assert.equal(edits[2].old, 'old');
  assert.equal(edits[2].next, 'new');
  const [color] = compare('.caption { color: #c5c5c5; }', '.caption { color: #1f2d36; }', 'style.css');
  assert.equal(color.old, '#c5c5c5');
  assert.equal(color.next, '#1f2d36');
  assert.equal(color.label, '修改 CSS 声明 color');
});
