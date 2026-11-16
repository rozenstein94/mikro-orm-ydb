import { fromJs, type JSValue, type Value } from '@ydbjs/value';
import { Int64, Timestamp } from '@ydbjs/value/primitive';

/** Replace positional placeholders without touching quoted text, identifiers or comments. */
export function compileYdbBindings(
  sql: string,
  params: readonly unknown[],
): {
  sql: string;
  parameters: Record<string, Value>;
} {
  const parameters: Record<string, Value> = {};
  let index = 0;
  let text = '';
  let mode: 'normal' | 'single' | 'double' | 'identifier' | 'line' | 'block' = 'normal';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];
    if (mode === 'line') {
      text += c;
      if (c === '\n') mode = 'normal';
    } else if (mode === 'block') {
      text += c;
      if (c === '*' && next === '/') {
        text += next;
        i++;
        mode = 'normal';
      }
    } else if (mode !== 'normal') {
      text += c;
      const quote = mode === 'single' ? "'" : mode === 'double' ? '"' : '`';
      if (c === '\\' && next) {
        text += next;
        i++;
      } else if (c === quote && next === quote) {
        text += next;
        i++;
      } else if (c === quote) mode = 'normal';
    } else if (c === '-' && next === '-') {
      text += c + next;
      i++;
      mode = 'line';
    } else if (c === '/' && next === '*') {
      text += c + next;
      i++;
      mode = 'block';
    } else if (c === "'" || c === '"' || c === '`') {
      text += c;
      mode = c === "'" ? 'single' : c === '"' ? 'double' : 'identifier';
    } else if (c === '\\' && next === '?') {
      text += next;
      i++;
    } else if (c === '?') {
      if (index >= params.length) throw new Error('YDB query has more placeholders than parameters.');
      const value = params[index++];
      if (next === '?') {
        if (typeof value !== 'string') throw new Error('YDB identifier parameters must be strings.');
        text += value
          .split('.')
          .map(p => (p === '*' ? '*' : '`' + p.replaceAll('`', '``') + '`'))
          .join('.');
        i++;
      } else {
        if (value === null) throw new Error('YDB raw null parameters require an explicitly typed Optional value.');
        if (value === undefined) throw new Error('YDB cannot bind undefined; use a typed Optional for SQL NULL.');
        if (typeof value === 'number' && !Number.isFinite(value))
          throw new Error('YDB cannot bind non-finite numbers.');
        let ordinal = Object.keys(parameters).length;
        let name = `$p${ordinal}`;
        while (Object.hasOwn(parameters, name) || sql.includes(name)) name = `$p${++ordinal}`;
        parameters[name] = parameterValue(value);
        text += name;
      }
    } else text += c;
  }
  if (index !== params.length) throw new Error('YDB query has fewer placeholders than parameters.');
  return { sql: text, parameters };
}

function isYdbValue(value: unknown): value is Value {
  return (
    value != null &&
    typeof value === 'object' &&
    'type' in value &&
    'encode' in value &&
    typeof value.encode === 'function'
  );
}

function parameterValue(value: unknown): Value {
  if (isYdbValue(value)) return value;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()) || value.getTime() < 0 || value.getTime() >= Date.UTC(2106, 0, 1))
      throw new Error('Invalid YDB Timestamp parameter.');
    return new Timestamp(value);
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value))
      throw new Error('YDB integer parameters must be safe numbers or explicit bigint values.');
    if (value < -2147483648 || value > 2147483647) return new Int64(BigInt(value));
  }
  if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value >= 1n << 63n) throw new Error('YDB bigint parameter is outside the Int64 range.');
    return new Int64(value);
  }
  if (typeof value === 'object' && !(value instanceof Uint8Array))
    throw new Error('YDB structured parameters require an explicit typed SDK Value.');
  return fromJs(value as JSValue);
}
