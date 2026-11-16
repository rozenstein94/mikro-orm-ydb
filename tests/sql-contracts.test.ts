import { Collection, EntitySchema, MikroORM, type EntityDictionary } from '@mikro-orm/core';
import { JsonDocument } from '@ydbjs/value/primitive';
import { CompiledQuery, Kysely } from 'kysely';
import { YdbConnection, YdbSqlDriver } from '../src/index.js';
import { YdbDialect } from '../src/YdbDialect.js';

class ContractRecord {
  id!: string;
}
const recordSchema = new EntitySchema<ContractRecord>({
  class: ContractRecord,
  properties: { id: { type: 'string', primary: true } },
});

function configuration(entities = [recordSchema]) {
  return {
    driver: YdbSqlDriver,
    entities,
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    ensureDatabase: false,
  };
}

describe('SQL connection lifecycle and cancellation contracts', () => {
  let orm: MikroORM<YdbSqlDriver>;

  beforeEach(async () => {
    orm = await MikroORM.init<YdbSqlDriver>(configuration());
  });
  afterEach(async () => {
    await orm?.close(true);
    vi.restoreAllMocks();
  });

  test('closes the native SDK after connect even when Kysely has not executed its first query', async () => {
    const connection = orm.driver.getConnection();
    const native = connection.getYdbConnection();
    vi.spyOn(native, 'connect').mockResolvedValue();
    const close = vi.spyOn(native, 'close').mockResolvedValue();

    await connection.connect();
    await connection.close();

    expect(close).toHaveBeenCalledOnce();
  });

  test('honors an already aborted signal before executing schema changes', async () => {
    const connection = orm.driver.getConnection();
    const native = connection.getYdbConnection();
    vi.spyOn(native, 'connect').mockResolvedValue();
    vi.spyOn(native, 'close').mockResolvedValue();
    const execute = vi.spyOn(native, 'executeScheme').mockResolvedValue();
    const reason = new Error('schema request cancelled');

    await expect(
      connection.execute('DROP TABLE contract_record', [], 'run', undefined, {
        signal: AbortSignal.abort(reason),
      } as never),
    ).rejects.toThrow(/cancelled/);

    expect(execute).not.toHaveBeenCalled();
  });

  test('accepts the core ignore query cancellation strategy', async () => {
    const connection = orm.driver.getConnection();
    const native = connection.getYdbConnection();
    vi.spyOn(native, 'connect').mockResolvedValue();
    vi.spyOn(native, 'close').mockResolvedValue();
    vi.spyOn(native, 'query').mockResolvedValue([{ ready: 1 }]);

    await expect(
      connection.execute('SELECT 1 AS ready', [], 'all', undefined, {
        inflightQueryAbortStrategy: 'ignore query',
      } as never),
    ).resolves.toEqual([{ ready: 1 }]);
  });
});

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `mikro_sql_contract_${process.pid}_${Date.now().toString(36)}`;
const rawTable = `${prefix}_raw`;

class ContractOwner {
  id!: string;
  label!: string;
  tags = new Collection<ContractTag>(this);
}
class ContractTag {
  id!: string;
}
const tagSchema = new EntitySchema<ContractTag>({
  class: ContractTag,
  tableName: `${prefix}_tag`,
  properties: { id: { type: 'string', primary: true } },
});
const ownerSchema = new EntitySchema<ContractOwner>({
  class: ContractOwner,
  tableName: `${prefix}_owner`,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    tags: { kind: 'm:n', entity: () => ContractTag, owner: true, pivotTable: `${prefix}_pivot` },
  },
});

interface RawRow {
  id: string;
  label: string;
  wide: bigint;
  created: Date;
  payload: unknown;
  bytes: Uint8Array;
}

