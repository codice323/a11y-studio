import type { Bounds } from './types';

export type Semantics = {
  role: string | null;
  name: string;
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
