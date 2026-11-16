import { LockMode, raw } from '@mikro-orm/core';
import { AbstractSqlPlatform } from '@mikro-orm/sql';
import { toJs, type Value } from '@ydbjs/value';
import { YdbNativeQueryBuilder, typedValue, type YdbQueryPlatform } from '../src/YdbNativeQueryBuilder.js';

class TestPlatform extends AbstractSqlPlatform implements YdbQueryPlatform {
  override usesReturningStatement(): boolean {
    return true;
  }
  override supportsMultiColumnCountDistinct(): boolean {
    return false;
  }
  getColumnType(_table: string, column: string): string | undefined {
    return (
      {
        id: 'Utf8',
        tenant: 'Utf8',
        code: 'Int32',
        label: 'Utf8',
        score: 'Int32',
        optional: 'Utf8?',
        data: 'JsonDocument?',
        version: 'Int32',
        total: 'Int64',
        created: 'Timestamp',
        bytes: 'String',
      } as Record<string, string>
    )[column];
  }
  getPrimaryKeyColumns(table: string): string[] {
    return table === 'composite' ? ['tenant', 'code'] : ['id'];
  }
}

const platform = new TestPlatform();
const query = () => new YdbNativeQueryBuilder(platform);
const values = (params: unknown[]) =>
  params.map(p => (p != null && typeof (p as Value).encode === 'function' ? toJs(p as Value) : p));

