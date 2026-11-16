import { create } from '@bufbuild/protobuf';
import { EntitySchema, MikroORM, type Options } from '@mikro-orm/core';
import { Migration } from '@mikro-orm/migrations';
import { DescribeTableResultSchema } from '@ydbjs/api/table';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { Int64, Timestamp, Utf8 } from '@ydbjs/value/primitive';
import { YdbMigrationStorage, YdbMigrator } from '../src/YdbMigrator.js';
import { YdbSqlDriver } from '../src/YdbSqlDriver.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `ydb_migrations_${process.pid}_${Date.now().toString(36)}`;

function options(tableName: string): Partial<Options<YdbSqlDriver>> {
  return {
    driver: YdbSqlDriver,
    entities: [new EntitySchema({ name: 'MigrationFixture', properties: { id: { type: 'string', primary: true } } })],
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    extensions: [YdbMigrator],
    migrations: {
      tableName,
      transactional: false,
      allOrNothing: false,
      snapshot: false,
      silent: true,
      migrationsList: [],
    },
  };
}

function trackingTable() {
  return create(DescribeTableResultSchema, {
    primaryKey: ['id'],
    columns: [
      { name: 'id', type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.INT64 } }, notNull: true },
      { name: 'name', type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } }, notNull: true },
      { name: 'executed_at', type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.TIMESTAMP } }, notNull: true },
    ],
  });
}

describe('YDB migration storage contracts', () => {
  let orm: MikroORM<YdbSqlDriver>;

  beforeEach(async () => {
    orm = await MikroORM.init<YdbSqlDriver>(options(`${prefix}_unit`));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await orm?.close(true);
  });

  test('requires explicit nontransactional DDL options', () => {
    orm.config.get('migrations').transactional = true;
    expect(() => new YdbMigrator(orm.em)).toThrow(/transactional: false.*allOrNothing: false/);
    orm.config.get('migrations').transactional = false;
    orm.config.get('migrations').allOrNothing = true;
    expect(() => new YdbMigrator(orm.em)).toThrow(/transactional: false.*allOrNothing: false/);
  });

  test('accepts an existing protobuf table definition with no default expressions', async () => {
    const native = orm.driver.getConnection().getYdbConnection();
    vi.spyOn(native, 'describeTable').mockResolvedValue(trackingTable());
    const ddl = vi.spyOn(native, 'executeScheme').mockResolvedValue();
    const storage = new YdbMigrationStorage(orm.driver, orm.config.get('migrations'));
    await storage.ensureTable();
    expect(ddl).not.toHaveBeenCalled();
    const entity = storage.getTableName().entity;
    expect(entity.meta.properties.id.autoincrement).toBe(false);
    expect(entity.meta.properties.executedAt.defaultRaw).toBeUndefined();
  });

  test('rejects incompatible tracking tables instead of using their history', async () => {
    const native = orm.driver.getConnection().getYdbConnection();
    const table = trackingTable();
    table.primaryKey = ['name'];
    vi.spyOn(native, 'describeTable').mockResolvedValue(table);
    const query = vi.spyOn(native, 'query').mockResolvedValue([]);
    const storage = new YdbMigrationStorage(orm.driver, orm.config.get('migrations'));
    await expect(storage.getExecutedMigrations()).rejects.toThrow(/incompatible definition/);
    expect(query).not.toHaveBeenCalled();
  });

  test('converts ordered 64-bit history IDs to the public migration-row contract', async () => {
    const native = orm.driver.getConnection().getYdbConnection();
    vi.spyOn(native, 'describeTable').mockResolvedValue(trackingTable());
    const when = new Date('2026-01-01T00:00:00.000Z');
    const query = vi.spyOn(native, 'query').mockResolvedValue([
      { id: 1n, name: 'MigrationFirst', executed_at: when },
      { id: 2n, name: 'MigrationSecond', executed_at: when },
    ]);
    const storage = new YdbMigrationStorage(orm.driver, orm.config.get('migrations'));
    expect(await storage.getExecutedMigrations()).toEqual([
      { id: 1, name: 'MigrationFirst', executed_at: when },
      { id: 2, name: 'MigrationSecond', executed_at: when },
    ]);
    expect(query.mock.calls[0][0]).toMatch(/WHERE id > 0 ORDER BY id ASC/);
  });

  test('rejects external transactions and runtime schemas before running DDL', async () => {
    const native = orm.driver.getConnection().getYdbConnection();
    const query = vi.spyOn(native, 'query').mockResolvedValue([]);
    const migrator = orm.migrator as YdbMigrator;
    await expect(migrator.up({ transaction: {} })).rejects.toThrow(/caller transaction/);
    await expect(migrator.up({ schema: 'tenant' })).rejects.toThrow(/runtime SQL schema/);
    expect(query).not.toHaveBeenCalled();
  });

  test('preserves both migration and cleanup errors when a run lock cannot be released', async () => {
    const native = orm.driver.getConnection().getYdbConnection();
    vi.spyOn(native, 'describeTable').mockResolvedValue(trackingTable());
    vi.spyOn(native, 'query').mockResolvedValue([]);
    const bodyError = new Error('migration body failed');
    const cleanupError = new Error('release failed');
    vi.spyOn(native, 'transactional').mockRejectedValue(cleanupError);
    const storage = new YdbMigrationStorage(orm.driver, orm.config.get('migrations'));
    try {
      await storage.withMigrationLock(async () => {
        throw bodyError;
      });
      expect.fail('migration must reject');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([bodyError, cleanupError]);
    }
  });
});

