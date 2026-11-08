// Benchmark-only instrumentation. Keep model requests unchanged. Do not log request
// bodies, model outputs, endpoints with credentials, or authorization headers.
import { appendFileSync } from 'node:fs';

const output = process.env.A11Y_BENCH_USAGE_FILE;
const nativeFetch = globalThis.fetch;
if (output) globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init);
  if (typeof input === 'string' && new URL(input).pathname.endsWith('/chat/completions')) {
    const parsed = response.ok ? await response.clone().json().catch(() => null) : null;
    const requested = typeof init?.body === 'string' ? JSON.parse(init.body).model : null;
    appendFileSync(output, JSON.stringify({
      time: new Date().toISOString(), status: response.status, model: requested ?? parsed?.model ?? null,
      official: new URL(input).hostname === 'api.deepseek.com', usage: parsed?.usage ?? null,
    }) + '\n');
  }
  return response;
};
