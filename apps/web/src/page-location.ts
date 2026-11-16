import type { LiveFrame } from '../../../packages/shared/live-comparison';

export function pageLocationMessage(location: LiveFrame['location']) {
  switch (location?.status) {
    case 'located': return '已标出问题位置';
    case 'missing': return '当前网页未找到唯一匹配，可能是内容已更新。可重新检测当前页面。';
    case 'hidden': return '已找到元素，但它当前不可见。打开对应菜单或弹窗后可再次定位。';
    case 'outside': return '已找到元素，但它在当前可见区域之外。可滚动网页查看。';
    default: return '这项问题没有可高亮的单一元素。';
  }
}