describe.skipIf(!enabled)('real YDB SQL migration history and locking', () => {
  const allTables = new Set<string>();
  const orms: MikroORM<YdbSqlDriver>[] = [];
  const table = (suffix: string) => {
    const name = `${prefix}_${suffix}`;
    allTables.add(name);
    return name;
  };

  async function init(
    history: string,
    migrationsList: NonNullable<Options<YdbSqlDriver>['migrations']>['migrationsList'],
  ) {
    const config = options(history);
    config.migrations!.migrationsList = migrationsList;
    const orm = await MikroORM.init<YdbSqlDriver>(config);
    orms.push(orm);
    return orm;
  }

  afterAll(async () => {
    const native = orms[0]?.driver.getConnection().getYdbConnection();
    try {
      if (native)
        for (const name of [...allTables].reverse()) {
          if (await native.describeTable(name)) await native.executeScheme(`DROP TABLE \`${name}\``);
        }
    } finally {
      await Promise.all(orms.map(orm => orm.close(true)));
    }
  });

  test('runs normal Migration classes in order, records application values, and reverses the latest migration', async () => {
    const firstTable = table('first');
    const secondTable = table('second');
    const history = table('history');
    class First extends Migration {
      override up() {
        this.addSql(`CREATE TABLE \`${firstTable}\` (id Utf8 NOT NULL, PRIMARY KEY (id))`);
      }
      override down() {
        this.addSql(`DROP TABLE \`${firstTable}\``);
      }
    }
    class Second extends Migration {
      override up() {
        this.addSql(`CREATE TABLE \`${secondTable}\` (id Utf8 NOT NULL, PRIMARY KEY (id))`);
      }
      override down() {
        this.addSql(`DROP TABLE \`${secondTable}\``);
      }
    }
    const orm = await init(history, [
      { name: 'MigrationFirst', class: First },
      { name: 'MigrationSecond', class: Second },
    ]);
    const migrator = orm.migrator as YdbMigrator;
    expect(await migrator.getExecuted()).toEqual([]);
    expect((await migrator.getPending()).map(row => row.name)).toEqual(['MigrationFirst', 'MigrationSecond']);
    expect((await migrator.up()).map(row => row.name)).toEqual(['MigrationFirst', 'MigrationSecond']);
    const executed = await migrator.getExecuted();
    expect(executed.map(row => row.id)).toEqual([1, 2]);
    expect(executed.map(row => row.name)).toEqual(['MigrationFirst', 'MigrationSecond']);
    expect(executed.every(row => row.executed_at instanceof Date)).toBe(true);
    expect(await migrator.up()).toEqual([]);
    expect((await migrator.down()).map(row => row.name)).toEqual(['MigrationSecond']);
    expect((await migrator.getExecuted()).map(row => row.name)).toEqual(['MigrationFirst']);
    const native = orm.driver.getConnection().getYdbConnection();
    expect(await native.describeTable(firstTable)).toBeDefined();
    expect(await native.describeTable(secondTable)).toBeUndefined();
    const definition = await native.describeTable(history);
    expect(definition!.columns.every(column => column.defaultValue.case === undefined)).toBe(true);
    expect(await native.query(`SELECT id FROM \`${history}\` WHERE id = 0`)).toEqual([]);
  });

  test('does not record a failed migration and exposes independently committed DDL', async () => {
    const partial = table('partial');
    const history = table('failed_history');
    class Failed extends Migration {
      override up() {
        this.addSql(`CREATE TABLE \`${partial}\` (id Utf8 NOT NULL, PRIMARY KEY (id))`);
        this.addSql(`ALTER TABLE \`${partial}\` ADD COLUMN invalid UnsupportedYdbType`);
      }
    }
    const orm = await init(history, [{ name: 'MigrationFailed', class: Failed }]);
    const migrator = orm.migrator as YdbMigrator;
    await expect(migrator.up()).rejects.toThrow();
    expect(await migrator.getExecuted()).toEqual([]);
    expect((await migrator.getPending()).map(row => row.name)).toEqual(['MigrationFailed']);
    const native = orm.driver.getConnection().getYdbConnection();
    expect(await native.describeTable(partial)).toBeDefined();
    expect(await native.query(`SELECT id FROM \`${history}\` WHERE id = 0`)).toEqual([]);
  });

  test('prevents concurrent processes from running a migration body twice', async () => {
    const created = table('serialized');
    const history = table('serialized_history');
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    let calls = 0;
    class Slow extends Migration {
      override async up() {
        calls++;
        started();
        await hold;
        this.addSql(`CREATE TABLE \`${created}\` (id Utf8 NOT NULL, PRIMARY KEY (id))`);
      }
      override down() {
        this.addSql(`DROP TABLE \`${created}\``);
      }
    }
    const first = await init(history, [{ name: 'MigrationSlow', class: Slow }]);
    const second = await init(history, [{ name: 'MigrationSlow', class: Slow }]);
    await first.migrator.getExecuted();
    const running = first.migrator.up();
    try {
      await entered;
      await expect(second.migrator.up()).rejects.toThrow(/Another YDB migration run holds the lock/);
      expect(calls).toBe(1);
      expect(await second.migrator.getExecuted()).toEqual([]);
    } finally {
      release();
    }
    await running;
    expect((await second.migrator.getExecuted()).map(row => row.name)).toEqual(['MigrationSlow']);
    expect(await second.migrator.up()).toEqual([]);
    expect(calls).toBe(1);
  });

  test('leaves an interrupted run lock visible and excludes it from migration history', async () => {
    const history = table('interrupted_history');
    const orm = await init(history, []);
    const migrator = orm.migrator as YdbMigrator;
    await migrator.getExecuted();
    const native = orm.driver.getConnection().getYdbConnection();
    await native.query(`INSERT INTO \`${history}\` (id, name, executed_at) VALUES ($id, $name, $time)`, {
      $id: new Int64(0n),
      $name: new Utf8('interrupted-run'),
      $time: new Timestamp(new Date()),
    });
    await expect(migrator.up()).rejects.toThrow(/confirm that no migration runner remains active/);
    expect(await migrator.getExecuted()).toEqual([]);
    expect(await native.query(`SELECT name FROM \`${history}\` WHERE id = 0`)).toEqual([{ name: 'interrupted-run' }]);
  });
});
