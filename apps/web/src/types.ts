import type { DetectionEvidence } from '../../../packages/shared/types';

export type Bounds = { x: number; y: number; width: number; height: number };

export type Issue = {
  id: string;
  ruleId: string;
  selector: string;
  impact: string;
  help: string;
  description: string;
  html: string;
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
  screenshot: string;
  size: { width: number; height: number };
};

export type Snapshot = { id: string; parent_id: string | null; description: string; created_at: string };

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
  structurePassed?: boolean;
  functionPassed?: boolean;
  contrastCheck?: { ratio: number; required: number; valid: boolean; uncertain: boolean } | null;
  diff?: string;
  patch?: { issueId: string; selector: string; targetFile: string };
  proposalReason?: string;
  wcag?: string[];
  wcagUrl?: string;
};

export type State = {
  project: { id: string; name: string; entry: string; currentSnapshot: string };
  snapshots: Snapshot[];
  baseline: Scan | null;
  current: Scan | null;
  summary: { initial: number | null; resolved: number; remaining: number; added: number };
  verifications: Verification[];
};

export type Proposal = {
  id: string;
  source: string;
  reason: string;
  guidance: string;
  wcag: string[];
  wcagTitle: string;
  wcagUrl: string;
  risk: string;
  before: string;
  after: string;
  patch: { operation: string; value: string; targetFile: string; selector: string };
};

export type HistoryItem = { issue: Issue; verification: Verification };

export function versionLabel(state: State, id: string) {
  const index = state.snapshots.findIndex(snapshot => snapshot.id === id);
  return index < 0 ? '候选版本' : `V${index}`;
}
