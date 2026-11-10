import type { Control, InteractionFinding } from './panorama';

export type LiveSide = 'left' | 'right';
export type LiveFrame = {
  image: string; path: string; title: string; focus: string; scroll: number; zoom: number; controls: Control[];
};
export type LiveAction =
  | { action:'click'; x:number; y:number }
  | { action:'click' | 'fill' | 'validate'; target:Control }
  | { action:'activate' | 'tab' | 'shift-tab' | 'escape' | 'refresh' }
  | { action:'scroll'; delta:number }
  | { action:'zoom'; percent:75|100|125|150 };
export type LiveFinding = { rule:string; evidence:string; status:InteractionFinding['status']; selector?:string; step?:number };
export type LiveComparison = {
  id:string; revision:number; left:LiveFrame; right:LiveFrame;
  modes:Record<LiveSide,'source'|'snapshot'>;
  outcome?: { action:string; side:LiveSide; target?:string; role?:string; delta?:number; percent?:number; matched:boolean | null; reason?:string;
    executions?: Partial<Record<LiveSide,{status:'executed'|'failed'|'unmatched'; path?:string; focus?:string}>> };
  differences:{ route:boolean; dom:boolean; semantics:boolean; focus:boolean; visual:boolean };
  observations:Record<LiveSide,LiveFinding[]>;
};
