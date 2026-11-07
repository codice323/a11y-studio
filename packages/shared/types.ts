export type JobStatus = 'queued'|'running'|'completed'|'failed';
export type Issue = {id:string; ruleId:string; selector:string; impact:string; description:string; help:string; helpUrl:string; html:string; wcag:string[]; bounds:{x:number;y:number;width:number;height:number}|null};
export type Scan = {id:string; projectId:string; snapshotId:string; status:JobStatus; issues:Issue[]; incomplete:{ruleId:string;help:string;count:number}[]; screenshot:string; createdAt:string; error?:string};
export type Patch = {issueId:string; ruleId:string; targetFile:string; selector:string; fileHash:string; operation:'set-alt'|'set-label'|'set-name'|'set-color'; value:string};
export type Proposal = {id:string; issueId:string; projectId:string; snapshotId:string; patch:Patch; reason:string; impact:string; wcag:string[]; risk:string; source:'ai'|'manual'; before:string; after:string; status:string};
