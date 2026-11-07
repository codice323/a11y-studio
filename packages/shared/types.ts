import type { Result } from 'axe-core';

export type JobStatus = 'queued'|'running'|'completed'|'failed';
export type Issue = {id:string; ruleId:string; selector:string; impact:string; description:string; help:string; helpUrl:string; html:string; wcag:string[]; bounds:{x:number;y:number;width:number;height:number}|null};
export type Scan = {id:string; projectId:string; snapshotId:string; status:JobStatus; issues:Issue[]; incomplete:{ruleId:string;help:string;count:number}[]; screenshot:string; createdAt:string; error?:string; detection?: DetectionEvidence};
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