describe('native YQL SQL query builder', () => {
  test('preserves joins, grouping, having, sorting and ordered bound values', () => {
    const compiled = query()
      .from('entry', { alias: 'e' })
      .select([raw('?? as ??', ['e.id', 'id']), raw('COUNT(??) as ??', ['b.id', 'books'])])
      .join('left join `book` as `b` on `b`.`author` = `e`.`id` AND `b`.`active` = ?', [true])
      .where('`e`.`label` != ?', ['private'])
      .groupBy(['e.id'])
      .having('COUNT(`b`.`id`) > ?', [1])
      .orderBy('`e`.`id` asc')
      .limit(5)
      .offset(2)
      .compile();
    expect(compiled.sql).toContain('select `e`.`id` as `id`, COUNT(`b`.`id`) as `books` from `entry` as `e`');
    expect(compiled.sql).toContain('group by `e`.`id` having COUNT(`b`.`id`) > ? order by `id` asc');
    expect(compiled.sql).toContain('limit CAST(? AS Uint64) offset CAST(? AS Uint64)');
    expect(values(compiled.params)).toEqual([true, 'private', 1, 5n, 2n]);
  });

  test('retains parameters inside raw selected expressions and subquery sources', () => {
    const subquery = query().from('entry').select(['id']).where('`score` > ?', [10]).as('s');
    const compiled = query()
      .from(subquery)
      .select([raw('? as ??', ['literal', 'label']), 's.id'])
      .where('`s`.`id` != ?', ['excluded'])
      .compile();
    expect(compiled.sql).toContain('? as `label`');
    expect(compiled.sql).toContain('(select `id` from `entry` where `score` > ?) as `s`');
    expect(values(compiled.params)).toEqual(['literal', 10, 'excluded']);
  });

  test('uses a subquery for multi-column distinct counts', () => {
    const compiled = query().from('entry').count(['id', 'score'], true).where('`score` > ?', [0]).compile();
    expect(compiled.sql).toBe(
      'select count(*) as `count` from ( select distinct `id`, `score` from `entry` where `score` > ? ) as `dcnt`',
    );
    expect(compiled.params).toEqual([0]);
  });

  test('supports offset without limit and rejects invalid pagination', () => {
    expect(query().from('entry').select('*').offset(2).compile().sql).toContain(
      'limit 18446744073709551615ul offset CAST(? AS Uint64)',
    );
    for (const invalid of [-1, 1.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => query().from('entry').select('*').limit(invalid).compile()).toThrow(/non-negative safe integer/);
    }
  });

  test('types insert columns and always returns actual changed rows', () => {
    const compiled = query().into('entry').insert({ id: 'item', score: 3, optional: null, data: '"123"' }).compile();
    expect(compiled.sql).toBe(
      'insert into `entry` (`id`, `score`, `optional`, `data`) values (Unwrap(CAST(? AS Utf8)), Unwrap(CAST(? AS Int32)), CAST(? AS Optional<Utf8>), CAST(? AS Optional<JsonDocument>)) returning *',
    );
    expect(values(compiled.params)).toEqual(['item', 3, null, '123']);
    expect(query().into('entry').insert({ id: 'a', score: 1 }).returning(['id']).compile().sql).toMatch(
      /returning `id`$/,
    );
  });

  test('heterogeneous batch rows preserve typed optional NULL and order', () => {
    const compiled = query()
      .into('entry')
      .insert([{ id: 'a', optional: 'present' }, { id: 'b' }])
      .compile();
    expect(compiled.sql).toContain('), (');
    expect(values(compiled.params)).toEqual(['a', 'present', 'b', null]);
    expect(() =>
      query()
        .into('entry')
        .insert([{ id: 'a', score: 1 }, { id: 'b' }])
        .compile(),
    ).toThrow(/cannot receive null/);
  });

  test('raw data expressions stay parameterized and receive target casts', () => {
    const compiled = query()
      .from('entry')
      .update({ score: raw('?? + ?', ['score', 1]) })
      .where('`id` = ?', ['a'])
      .compile();
    expect(compiled.sql).toBe(
      'update `entry` set `score` = Unwrap(CAST(`score` + ? AS Int32)) where `id` = ? returning *',
    );
    expect(values(compiled.params)).toEqual([1, 'a']);
  });

  test('uses native UPSERT for merging all supplied columns', () => {
    const builder = query().from('entry').insert({ id: 'a', label: 'new', score: 10 });
    builder.onConflict({ fields: ['id'], merge: [] });
    const compiled = builder.compile();
    expect(compiled.sql).toMatch(/^upsert into `entry`/);
    expect(compiled.sql).not.toMatch(/on conflict|join/);
    expect(values(compiled.params)).toEqual(['a', 'new', 10]);
  });

  test('ignores existing primary keys with a native anti-join', () => {
    const builder = query()
      .from('entry')
      .insert([
        { id: 'a', score: 1 },
        { id: 'b', score: 2 },
      ]);
    builder.onConflict({ fields: ['id'], ignore: true });
    const compiled = builder.compile();
    expect(compiled.sql).toContain('left only join `entry` AS `__ydb_existing` on');
    expect(compiled.sql).toContain('`__ydb_incoming`.`id` = `__ydb_existing`.`id`');
    expect(compiled.sql).not.toMatch(/on conflict|do nothing/);
    expect(values(compiled.params)).toEqual(['a', 1, 'b', 2]);
  });

  test('preserves unmerged fields on existing rows and uses insert values for new rows', () => {
    const builder = query().from('entry').insert({ id: 'a', label: 'insert label', score: 10 });
    builder.onConflict({ fields: ['id'], merge: ['score'] });
    const compiled = builder.compile();
    expect(compiled.sql).toContain('THEN `__ydb_incoming`.`label` ELSE `__ydb_existing`.`label` END');
    expect(compiled.sql).not.toContain('THEN `__ydb_incoming`.`score` ELSE `__ydb_existing`.`score`');
    expect(values(compiled.params)).toEqual(['a', 'insert label', 10]);
  });

  test('merge-object parameters precede source parameters in SQL order', () => {
    const builder = query().from('entry').insert({ id: 'a', score: 1 });
    builder.onConflict({ fields: ['id'], merge: { score: 9 } });
    const compiled = builder.compile();
    expect(compiled.sql).toContain('ELSE Unwrap(CAST(? AS Int32)) END');
    expect(values(compiled.params)).toEqual([9, 'a', 1]);
  });

  test('supports composite conflict keys and version increments', () => {
    const builder = query().from('composite').insert({ tenant: 't', code: 1, score: 2, version: 1 });
    builder.onConflict({ fields: ['code', 'tenant'], merge: ['score'], version: { field: 'version' } });
    const compiled = builder.compile();
    expect(compiled.sql).toContain('`__ydb_existing`.`version` + 1');
    expect(compiled.sql).toContain(
      '`__ydb_incoming`.`tenant` = `__ydb_existing`.`tenant` AND `__ydb_incoming`.`code` = `__ydb_existing`.`code`',
    );
  });

  test('rejects non-primary or incomplete conflict targets and conditional clauses', () => {
    const wrong = query().from('entry').insert({ id: 'a', label: 'b' });
    wrong.onConflict({ fields: ['label'], ignore: true });
    expect(() => wrong.compile()).toThrow(/complete primary key/);
    const incomplete = query().from('composite').insert({ tenant: 't', code: 1 });
    incomplete.onConflict({ fields: ['tenant'], merge: [] });
    expect(() => incomplete.compile()).toThrow(/complete primary key/);
    const conditional = query().from('entry').insert({ id: 'a' });
    conditional.onConflict({ fields: ['id'], merge: [], where: { sql: '`score` > ?', params: [2] } });
    expect(() => conditional.compile()).toThrow(/conditional/);
  });

  test('supports insert-select with bound source filters', () => {
    const compiled = query()
      .into('entry')
      .insertSelect(['id', 'score'], raw('select `id`, `score` from `other` where `score` > ?', [1]))
      .compile();
    expect(compiled.sql).toBe(
      'insert into `entry` (`id`, `score`) select `id`, `score` from `other` where `score` > ? returning *',
    );
    expect(compiled.params).toEqual([1]);
  });

  test('compiles CTEs to YQL named subqueries', () => {
    const source = query().from('entry').select('id').where('`score` > ?', [1]);
    const compiled = query().with('active', source).from('active', { alias: 'a' }).select('a.id').compile();
    expect(compiled.sql).toBe(
      '$active = (select `id` from `entry` where `score` > ?); select `a`.`id` as `id` from $active as `a`',
    );
    expect(compiled.params).toEqual([1]);
    expect(() => query().withRecursive('r', source).from('r').select('*').compile()).toThrow(/recursive/);
  });

  test('dependent CTEs reference prior named queries instead of physical tables', () => {
    const first = query().from('entry').select('id');
    const second = query().from('first').select('id');
    const compiled = query().with('first', first).with('second', second).from('second').select('id').compile();
    expect(compiled.sql).toContain('$second = (select `id` from $first);');
    expect(compiled.sql).toMatch(/select `id` from \$second$/);
    const invalid = query().with('second', second).with('first', first).from('second').select('id');
    expect(() => invalid.compile()).toThrow(/before it is defined/);
  });

  test('does not interpret placeholders in SQL strings or comments', () => {
    const compiled = query()
      .from('entry')
      .select(raw("'?' as `literal`, ? as `bound` /* ? */ -- ?\n", ['safe']))
      .compile();
    expect(compiled.sql).toContain("'?' as `literal`, ? as `bound` /* ? */ -- ?\n");
    expect(compiled.params).toEqual(['safe']);
    expect(() =>
      query()
        .from('entry')
        .select(raw('? + ?', [1]))
        .compile(),
    ).toThrow(/no corresponding parameter/);
  });

  test('rejects primary-key mutation, unsupported row locks and distinct-on', () => {
    expect(() => query().from('entry').update({ id: 'other' }).compile()).toThrow(/primary-key/);
    expect(() => query().from('entry').select('*').lockMode(LockMode.PESSIMISTIC_WRITE).compile()).toThrow(
      /pessimistic/,
    );
    expect(() => query().from('entry').select('*').distinctOn(['id']).compile()).toThrow(/DISTINCT ON/);
    expect(query().from('entry').select('*').lockMode(LockMode.OPTIMISTIC).compile().sql).not.toMatch(/for update/);
  });

  test('emulates schema-clear truncation as DELETE with affected-row reporting', () => {
    expect(query().from('entry').truncate().compile()).toEqual({ sql: 'delete from `entry` returning *', params: [] });
  });

  test('preserves bigint, binary, JSON and timestamps and rejects invalid typed values', () => {
    expect(toJs(typedValue('9007199254740993', 'Int64'))).toBe(9007199254740993n);
    expect(toJs(typedValue(new Uint8Array([1, 2]), 'String'))).toEqual(new Uint8Array([1, 2]));
    const date = new Date('2026-01-01T00:00:00Z');
    expect(toJs(typedValue(date, 'Timestamp'))).toEqual(date);
    expect(toJs(typedValue('"123"', 'JsonDocument?'))).toBe('123');
    expect(() => typedValue(2 ** 31, 'Int32')).toThrow(/out of range/);
    expect(() => typedValue(Number.MAX_SAFE_INTEGER + 1, 'Int64')).toThrow(/Invalid/);
    expect(() => typedValue(null, 'Int32')).toThrow(/cannot receive null/);
    expect(() => typedValue('2106-01-01T00:00:00Z', 'Timestamp')).toThrow(/Invalid/);
  });

  test('aliases bare qualified pivot columns and orders by explicit joined projection aliases', () => {
    const compiled = query()
      .from('pivot', { alias: 'p' })
      .select(['p.owner', 'p.target', raw('?? as ??', ['t.label', 't__label'])])
      .join('left join `target` as `t` on `t`.`id` = `p`.`target`', [])
      .orderBy('`t`.`label` asc, `p`.`owner` desc')
      .compile();
    expect(compiled.sql).toContain(
      'select `p`.`owner` as `owner`, `p`.`target` as `target`, `t`.`label` as `t__label`',
    );
    expect(compiled.sql).toContain('order by `t__label` asc, `owner` desc');
  });

  test('rewrites qualified order fields from a root-star projection', () => {
    expect(query().from('entry', { alias: 'e' }).select('e.*').orderBy('`e`.`score` desc').compile().sql).toBe(
      'select `e`.* from `entry` as `e` order by `score` desc',
    );
  });

  test('projects aggregate sort values and removes them from paginated key-subquery results', () => {
    const compiled = query()
      .from('entry', { alias: 'e' })
      .select('e.id')
      .groupBy(['e.id'])
      .orderBy('min(`e`.`score`) desc, min(`e`.`id`) asc')
      .limit(1)
      .compile();
    expect(compiled.sql).toContain('select * without `__ydb_order_0`, `__ydb_order_1` from (');
    expect(compiled.sql).toContain(
      'select `e`.`id` as `id`, min(`e`.`score`) as `__ydb_order_0`, min(`e`.`id`) as `__ydb_order_1`',
    );
    expect(compiled.sql).toContain('order by `__ydb_order_0` desc, `__ydb_order_1` asc limit CAST(? AS Uint64)');
    expect(values(compiled.params)).toEqual([1n]);
  });

  test('does not rewrite qualified-looking text inside ORDER BY string literals', () => {
    const compiled = query()
      .from('entry', { alias: 'e' })
      .select('e.*')
      .orderBy("LENGTH('e.score') asc, LENGTH(`e`.`label`) desc")
      .compile();
    expect(compiled.sql).toContain("order by LENGTH('e.score') asc, LENGTH(`label`) desc");
  });

  test('qualifies existing and excluded columns in raw conflict merge expressions', () => {
    const builder = query().from('entry').insert({ id: 'a', score: 3 });
    builder.onConflict({ fields: ['id'], merge: { score: raw('?? + ? + excluded.score', ['score', 1]) } });
    const compiled = builder.compile();
    expect(compiled.sql).toContain('`__ydb_existing`.`score` + ? + `__ydb_incoming`.`score`');
    expect(values(compiled.params)).toEqual([1, 'a', 3]);
  });
});
