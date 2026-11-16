import { EntitySchema, MikroORM, PrimaryKeyProp, raw } from '@mikro-orm/core';
import { toJs } from '@ydbjs/value';
import { YdbDriver } from '../src/index.js';
import { YqlQuery } from '../src/YqlQuery.js';

class QueryEntity {
  id!: string;
  label!: string;
  rank!: number;
  total!: bigint;
  optional?: string | null;
  createdAt!: Date;
}

class CompositeQueryEntity {
  tenant!: string;
  code!: number;
  [PrimaryKeyProp]?: ['tenant', 'code'];
}

const schema = new EntitySchema<QueryEntity>({
  class: QueryEntity,
  tableName: 'query_entity',
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string', fieldName: 'display_label' },
    rank: { type: 'integer' },
    total: { type: 'bigint' },
    optional: { type: 'string', nullable: true },
    createdAt: { type: 'Date' },
  },
});

const compositeSchema = new EntitySchema<CompositeQueryEntity>({
  class: CompositeQueryEntity,
  properties: {
    tenant: { type: 'string', primary: true },
    code: { type: 'integer', primary: true, autoincrement: false },
  },
});

describe('YQL parameter and query boundaries', () => {
  let orm: MikroORM<YdbDriver>;
  const query = () => new YqlQuery(orm.getMetadata(QueryEntity), orm.driver.getPlatform());

  beforeAll(async () => {
    orm = await MikroORM.init<YdbDriver>({
      driver: YdbDriver,
      entities: [schema, compositeSchema],
      clientUrl: 'grpc://localhost:2136',
      dbName: '/local',
    });
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  test('renames fields and keeps every data value in named parameters', () => {
    const compiler = query();
    const value = "danger'`; DROP TABLE query_entity; --";
    const sql = compiler.where({ label: value, rank: { $gte: 2 } });
    expect(sql).toContain('`display_label` = $p0');
    expect(sql).toContain('`rank` >= $p1');
    expect(sql).not.toContain(value);
    expect(toJs(compiler.parameters.$p0)).toBe(value);
    expect(toJs(compiler.parameters.$p1)).toBe(2);
  });

  test('preserves full signed 64-bit integers and rejects overflow or unsafe number inputs', () => {
    const compiler = query();
    compiler.where({ total: 9_007_199_254_740_993n });
    expect(toJs(compiler.parameters.$p0)).toBe(9_007_199_254_740_993n);
    expect(() => query().where({ total: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/Invalid YDB Int64/);
    expect(() => query().where({ total: 1n << 63n })).toThrow(/Invalid YDB Int64/);
    expect(() => query().where({ total: -(1n << 63n) - 1n })).toThrow(/Invalid YDB Int64/);
  });

  test('rejects invalid scalar values and out-of-range timestamps before any network call', () => {
    expect(() => query().where({ rank: 1.5 })).toThrow(/Invalid YDB Int32/);
    expect(() => query().where({ rank: 2 ** 31 })).toThrow(/Invalid YDB Int32/);
    expect(() => query().where({ createdAt: new Date('invalid') })).toThrow(/Invalid YDB Timestamp/);
    expect(() => query().where({ createdAt: new Date('1969-12-31T23:59:59Z') })).toThrow(/Invalid YDB Timestamp/);
    expect(() => query().where({ createdAt: new Date('2200-01-01T00:00:00Z') })).toThrow(/Invalid YDB Timestamp/);
    expect(() => query().data({ label: null })).toThrow(/not nullable/);
  });

  test('makes empty boolean groups and membership lists deterministic', () => {
    expect(query().where({ $and: [] })).toBe('TRUE');
    expect(query().where({ $or: [] })).toBe('FALSE');
    expect(query().where({ rank: { $in: [] } })).toBe('(FALSE)');
    expect(query().where({ rank: { $nin: [] } })).toBe('(TRUE)');
    expect(query().where({ optional: null })).toBe('`optional` IS NULL');
    expect(query().where({ optional: { $ne: null } })).toBe('(`optional` IS NOT NULL)');
  });

  test('rejects unsupported operators, raw SQL and unregistered identifiers', () => {
    expect(() => query().where({ unknown: 'value' })).toThrow(/stored scalar/);
    expect(() => query().where({ 'label.nested': 'value' })).toThrow(/stored scalar/);
    expect(() => query().where({ rank: { $regex: '.*' } })).toThrow(/filter operator/);
    expect(() => query().where({ label: raw('CURRENT_USER') })).toThrow(/SQL expressions/);
    expect(() => query().where({ optional: { $in: ['value', null] } })).toThrow(/ambiguous/);
    expect(() => query().where({ rank: { $like: '%' } })).toThrow(/text property/);
  });

  test('rejects SQL ordering expressions and unsafe pagination values', () => {
    expect(query().orderBy({ rank: 'desc' })).toBe(' ORDER BY `rank` DESC');
    expect(query().orderBy([{ label: 1 }, { rank: -1 }])).toBe(' ORDER BY `display_label` ASC, `rank` DESC');
    expect(() => query().orderBy({ rank: 'DESC; DROP TABLE query_entity' })).toThrow(/ASC or DESC/);
    expect(() => query().orderBy({ rank: 'asc nulls last' })).toThrow(/ASC or DESC/);
    expect(() => query().pagination(-1)).toThrow(/non-negative safe integers/);
    expect(() => query().pagination(1, 0.5)).toThrow(/non-negative safe integers/);
    expect(() => query().pagination(Number.MAX_SAFE_INTEGER + 1)).toThrow(/non-negative safe integers/);
    expect(query().pagination(2, 3)).toBe(' LIMIT 2 OFFSET 3');
  });

  test('accepts the single-tuple and multi-tuple composite filters normalized by EntityManager', () => {
    const compiler = () => new YqlQuery(orm.getMetadata(CompositeQueryEntity), orm.driver.getPlatform());
    const single = compiler();
    const singleSql = single.where({ 'tenant~~~code': { $in: ['a', 1] } });
    expect(singleSql).toContain('`tenant` = $p0');
    expect(singleSql).toContain('`code` = $p1');
    expect(Object.values(single.parameters).map(toJs)).toEqual(['a', 1]);

    const multiple = compiler();
    const multipleSql = multiple.where({
      'tenant~~~code': {
        $in: [
          ['a', 1],
          ['b', 2],
        ],
      },
    });
    expect(multipleSql).toContain(' OR ');
    expect(Object.values(multiple.parameters).map(toJs)).toEqual(['a', 1, 'b', 2]);
    expect(() => compiler().where({ 'tenant~~~code': { $in: ['a'] } })).toThrow(/composite key tuple/i);
  });
});
