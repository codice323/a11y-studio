import type { PanoramaIssue } from './panorama';

export type PageDiagnostics = {
  path: string;
  title: string;
  entry?: boolean;
  findings: PageFinding[];
  coverage?: PageDiagnosticCoverage;
};

type PageFinding = PanoramaIssue & { locationGroup?: string };

export type PageDiagnosticCoverage = {
  review: DiagnosticRuleSummary[];
  bestPractices: DiagnosticRuleSummary[];
  stillLoading?: boolean;
};

type DiagnosticRuleSummary = {
  id: string;
  help: string;
  count: number;
};

export type PageTarget = {
  id: string;
  path: string;
  selector: string;
  selectors?: string[];
};

export type WorkspacePageDiagnostics = {
  projectId?: string;
  version?: string;
  kind: 'live' | 'remote';
  path: string;
  title?: string;
  entry?: boolean;
  status: 'pending' | 'ready' | 'failed';
  findings?: PageFinding[];
  coverage?: PageDiagnosticCoverage;
  error?: string;
};
