import type { DetectionEvidence, RepairAnalysis, ImagePurpose, ImageSemanticReview } from '../../../packages/shared/types';

import type { PatchFile } from './patch-diff';
import type { ContrastEvidence } from './semantics';
import type { SourceReview } from '../../../packages/shared/source-repair';

export type Bounds = { x: number; y: number; width: number; height: number };

export type Issue = {
  source?: {file:string;line:number;tag:string};
  id: string;
  ruleId: string;
  selector: string;
  impact: string;
  help: string;
  description: string;
  html: string;
  textPreview?: string;
  helpUrl: string;
  wcag?: string[];
  bounds: Bounds | null;
};

export type Scan = {
  id: string;
  snapshotId: string;
  issues: Issue[];
  incomplete: { ruleId: string; help: string; count: number }[];
  detection?: DetectionEvidence;
  reviewSourceCandidates?: Record<string,{file:string;line:number;tag:string;reason:string}[]>;
  sourceLocations?: Record<string, NonNullable<Issue['source']>>;
  resourceFailures?: {type:string;path:string;reason:string;status?:number}[];
  screenshot: string;
  size: { width: number; height: number };
};

export type Snapshot = { id: string; parent_id: string | null; description: string; name: string; created_at: string };

type ContrastTarget = { issueId: string; selector: string; value: string };

export type Verification = {
  id: string;
  status: string;
  reason: string;
  resolved: Issue[];
  remaining: Issue[];
  added: Issue[];
  createdAt: string;
  beforeHash: string;
  afterHash: string;
  fromSnapshot: string;
  toSnapshot: string;
  baselineAudit?: string;
  audit?: string | null;
  targetFixed?: boolean;
  reviewedTarget?: Issue;
  panoramaState?: string;
  sourceTarget?: string;
  sourceReview?: SourceReview;
  reviewFiles?: PatchFile[];
  sourceChecks?: SourceReview['checks'] | null;
  pendingChecks?: string[];
  imageReview?: ImageSemanticReview;
  structurePassed?: boolean;
  functionPassed?: boolean;
  contrastBefore?: ContrastEvidence | null;
  contrastCheck?: ContrastEvidence | null;
  additionalContrast?: ContrastEvidence[];
  diff?: string;
  patch?: { issueId: string; selector: string; targetFile: string; contrastTargets?: ContrastTarget[] };
  proposalReason?: string;
  wcag?: string[];
  wcagUrl?: string;
  agentTrace?: { tool: string; summary: string }[];
  sources?: { id: string; title: string; refs: string[]; url: string; text: string }[];
};

export type State = {
  project: { id: string; name: string; entry: string; mode?: 'snapshot' | 'static-source' | 'react-source'; currentSnapshot: string };
  snapshots: Snapshot[];
  originalSnapshotId: string | null;
  baseline: Scan | null;
  current: Scan | null;
  inheritedIssues?: Issue[] | null;
  browserCapture?: {title:string;capturedAt:string;viewport:{width:number;height:number};screenshot:string;
    screenshotFullPage?:boolean;dynamicReplay?:boolean;screenshotSize?:{width:number;height:number};
    violations:{id:string;help:string;impact:string|null;count:number}[];incomplete:number;limitations:string[]} | null;
  summary: { initial: number | null; resolved: number; remaining: number; added: number };
  resolved: { issue: Issue; verificationId: string }[];
  verifications: Verification[];
};

export type Proposal = {
  id: string;
  source: string;
  analysis?: RepairAnalysis;
  imagePurpose?: ImagePurpose;
  sourceReview?: SourceReview;
  reason: string;
  guidance: string;
  wcag: string[];
  wcagTitle: string;
  wcagUrl: string;
  risk: string;
  before: string;
  after: string;
  patch: { operation: string; value: string; targetFile: string; selector: string; contrastTargets?: ContrastTarget[] };
  agentTrace?: { tool: string; summary: string }[];
  sources?: { id: string; title: string; refs: string[]; url: string; text: string }[];
};

export type HistoryItem = { issue: Issue; verification: Verification; semantics?: import("./EvidenceDetails").SemanticResult };