describe.skipIf(!enabled)('SQL and direct Kysely contracts on real YDB', () => {
  let orm: MikroORM<YdbSqlDriver>;
  let db: Kysely<Record<string, RawRow>>;

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>({ ...configuration(), entities: [ownerSchema, tagSchema] });
    await orm.schema.create();
    db = new Kysely<Record<string, RawRow>>({ dialect: new YdbDialect(new YdbConnection(orm.config)) });
    await db.executeQuery(
      CompiledQuery.raw(`CREATE TABLE \`${rawTable}\` (
      id Utf8 NOT NULL, label Utf8 NOT NULL, wide Int64 NOT NULL,
      created Timestamp NOT NULL, payload JsonDocument NOT NULL, bytes String NOT NULL,
      PRIMARY KEY (id)
    )`),
    );
  });

  beforeEach(async () => {
    await orm.schema.clear({ truncate: false });
    orm.em.clear();
    await db.deleteFrom(rawTable).execute();
  });

  afterAll(async () => {
    if (db) {
      try {
        await db.executeQuery(CompiledQuery.raw(`DROP TABLE \`${rawTable}\``));
      } finally {
        await db.destroy();
      }
    }
    if (orm) {
      try {
        await orm.schema.drop();
      } finally {
        await orm.close(true);
      }
    }
  });

  function rawRecord(id: string): RawRow {
    return {
      id,
      label: "bound' value; --",
      wide: -9_007_199_254_740_993n,
      created: new Date('2026-11-16T01:02:03.456Z'),
      payload: new JsonDocument(JSON.stringify({ value: '123', nested: [true, 1] })),
      bytes: new Uint8Array([0, 1, 127, 255]),
    };
  }

  test('executes direct Kysely CRUD with lossless typed parameters on the native SDK', async () => {
    const row = rawRecord('raw-a');

    const inserted = await db.insertInto(rawTable).values(row).executeTakeFirstOrThrow();
    expect(inserted.numInsertedOrUpdatedRows).toBe(1n);
    const loaded = await db.selectFrom(rawTable).selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
    expect({ ...loaded, bytes: undefined }).toEqual({
      ...row,
      bytes: undefined,
      payload: { value: '123', nested: [true, 1] },
    });
    expect(Array.from(loaded.bytes)).toEqual(Array.from(row.bytes));

    const updated = await db
      .updateTable(rawTable)
      .set({ label: 'Changed' })
      .where('id', '=', row.id)
      .returning('id')
      .execute();
    expect(updated).toEqual([{ id: row.id }]);
    expect((await db.deleteFrom(rawTable).where('id', '=', row.id).executeTakeFirstOrThrow()).numDeletedRows).toBe(1n);
    expect(await db.selectFrom(rawTable).select('id').execute()).toEqual([]);
  });

  test('executes Kysely CTEs through the actual dialect and native Table API', async () => {
    await db
      .insertInto(rawTable)
      .values([rawRecord('a'), rawRecord('b')])
      .execute();
    const query = db
      .with('selected', builder => builder.selectFrom(rawTable).select(['id', 'label']).where('id', '=', 'b'))
      .selectFrom('selected')
      .select(['selected.id', 'selected.label']);

    expect(await query.execute()).toEqual([{ id: 'b', label: rawRecord('b').label }]);
    const named = await db.executeQuery<{ id: string }>(
      CompiledQuery.raw(`$selected = (SELECT id FROM \`${rawTable}\` WHERE id = ?); SELECT * FROM $selected`, ['a']),
    );
    expect(named.rows).toEqual([{ id: 'a' }]);
  });

  test('rolls back direct Kysely callback writes and commits controlled transactions without callback replay', async () => {
    await db.insertInto(rawTable).values(rawRecord('a')).execute();
    const callback = vi.fn(async (transaction: Kysely<Record<string, RawRow>>) => {
      await transaction.updateTable(rawTable).set({ label: 'rolled back' }).where('id', '=', 'a').execute();
      throw new Error('application rollback');
    });

    await expect(db.transaction().setIsolationLevel('serializable').execute(callback)).rejects.toThrow(
      /application rollback/,
    );
    expect(callback).toHaveBeenCalledOnce();
    expect((await db.selectFrom(rawTable).select('label').where('id', '=', 'a').executeTakeFirstOrThrow()).label).toBe(
      rawRecord('a').label,
    );

    const controlled = await db.startTransaction().execute();
    await controlled.updateTable(rawTable).set({ label: 'committed' }).where('id', '=', 'a').execute();
    await controlled.commit().execute();
    expect((await db.selectFrom(rawTable).select('label').where('id', '=', 'a').executeTakeFirstOrThrow()).label).toBe(
      'committed',
    );
  });

  test('rolls back owner rows when a native multi-insert pivot operation fails outside an existing transaction', async () => {
    await orm.em.insert(ContractTag, { id: 'tag' });
    const relation = orm.getMetadata(ContractOwner).properties.tags;
    const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
    const connection = orm.driver.getConnection();
    // No database FK is enforced in YDB, so an existing orphan pivot can cause a later conflict.
    await connection.execute(
      `INSERT INTO ${quote(relation.pivotTable)} (${quote(relation.joinColumns[0])}, ${quote(relation.inverseJoinColumns[0])}) VALUES (?, ?)`,
      ['new-owner', 'tag'],
      'run',
    );

    await expect(
      orm.driver.nativeInsertMany(ContractOwner, [
        {
          id: 'new-owner',
          label: 'must be rolled back',
          tags: ['tag'],
        } as unknown as EntityDictionary<ContractOwner>,
      ]),
    ).rejects.toThrow();

    expect(await orm.em.count(ContractOwner, { id: 'new-owner' })).toBe(0);
  });

  test('does not remove pivot rows when an already aborted native delete is caught inside a caller transaction', async () => {
    await orm.em.insert(ContractTag, { id: 'tag' });
    await orm.driver.nativeInsertMany(ContractOwner, [
      { id: 'owner', label: 'Owner', tags: ['tag'] } as unknown as EntityDictionary<ContractOwner>,
    ]);
    const connection = orm.driver.getConnection();
    const transaction = await connection.begin();
    const reason = new Error('delete cancelled');
    await expect(
      orm.driver.nativeDelete(
        ContractOwner,
        { id: 'owner' },
        {
          ctx: transaction,
          signal: AbortSignal.abort(reason),
        },
      ),
    ).rejects.toThrow(/cancelled/);
    await connection.commit(transaction);

    const relation = orm.getMetadata(ContractOwner).properties.tags;
    const quote = (name: string) => orm.driver.getPlatform().quoteIdentifier(name);
    const rows = await connection.execute(
      `SELECT * FROM ${quote(relation.pivotTable)} WHERE ${quote(relation.joinColumns[0])} = ?`,
      ['owner'],
    );
    expect(rows).toHaveLength(1);
    expect(await orm.em.count(ContractOwner, { id: 'owner' })).toBe(1);
  });

  test.each(['commit', 'rollback', 'release'] as const)(
    'reclaims a pool.max=1 session after native %s rejects an in-flight statement',
    async operation => {
      let queryStarted!: () => void;
      const started = new Promise<void>(resolve => {
        queryStarted = resolve;
      });
      const isolated = await MikroORM.init<YdbSqlDriver>({
        ...configuration(),
        pool: { min: 0, max: 1 },
        driverOptions: {
          queryTimeoutMs: 3_000,
          driverConfig: {
            hooks: {
              onCall(event: { method: string }) {
                if (event.method.endsWith('/ExecuteDataQuery')) queryStarted();
              },
            },
          },
        },
      });
      const native = isolated.driver.getConnection().getYdbConnection();
      const begin = vi.spyOn(native, 'begin');
      const driver = new YdbDialect(native).createDriver();
      try {
        await driver.init();
        const logical = await driver.acquireConnection();
        await driver.beginTransaction(logical, {});
        const transaction = await begin.mock.results[0].value;
        // SDK hooks observe a genuine dispatched RPC; no native query method is mocked.
        const statement = native.query('SELECT 1 AS ready', {}, transaction);
        await started;
        expect(transaction.busy).toBe(true);
        try {
          const control =
            operation === 'commit'
              ? () => driver.commitTransaction(logical)
              : operation === 'rollback'
                ? () => driver.rollbackTransaction(logical)
                : () => driver.releaseConnection(logical);
          await expect(control()).rejects.toThrow(/in flight/);
        } finally {
          await statement;
        }

        await driver.releaseConnection(logical);
        expect(native.hasTransaction(transaction)).toBe(false);
        const next = await native.begin();
        await native.rollback(next);
      } finally {
        begin.mockRestore();
        await driver.destroy();
        await isolated.close(true);
      }
    },
  );

  test('reclaims a pool.max=1 session after a failed statement and rejected commit', async () => {
    const isolated = await MikroORM.init<YdbSqlDriver>({
      ...configuration(),
      pool: { min: 0, max: 1 },
      driverOptions: { queryTimeoutMs: 3_000 },
    });
    const native = isolated.driver.getConnection().getYdbConnection();
    const begin = vi.spyOn(native, 'begin');
    const driver = new YdbDialect(native).createDriver();
    try {
      await driver.init();
      const logical = await driver.acquireConnection();
      await driver.beginTransaction(logical, {});
      const transaction = await begin.mock.results[0].value;

      await expect(logical.executeQuery(CompiledQuery.raw('SELECT MissingYdbFunction()'))).rejects.toThrow();
      expect(transaction.state).toBe('failed');
      expect(native.hasTransaction(transaction)).toBe(true);
      await expect(driver.commitTransaction(logical)).rejects.toThrow(/failed/);
      await driver.releaseConnection(logical);
      expect(native.hasTransaction(transaction)).toBe(false);
      const next = await native.begin();
      await native.rollback(next);
      const kysely = new Kysely<Record<string, RawRow>>({ dialect: new YdbDialect(native) });
      try {
        await expect(
          kysely.transaction().execute(trx => trx.executeQuery(CompiledQuery.raw('SELECT MissingYdbFunction()'))),
        ).rejects.toThrow(/MissingYdbFunction/i);
      } finally {
        await kysely.destroy();
      }
    } finally {
      begin.mockRestore();
      await driver.destroy();
      await isolated.close(true);
    }
  });
});
