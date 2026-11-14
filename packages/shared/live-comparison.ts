import type { Control, InteractionFinding } from './panorama';

export type LiveSide = 'left' | 'right';
export const liveEditingKeys = ['Enter','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'] as const;
type HighlightBox = {x:number;y:number;width:number;height:number};
export type LiveFrame = {
  image: string; path: string; title: string; focus: string; scroll: number; zoom: number; controls: Control[]; width?:number; height?:number;
  location?: {status:'located'|'missing'|'hidden'|'outside';bounds?:HighlightBox;highlights?:HighlightBox[]};
};
export type LiveAction =
  | { action:'click'; x:number; y:number }
  | { action:'text'; text:string }
  | { action:'key'; key:typeof liveEditingKeys[number]; shift:boolean }
  | { action:'click' | 'fill' | 'validate'; target:Control }
  | { action:'activate' | 'tab' | 'shift-tab' | 'escape' | 'refresh' | 'back' }
  | { action:'locate'; path:string; selector:string; selectors?:string[] }
  | { action:'scroll'; delta:number; x?:number; y?:number }
  | { action:'zoom'; percent:75|100|125|150 };
export type LiveFinding = { rule:string; evidence:string; status:InteractionFinding['status']; selector?:string; step?:number };
export type LiveComparison = {
  id:string; revision:number;
  capture:{ count:number; elapsedMs:number }; left:LiveFrame; right:LiveFrame;
  modes:Record<LiveSide,'source'|'snapshot'|'replay'>;
  outcome?: { action:string; side:LiveSide; target?:string; role?:string; delta?:number; percent?:number; scroll?:Partial<Record<LiveSide,{container:string; position:number}>>; matched:boolean | null; reason?:string;
    uncapturedUrl?:string; executions?: Partial<Record<LiveSide,{status:'executed'|'failed'|'unmatched'; path?:string; focus?:string}>> };
  differences:{ route:boolean; dom:boolean; semantics:boolean; focus:boolean; visual:boolean };
  observations:Record<LiveSide,LiveFinding[]>;
};
