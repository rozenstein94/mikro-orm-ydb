import { Collection, EntitySchema, MikroORM } from '@mikro-orm/core';
import { YdbSqlDriver } from '../src/index.js';

class JoinCompositionOwner {
  id!: string;
  label!: string;
  items = new Collection<JoinCompositionItem>(this);
}

class JoinCompositionItem {
  id!: string;
  owner!: JoinCompositionOwner;
  state!: string;
}

const ownerSchema = new EntitySchema<JoinCompositionOwner>({
  class: JoinCompositionOwner,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    items: { kind: '1:m', entity: () => JoinCompositionItem, mappedBy: 'owner' },
  },
});
const itemSchema = new EntitySchema<JoinCompositionItem>({
  class: JoinCompositionItem,
  properties: {
    id: { type: 'string', primary: true },
    owner: { kind: 'm:1', entity: () => JoinCompositionOwner },
    state: { type: 'string' },
  },
});

describe('filtered ORM JOIN composition compilation', () => {
  let orm: MikroORM<YdbSqlDriver>;

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>({
      driver: YdbSqlDriver,
      entities: [ownerSchema, itemSchema],
      clientUrl: 'grpc://127.0.0.1:2136',
      dbName: '/local',
      allowGlobalContext: true,
      ensureDatabase: false,
    });
  });

  afterAll(async () => {
    await orm.close(true);
  });

  function filtered() {
    return orm.em
      .createQueryBuilder(JoinCompositionOwner, 'owner')
      .select('owner.id')
      .leftJoin('owner.items', 'item', { 'item.state': 'visible' });
  }

  test('keeps standalone filtered queries and their clones independently compilable', () => {
    const inner = filtered();
    const first = inner.toQuery();
    expect(first.sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
    expect(first.sql).toContain('where `item`.`state` = ?');
    expect(first.params).toEqual(['visible']);
    expect(inner.clone().toQuery()).toEqual(first);
    expect(inner.toQuery()).toEqual(first);
  });

  test.each(['where', 'andWhere', 'orWhere'] as const)(
    'rejects a filtered QB embedded by %s before emitting nested YQL declarations',
    method => {
      const inner = filtered();
      const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
      expect(() => outer[method]({ id: { $in: inner } }).toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
      // A rejected composition must not poison the independent builder's compilation cache.
      expect(inner.toQuery().sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
      expect(inner.toQuery().params).toEqual(['visible']);
    },
  );

  test('rejects precompiled filtered subqueries instead of embedding their statement declarations', () => {
    const inner = filtered();
    const standalone = inner.toQuery();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    expect(() => outer.where({ id: { $in: inner } }).toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
    expect(inner.toQuery()).toEqual(standalone);
  });

  test.each(['native', 'raw'] as const)('rejects an eagerly compiled filtered %s CTE source', kind => {
    const inner = filtered();
    const source = kind === 'native' ? inner.getNativeQuery() : inner.toRaw();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    expect(() => outer.with('visible', source).toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
    expect(inner.toQuery().sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
    expect(inner.toQuery().params).toEqual(['visible']);
  });

  test('rejects a filtered raw subquery in WHERE with its structured provenance retained', () => {
    const inner = filtered();
    const source = inner.toRaw();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    expect(() => outer.where({ id: { $in: source } }).toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
    expect(inner.toQuery().params).toEqual(['visible']);
  });

  test('rejects a filtered QB used as a FROM source', () => {
    const inner = filtered();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer');
    expect(() => outer.from(inner, 'derived').select('id').toQuery()).toThrow(
      /YDB filtered ORM subqueries.*standalone/i,
    );
    expect(inner.toQuery().sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
  });

  test.each(['leftJoin', 'innerJoin'] as const)('rejects a filtered QB used as a %s source', method => {
    const inner = filtered();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    expect(() => outer[method](inner, 'derived', { 'derived.id': 'owner-id' }).toQuery()).toThrow(
      /YDB filtered ORM subqueries.*standalone/i,
    );
    expect(inner.toQuery().sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
  });

  test('keeps an ordinary implicit insertFrom projection available for metadata column derivation', () => {
    const source = orm.em.createQueryBuilder(JoinCompositionOwner, 'source').where({ id: 'original' });
    const insert = orm.em.createQueryBuilder(JoinCompositionOwner).insertFrom(source);
    expect(source.state.type).toBeUndefined();
    expect(source.state.fields).toBeUndefined();
    const compiled = insert.toQuery();
    expect(compiled.sql).toContain('insert into `join_composition_owner` (`label`)');
    expect(compiled.sql).toContain('select `source`.`label` as `label`');
    expect(compiled.params).toEqual(['original']);
  });

  test('keeps ordinary insertFrom sources mutable until the outer query compiles', () => {
    const source = orm.em.createQueryBuilder(JoinCompositionOwner, 'source').where({ id: 'original' });
    const insert = orm.em.createQueryBuilder(JoinCompositionOwner).insertFrom(source);
    expect(() => source.andWhere({ id: { $ne: 'excluded' } })).not.toThrow();
    const compiled = insert.toQuery();
    expect(compiled.params).toEqual(['original', 'excluded']);
    expect(compiled.sql).toContain('insert into `join_composition_owner` (`label`)');
  });

  test('rejects a live insertFrom source that gains a filtered JOIN without poisoning its standalone cache', () => {
    const source = orm.em.createQueryBuilder(JoinCompositionOwner, 'owner').select('owner.id');
    const insert = orm.em.createQueryBuilder(JoinCompositionOwner).insertFrom(source);
    source.leftJoin('owner.items', 'item', { 'item.state': 'visible' });
    expect(() => insert.toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
    const standalone = source.toQuery();
    expect(standalone.sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
    expect(standalone.sql).toContain('left join $__ydb_join_filter_0');
    expect(standalone.params).toEqual(['visible']);
    expect(source.toQuery()).toEqual(standalone);
  });

  test('retains ordinary unfiltered ORM subqueries, derived tables and CTEs', () => {
    const plain = () =>
      orm.em.createQueryBuilder(JoinCompositionOwner, 'inner').select('inner.id').where({ id: 'plain' });
    const query = () => orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    const where = query()
      .where({ id: { $in: plain() } })
      .toQuery();
    const from = orm.em.createQueryBuilder(JoinCompositionOwner).from(plain(), 'derived').select('id').toQuery();
    const cte = query().with('plain_source', plain()).toQuery();
    const nativeCte = query().with('plain_native', plain().getNativeQuery()).toQuery();
    const rawCte = query().with('plain_raw', plain().toRaw()).toQuery();
    expect(where.sql).toContain(' in (select ');
    expect(where.params).toEqual(['plain']);
    expect(from.sql).toContain(' from (select ');
    expect(from.params).toEqual(['plain']);
    expect(cte.sql).toMatch(/^\$plain_source = \(select /);
    expect(cte.params).toEqual(['plain']);
    expect(nativeCte.sql).toMatch(/^\$plain_native = \(select /);
    expect(nativeCte.params).toEqual(['plain']);
    expect(rawCte.sql).toMatch(/^\$plain_raw = \(select /);
    expect(rawCte.params).toEqual(['plain']);
  });

  test('rejects a filtered QB as a user CTE before core eagerly converts it to SQL text', () => {
    const inner = filtered();
    const outer = orm.em.createQueryBuilder(JoinCompositionOwner, 'outer').select('outer.id');
    expect(() => outer.with('visible', inner).toQuery()).toThrow(/YDB filtered ORM subqueries.*standalone/i);
    expect(inner.toQuery().sql).toMatch(/^\$__ydb_join_filter_\d+ = \(/);
    expect(inner.toQuery().params).toEqual(['visible']);
  });
});
