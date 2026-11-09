export type JobType = 'audit' | 'source-repair' | 'verification' | 'panorama';

export class JobRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobRecoveryError';
  }
}

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;

export async function startJob(url: string, type: JobType, data: unknown, signal: AbortSignal) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  }).catch(() => {
    signal.throwIfAborted();
    throw new JobRecoveryError('未收到任务创建结果。请重新同步项目后重试。');
  });
  const job = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) throw new Error(job?.error ?? `无法启动任务（HTTP ${response.status}）。`);
  if (response.status !== 202 || job?.kind !== 'job' || job.status !== 'queued' ||
      job.type !== type || typeof job.id !== 'string' || !uuid.test(job.id)) {
    throw new JobRecoveryError('前后端的任务协议不一致，未开始等待任务。请同步或重启后端服务后重试。');
  }
  return job.id as string;
}

export async function waitJob<T>(id: string, type: JobType, signal: AbortSignal, onProgress?: (message: string) => void): Promise<T> {
  const deadline = Date.now() + 180_000;
  let connectionFailures = 0;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const response = await fetch('/api/jobs/' + encodeURIComponent(id), { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), cache: 'no-store' })
      .catch(error => {
        signal.throwIfAborted();
        if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === 'TimeoutError')) throw error;
        return null;
      });
    if (!response || [502, 503, 504].includes(response.status)) {
      if (++connectionFailures >= 4) throw new JobRecoveryError('暂时无法联系后端。请重新同步项目后确认任务结果。');
    } else {
      connectionFailures = 0;
      if (response.status === 404) throw new JobRecoveryError('此任务已失效，等待已停止。请重试或重新同步项目。');
      if (!response.ok) throw new JobRecoveryError(`无法查询任务状态（HTTP ${response.status}）。`);
      const job = await response.json().catch(() => null);
      signal.throwIfAborted();
      if (job?.id !== id || job?.type !== type) throw new JobRecoveryError('任务响应与当前操作不匹配。请重新同步项目。');
      if (job.status === 'completed' && job.result != null) return job.result as T;
      if (job.status === 'running' && typeof job.result?.progress === 'string') onProgress?.(job.result.progress);
      if (job.status === 'cancelled') throw new Error('任务已取消。');
      if (job.status === 'failed') {
        if (job.code === 'JOB_INTERRUPTED') throw new JobRecoveryError('后端已重启，此任务已中断。请重试或重新同步项目。');
        throw new Error(job.error ?? '任务失败。');
      }
      if (job.status !== 'queued' && job.status !== 'running') throw new JobRecoveryError('任务状态无效，请重新同步项目。');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 500);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw new JobRecoveryError('任务仍在运行，已停止等待。请重新同步项目确认结果。');
}
