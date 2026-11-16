import { describe, expect, it } from 'vitest';
import { toJs } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import { Int32, Utf8Type } from '@ydbjs/value/primitive';
import { compileYdbBindings } from '../src/YdbBindings.js';

describe('SQL YDB parameter binding', () => {
  it('chooses a free parameter name when SQL contains the generated name', () => {
    const q = compileYdbBindings("select '$p0', ?", ['bound']);
    expect(q.sql).toBe("select '$p0', $p1");
    expect(toJs(q.parameters.$p1)).toBe('bound');
  });
  it('preserves placeholders inside strings, quoted identifiers and comments', () => {
    const q = compileYdbBindings('select \'?\' as `?`, "?", ? -- ?\n/* ? */ where ?? = ?', [
      'secret',
      't.id',
      new Int32(1),
    ]);
    expect(q.sql).toBe('select \'?\' as `?`, "?", $p0 -- ?\n/* ? */ where `t`.`id` = $p1');
    expect(toJs(q.parameters.$p0)).toBe('secret');
    expect(toJs(q.parameters.$p1)).toBe(1);
  });
  it('fails for missing and surplus bindings and undefined', () => {
    expect(() => compileYdbBindings('select ?', [])).toThrow('more placeholders');
    expect(() => compileYdbBindings('select 1', [1])).toThrow('fewer placeholders');
    expect(() => compileYdbBindings('select ?', [null])).toThrow('explicitly typed');
    expect(() => compileYdbBindings('select ?', [undefined])).toThrow('undefined');
  });
  it('preserves wide integers and rejects ambiguous precision', () => {
    const q = compileYdbBindings('select ?, ?', [2147483648, 9007199254740991n]);
    expect(toJs(q.parameters.$p0)).toBe(2147483648n);
    expect(toJs(q.parameters.$p1)).toBe(9007199254740991n);
    expect(() => compileYdbBindings('select ?', [Number.MAX_SAFE_INTEGER + 1])).toThrow('safe numbers');
    expect(() => compileYdbBindings('select ?', [1n << 63n])).toThrow('Int64 range');
  });
  it('retains typed null, binary and Date values', () => {
    const date = new Date('2026-01-01T00:00:00.123Z');
    const q = compileYdbBindings('select ?, ?, ?', [new Optional(null, new Utf8Type()), new Uint8Array([1, 2]), date]);
    expect(toJs(q.parameters.$p0)).toBeNull();
    expect(toJs(q.parameters.$p1)).toEqual(new Uint8Array([1, 2]));
    expect(toJs(q.parameters.$p2)).toEqual(date);
  });
});
