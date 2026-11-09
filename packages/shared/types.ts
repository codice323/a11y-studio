import type { Result } from 'axe-core';

export type JobStatus = 'queued'|'running'|'completed'|'failed';
export type Issue = {id:string; ruleId:string; selector:string; impact:string; description:string; help:string; helpUrl:string; html:string; wcag:string[]; bounds:{x:number;y:number;width:number;height:number}|null;source?:{key:string;file:string;tag:string;line:number}};
export type Scan = {id:string; projectId:string; snapshotId:string; status:JobStatus; issues:Issue[]; incomplete:{ruleId:string;help:string;count:number}[]; screenshot:string; size?: {width:number; height:number}; createdAt:string; error?:string; detection?: DetectionEvidence};
export type Patch = {issueId:string; ruleId:string; targetFile:string; selector:string; fileHash:string; operation:'set-alt'|'set-label'|'set-name'|'set-color'; value:string};
export type Proposal = {id:string; issueId:string; projectId:string; snapshotId:string; patch:Patch; reason:string; impact:string; wcag:string[]; risk:string; source:'ai'|'manual'; before:string; after:string; status:string};

export type BehaviorFinding = {
  ruleId: string;
  selector: string;
  status: 'observed' | 'needs-review';
  explanation: string;
  evidence: Record<string, string | number | boolean | null>;
};

export type SemanticCandidate = {
  selector: string;
  role: string;
  name: string;
  context: string;
  kind: 'image' | 'action' | 'form';
};

export type BehaviorAudit = {
  status: 'completed' | 'partial' | 'unavailable';
  tabSequence: string[];
  candidatesChecked: number;
  findings: BehaviorFinding[];
  limitations: string[];
  semanticCandidates: SemanticCandidate[];
};

export type AiAuditFinding = {
  id: string;
  candidate: SemanticCandidate;
  explanation: string;
  decision: 'needs-review' | 'accepted' | 'rejected';
};

export type DetectionEvidence = {
  schemaVersion: 2;
  engine: { name: string; version: string; tags: string[] };
  timing: { rulesMs: number; behaviorMs: number };
  violations: Result[];
  incomplete: Result[];
  bestPractices: { violations: Result[]; incomplete: Result[] };
  behavior: BehaviorAudit;
  ai?: { createdAt: string; findings: AiAuditFinding[] };
};

export type ImagePurpose = 'informative' | 'decorative';
export type RepairSource = { id: string; title: string; refs: string[]; url: string; text: string };
export type VisualMedia = { source: string; format: string; bytes: number };
export type RepairAnalysis = {
  status: 'repair-review';
  suggestedValue: string | null;
  labelDecision?: 'confirm' | 'needs-input';
  linkDecision?: 'confirm' | 'needs-input';
  reason: string;
  description?: string;
  detail?: string;
  media?: VisualMedia;
  sources?: RepairSource[];
  agentTrace?: { tool: string; summary: string }[];
  agentRun?: Pick<import('./source-repair').SourceReview, 'attempts' | 'elapsedMs' | 'usage'>;
};
export type ImageAltAnalysis = {
  status: 'image-analysis' | 'needs-manual-review';
  purpose: ImagePurpose | 'uncertain';
  description: string | null;
  contentAlt: string | null;
  reason: string;
  sources?: RepairSource[];
  detail?: string;
  media?: VisualMedia;
};
export type ImageSemanticReview = { purpose: ImagePurpose; confirmed: true };
