import { raw } from '@mikro-orm/core';
import { YdbNativeQueryBuilder, YdbSqlPlatform } from '../src/index.js';

class OrderingPlatform extends YdbSqlPlatform {
  override getColumnType(_table: string, column: string): string | undefined {
    return ({ id: 'Utf8', title: 'Utf8', amount: 'Decimal(35,9)' } as Record<string, string>)[column];
  }
}

const query = () => new YdbNativeQueryBuilder(new OrderingPlatform()).from('order_entry');

describe('ordered projection wrapper', () => {
  test('repeats the complete order outside projection removal and qualifies hidden source values', () => {
    const compiled = query().select('id').orderBy('`title` asc, `id` desc').limit(3).offset(2).compile();
    expect(compiled.sql).toContain(
      'order by `__ydb_order_0` asc, `id` desc limit CAST(? AS Uint64) offset CAST(? AS Uint64)',
    );
    expect(compiled.sql).toMatch(/\) as `__ydb_ordered` order by `__ydb_ordered`\.`__ydb_order_0` asc, `id` desc$/);
    expect(compiled.params).toHaveLength(2);
  });

  test('keeps user-selected synthetic-looking aliases while removing only newly introduced columns', () => {
    const compiled = query()
      .select(raw('?? as ??', ['id', '__ydb_order_0']))
      .orderBy('`amount` desc, `id` asc')
      .compile();
    expect(compiled.sql).toContain('select * without `__ydb_order_1` from (');
    expect(compiled.sql).toContain('`id` as `__ydb_order_0`, `amount` as `__ydb_order_1`');
    expect(compiled.sql).toMatch(/order by `__ydb_ordered`\.`__ydb_order_1` desc, `__ydb_order_0` asc$/);
  });

  test('leaves literal text and selected sort expressions unchanged in the outer ordering', () => {
    const compiled = query().select('id').orderBy("LENGTH('__ydb_order_0') asc, `title` asc, `id` desc").compile();
    expect(compiled.sql).toMatch(
      /order by LENGTH\('__ydb_order_0'\) asc, `__ydb_ordered`\.`__ydb_order_0` asc, `id` desc$/,
    );
  });

  test('retains exact Decimal and aggregate sort values without coercing them to Double', () => {
    const compiled = query().select('id').groupBy(['id']).orderBy('min(`amount`) desc, `id` asc').compile();
    expect(compiled.sql).toContain('min(`amount`) as `__ydb_order_0`');
    expect(compiled.sql).toMatch(/order by `__ydb_ordered`\.`__ydb_order_0` desc, `id` asc$/);
    expect(compiled.sql).not.toMatch(/\b(?:cast|double|float)\b/i);
  });

  test('preserves selected leading keys, selected expressions, and explicit null modifiers', () => {
    const compiled = query().select('id').orderBy('`id` desc, `title` desc nulls first, LENGTH(`id`) asc').compile();
    expect(compiled.sql).toMatch(
      /order by `id` desc, `__ydb_ordered`\.`__ydb_order_0` desc nulls first, LENGTH\(`id`\) asc$/,
    );
  });

  test('rewrites selected qualified fields inside functions and casts before ordering the wrapper', () => {
    const compiled = query()
      .from('order_entry', { alias: 'source' })
      .select(['source.id', 'source.title'])
      .orderBy('LENGTH(`source`.`title`) desc, CAST(`source`.`id` AS Utf8) asc, `source`.`amount` desc nulls last')
      .compile();
    expect(compiled.sql).toMatch(
      /order by LENGTH\(`title`\) desc, CAST\(`id` AS Utf8\) asc, `__ydb_ordered`\.`__ydb_order_0` desc nulls last$/,
    );
  });

  test('orders by a selected expression alias and an unselected value without leaking its inner source alias', () => {
    const compiled = query()
      .from('order_entry', { alias: 'source' })
      .select(['source.id', raw('LENGTH(??) as ??', ['source.title', 'title_length'])])
      .orderBy('LENGTH(`source`.`title`) desc, `source`.`amount` asc')
      .compile();
    expect(compiled.sql).toMatch(/order by `title_length` desc, `__ydb_ordered`\.`__ydb_order_0` asc$/);
  });
});
