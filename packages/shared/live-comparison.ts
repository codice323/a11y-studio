import type { Control } from './panorama';

export type LiveSide = 'left' | 'right';
export type LiveFrame = {
  image: string; path: string; focus: string; scroll: number; controls: Control[];
};
export type LiveAction =
  | { action:'click'; x:number; y:number }
  | { action:'click' | 'fill' | 'validate'; target:Control }
  | { action:'activate' | 'tab' | 'shift-tab' | 'escape' | 'refresh' }
  | { action:'scroll'; delta:number };
export type LiveFinding = { rule:string; evidence:string; status:'needs-review' };
export type LiveComparison = {
  id:string; revision:number; left:LiveFrame; right:LiveFrame;
  outcome?: { action:string; side:LiveSide; target?:string; role?:string; delta?:number; matched:boolean | null; reason?:string };
  differences:{ route:boolean; dom:boolean; semantics:boolean; focus:boolean; visual:boolean };
  observations:Record<LiveSide,LiveFinding[]>;
};
