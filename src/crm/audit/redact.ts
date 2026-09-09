/**
 * Redaction for CRM audit payloads.
 *
 * Audit records must never store passwords, hashes, tokens, secrets or raw
 * authentication material. This helper deep-clones a value and replaces any
 * property whose key looks sensitive with the marker string '[REDACTED]'.
 */

const SENSITIVE_KEY =
  /(pass(word)?|pwd|secret|token|authorization|auth[_-]?header|bearer|api[_-]?key|private[_-]?key|hash|salt|encrypted|otp|cvv|card[_-]?number|jwt|cookie|session[_-]?id)/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

export function redactSensitive(value: any, depth = 0): any {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}
