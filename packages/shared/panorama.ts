export type Control = { role: 'button' | 'link' | 'tab' | 'textbox' | 'combobox'; name: string };
export type PanoramaStep =
  | { action: 'click' | 'validate' | 'fill'; target: Control }
  | { action: 'tab' | 'shift-tab' | 'escape' }
  | { action: 'scroll'; y: number };

export type PanoramaIssue = {
  id: string; ruleId: string; selector: string; help: string; description: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  source?: {file: string; line: number; tag: string; key?: string};
};

export type PanoramaCapture = {
  id: string; path: string; title: string; ax: string; dom: string; focus: string;
  width: number; height: number; scrollY: number; issues: PanoramaIssue[]; manual: number;
  controls: Control[]; keyboard: {status: string; tabSequence: string[]; findings: {ruleId: string; selector: string; explanation: string}[]};
  style: string; layout: string;
};

export type PanoramaRecipe = {
  id: string; start: string; path: string; label: string;
  steps: PanoramaStep[]; counts: Record<string, number>;
};

export type PanoramaSide =
  | { status: 'captured'; capture: PanoramaCapture }
  | { status: 'unmatched'; error: string; step?: number };

export type PanoramaComparison = {
  stateId: string | null; left: PanoramaSide; right: PanoramaSide;
};
