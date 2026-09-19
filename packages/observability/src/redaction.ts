const redacted = '[REDACTED]';
const sensitiveKey = /secret|token|authorization|cookie|content|body|email|phone|destination/i;

export function redact(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (current === null || typeof current !== 'object') return current;
    const previous = seen.get(current);
    if (previous !== undefined) return previous;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      result.push(...current.map(visit));
      return result;
    }
    if (current instanceof Date) return current.toISOString();
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) result[key] = sensitiveKey.test(key) ? redacted : visit(item);
    return result;
  };
  return visit(value);
}
