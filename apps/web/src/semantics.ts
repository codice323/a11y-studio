import type { Bounds } from './types';

export type ContrastEvidence = { ratio: number; required: number; valid: boolean; uncertain: boolean; foreground?: string };
export type PreviewSide = { semantics: Semantics; screenshot: string | null; contrast: ContrastEvidence | null };
export type ProposalPreview = { proposalId: string; before: PreviewSide; after: PreviewSide };
export type Semantics = {
  role: string | null;
  name: string;
  description?: string;
  ignored: boolean;
  ignoredReasons: string[];
  focusable: boolean;
  states: [string, string][];
  bounds: Bounds | null;
  size: { width: number; height: number };
};

export async function inspectAudit(projectId: string, auditId: string, selector: string, signal: AbortSignal) {
  const response = await fetch(
    `/api/projects/${projectId}/audits/${auditId}/semantics?${new URLSearchParams({ selector })}`,
    { signal },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '无法读取浏览器语义证据。');
  return data as Semantics;
}

export async function inspectProposal(id: string, signal: AbortSignal) {
  const response = await fetch(`/api/proposals/${encodeURIComponent(id)}/preview`, { signal });
  const data = await response.json();
  if (!response.ok || data.proposalId !== id) throw new Error(data.error ?? '无法读取待应用补丁证据。');
  return data as ProposalPreview;
}
