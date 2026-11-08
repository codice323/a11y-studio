import { z } from 'zod';
import type { ImageAltAnalysis, RepairAnalysis } from '../../../packages/shared/types';
import { analyzeVisualContext } from './vision';
import type { VisualTarget } from './visual-context';

const imageSchema = z.object({
  purpose:z.enum(['informative','decorative','uncertain']),
  description:z.string().trim().min(1).max(350).nullable(),
  contentAlt:z.string().trim().min(1).max(160).nullable(),
  reason:z.string().trim().min(1).max(240),
  detail:z.string().trim().max(600).optional(),
});
const iconSchema = z.object({
  description:z.string().trim().min(1).max(300),
  value:z.string().trim().min(1).max(160).nullable(),
  reason:z.string().trim().min(1).max(240),
  detail:z.string().trim().max(600).optional(),
});

export async function suggestImageAlt(target: Omit<VisualTarget,'mode'>, context: unknown): Promise<ImageAltAnalysis> {
  const result = await analyzeVisualContext({...target,mode:'image-resource'},{
    type:'image-alt',schema:imageSchema,context,
    instructions:'返回 description（只描述可见像素）、purpose（informative、decorative 或 uncertain）、reason（只用一句话说明用途依据或要确认的事，约20至60字）、contentAlt（选内容性图片时可用的非空候选，即使判断为装饰也可提供）以及可选 detail。图片无法看清时 description 和 contentAlt 可为 null。只有确认没有独立信息或功能才判断为 decorative。功能性图片优先说明已知动作或去向。',
  });
  if (result.status === 'unavailable') return {status:'needs-manual-review',purpose:'uncertain',
    description:null,contentAlt:null,reason:result.reason};
  const {data,media} = result;
  if (data.purpose === 'decorative' && result.context.control) {
    return {...data,media,status:'needs-manual-review',purpose:'uncertain',
      reason:'图片位于控件内。请确认控件已有独立名称，再决定是否使用空 alt。'};
  }
  return {...data,media,status:data.purpose === 'uncertain' ? 'needs-manual-review' : 'image-analysis'};
}

export async function suggestIconLabel(target: Omit<VisualTarget,'mode'>, context: unknown): Promise<RepairAnalysis> {
  const result = await analyzeVisualContext({...target,mode:'element'},{
    type:'icon-button',schema:iconSchema,context,
    instructions:'分析图标按钮名称。返回 description（只描述按钮截图中看到什么）、value（仅在视觉和邻近语义支持时给出简短动作名称，否则 null）、reason（一句话说明依据或需核对事项，约20至60字）和可选 detail。不要声称已经点击按钮或验证其功能。',
  });
  if (result.status === 'unavailable') return {status:'repair-review',suggestedValue:null,reason:result.reason};
  return {status:'repair-review',suggestedValue:result.data.value,description:result.data.description,
    reason:result.data.reason,detail:result.data.detail,media:result.media};
}
