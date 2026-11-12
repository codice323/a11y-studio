/** Reduce common secrets and personal identifiers in text sent to model providers.
 * This is a best-effort filter; image pixels and arbitrary sensitive text are not covered. */
export function redactModelText(value: string): string {
  return value
    .replace(/<input\b[^>]*>/gi, tag => /\btype\s*=\s*["']?password\b/i.test(tag)
      ? tag.replace(/(\bvalue\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1"[已遮蔽凭据]"') : tag)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[已遮蔽密钥]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[已遮蔽邮箱]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[已遮蔽手机号]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已遮蔽凭据]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*["']?)([^\s"'<>;,}]+)/gi, '$1[已遮蔽凭据]');
}

export function redactForModel(value: unknown): unknown {
  if (typeof value === 'string') return redactModelText(value);
  if (Array.isArray(value)) return value.map(redactForModel);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, /^(password|passwd|api[_-]?key|access[_-]?token|authorization)$/i.test(key)
      ? '[已遮蔽凭据]' : redactForModel(item)]),
  );
  return value;
}

export function containsRedaction(value: unknown): boolean {
  return JSON.stringify(value)?.includes('[已遮蔽') ?? false;
}
