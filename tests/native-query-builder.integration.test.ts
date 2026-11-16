import { EntitySchema, MikroORM, raw } from '@mikro-orm/core';
import { AbstractSqlPlatform } from '@mikro-orm/sql';
import { YdbDriver } from '../src/YdbDriver.js';
import { compileYdbBindings } from '../src/YdbBindings.js';
import { YdbNativeQueryBuilder } from '../src/YdbNativeQueryBuilder.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const table = `native_builder_${process.pid}_${Date.now().toString(36)}`;
class TestPlatform extends AbstractSqlPlatform {
  override usesReturningStatement(): boolean {
    return true;
  }
  getColumnType(_table: string, column: string): string | undefined {
    return (
      { id: 'Utf8', label: 'Utf8', score: 'Int32', optional: 'Utf8?', version: 'Int32' } as Record<string, string>
    )[column];
  }
  getPrimaryKeyColumns(): string[] {
    return ['id'];
  }
}
const platform = new TestPlatform();
const qb = () => new YdbNativeQueryBuilder(platform).from(table);

describe.skipIf(!enabled)('native SQL builder against YDB', () => {
  let orm: MikroORM<YdbDriver>;
  const execute = async (builder: YdbNativeQueryBuilder) => {
    const query = builder.compile();
    const bound = compileYdbBindings(query.sql, query.params);
    return orm.driver.getConnection().query(bound.sql, bound.parameters);
  };
  beforeAll(async () => {
    orm = await MikroORM.init<YdbDriver>({
      driver: YdbDriver,
      entities: [
        new EntitySchema({
          name: 'NativeBuilderEntity',
          tableName: table,
          properties: {
            id: { type: 'string', primary: true },
            label: { type: 'string' },
            score: { type: 'integer' },
            optional: { type: 'string', nullable: true },
            version: { type: 'integer' },
          },
        }),
      ],
      dbName: process.env.YDB_DATABASE ?? '/local',
      clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    });
    await orm.schema.create();
  });
  beforeEach(async () => {
    await orm.driver.getConnection().query(`DELETE FROM \`${table}\``);
  });
  afterAll(async () => {
    try {
      await orm?.schema.drop();
    } finally {
      await orm?.close(true);
    }
  });

  test('INSERT/UPDATE/DELETE returning rows and typed optional parameters', async () => {
    const rows = await execute(qb().insert({ id: 'one', label: 'first', score: 1, optional: null, version: 1 }));
    expect(rows).toMatchObject([{ id: 'one', score: 1, optional: null }]);
    expect(await execute(qb().update({ score: 4 }).where('`id` = ?', ['one']))).toMatchObject([
      { id: 'one', score: 4 },
    ]);
    expect(await execute(qb().delete().where('`id` = ?', ['one']))).toMatchObject([{ id: 'one', score: 4 }]);
  });

  test('UPSERT merges selected fields while preserving unmerged existing values', async () => {
    await execute(qb().insert({ id: 'one', label: 'keep', score: 1, optional: null, version: 1 }));
    const upsert = qb().insert([
      { id: 'one', label: 'discard', score: 2, optional: null, version: 1 },
      { id: 'two', label: 'new', score: 3, optional: null, version: 1 },
    ]);
    upsert.onConflict({ fields: ['id'], merge: ['score'] });
    await execute(upsert);
    expect(await execute(qb().select(['id', 'label', 'score']).orderBy('`id` asc'))).toEqual([
      { id: 'one', label: 'keep', score: 2 },
      { id: 'two', label: 'new', score: 3 },
    ]);
  });

  test('IGNORE skips existing rows and returns only inserted rows', async () => {
    await execute(qb().insert({ id: 'one', label: 'keep', score: 1, optional: null, version: 1 }));
    const insert = qb().insert([
      { id: 'one', label: 'discard', score: 2, optional: null, version: 1 },
      { id: 'two', label: 'new', score: 3, optional: null, version: 1 },
    ]);
    insert.onConflict({ fields: ['id'], ignore: true });
    expect(await execute(insert)).toMatchObject([{ id: 'two', label: 'new' }]);
    expect(await execute(qb().select(['label']).where('`id` = ?', ['one']))).toEqual([{ label: 'keep' }]);
  });

  test('merge-object updates are distinct from insert values', async () => {
    await execute(qb().insert({ id: 'one', label: 'keep', score: 1, optional: null, version: 1 }));
    const upsert = qb().insert({ id: 'one', label: 'discard', score: 2, optional: null, version: 1 });
    upsert.onConflict({ fields: ['id'], merge: { score: 9 } });
    expect(await execute(upsert)).toMatchObject([{ id: 'one', label: 'keep', score: 9 }]);
  });

  test('version increment is applied only to an existing row', async () => {
    await execute(qb().insert({ id: 'one', label: 'keep', score: 1, optional: null, version: 4 }));
    const upsert = qb().insert([
      { id: 'one', label: 'discard', score: 2, optional: null, version: 1 },
      { id: 'two', label: 'new', score: 3, optional: null, version: 1 },
    ]);
    upsert.onConflict({ fields: ['id'], merge: ['score'], version: { field: 'version' } });
    await execute(upsert);
    expect(await execute(qb().select(['id', 'version']).orderBy('`id` asc'))).toEqual([
      { id: 'one', version: 5 },
      { id: 'two', version: 1 },
    ]);
  });

  test('named subqueries and UInt64 pagination execute against the native engine', async () => {
    await execute(
      qb().insert([
        { id: 'one', label: 'a', score: 1, optional: null, version: 1 },
        { id: 'two', label: 'b', score: 2, optional: null, version: 1 },
      ]),
    );
    const source = qb().select(['id', 'score']).where('`score` > ?', [0]);
    const query = new YdbNativeQueryBuilder(platform)
      .with('active', source)
      .from('active', { alias: 'a' })
      .select('a.id')
      .orderBy('`a`.`id` asc')
      .limit(1)
      .offset(1);
    expect(await execute(query)).toEqual([{ id: 'two' }]);
  });

  test('joined aliases and root-star fields sort using projected names', async () => {
    await execute(
      qb().insert([
        { id: 'one', label: 'z', score: 1, optional: null, version: 1 },
        { id: 'two', label: 'a', score: 2, optional: null, version: 1 },
      ]),
    );
    const joined = new YdbNativeQueryBuilder(platform)
      .from(table, { alias: 'a' })
      .select(['a.id', raw('?? as ??', ['b.label', 'b__label'])])
      .join(`left join \`${table}\` as \`b\` on \`a\`.\`id\` = \`b\`.\`id\``, [])
      .orderBy('`b`.`label` asc');
    expect(await execute(joined)).toEqual([
      { id: 'two', b__label: 'a' },
      { id: 'one', b__label: 'z' },
    ]);
    const root = new YdbNativeQueryBuilder(platform)
      .from(table, { alias: 'a' })
      .select('a.*')
      .orderBy('`a`.`score` desc');
    expect((await execute(root)).map(row => row.id)).toEqual(['two', 'one']);
  });

  test('aggregate ordering pages a grouped IN key-subquery without changing its arity', async () => {
    await execute(
      qb().insert([
        { id: 'one', label: 'a', score: 1, optional: null, version: 1 },
        { id: 'two', label: 'b', score: 9, optional: null, version: 1 },
      ]),
    );
    const grouped = new YdbNativeQueryBuilder(platform)
      .from(table, { alias: 'a' })
      .select('a.id')
      .groupBy(['a.id'])
      .orderBy('min(`a`.`score`) desc')
      .limit(1);
    expect(await execute(grouped)).toEqual([{ id: 'two' }]);
    const subquery = grouped.toRaw();
    const outer = qb().select('id').where('`id` in (?)', [subquery]);
    expect(await execute(outer)).toEqual([{ id: 'two' }]);
  });

  test('schema-clear truncation removes data through an atomic DELETE', async () => {
    await execute(
      qb().insert([
        { id: 'one', label: 'a', score: 1, optional: null, version: 1 },
        { id: 'two', label: 'b', score: 2, optional: null, version: 1 },
      ]),
    );
    expect(await execute(qb().truncate())).toHaveLength(2);
    expect(await execute(qb().select('*'))).toEqual([]);
  });

  test('raw merge expressions can combine current and incoming column values', async () => {
    await execute(qb().insert({ id: 'one', label: 'keep', score: 5, optional: null, version: 1 }));
    const upsert = qb().insert({ id: 'one', label: 'discard', score: 3, optional: null, version: 1 });
    upsert.onConflict({ fields: ['id'], merge: { score: raw('?? + ? + excluded.score', ['score', 1]) } });
    expect(await execute(upsert)).toMatchObject([{ id: 'one', label: 'keep', score: 9 }]);
  });

  test('dependent named subqueries execute in declaration order', async () => {
    await execute(
      qb().insert([
        { id: 'one', label: 'a', score: 1, optional: null, version: 1 },
        { id: 'two', label: 'b', score: 9, optional: null, version: 1 },
      ]),
    );
    const source = qb().select(['id', 'score']);
    const filtered = new YdbNativeQueryBuilder(platform).from('source').select('id').where('`score` > ?', [5]);
    const query = new YdbNativeQueryBuilder(platform)
      .with('source', source)
      .with('filtered', filtered)
      .from('filtered')
      .select('id');
    expect(await execute(query)).toEqual([{ id: 'two' }]);
  });
});
