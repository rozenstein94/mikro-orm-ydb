import { randomUUID } from 'node:crypto';
import {
  BigIntType,
  DeadlockException,
  EntitySchema,
  TableExistsException,
  UniqueConstraintViolationException,
  type MigrateOptions,
  type MigrationInfo,
  type MigrationRow,
  type MikroORM,
  type Transaction,
} from '@mikro-orm/core';
import { MigrationStorage, Migrator as SqlMigrator } from '@mikro-orm/migrations';
import { type AbstractSqlConnection, type EntityManager } from '@mikro-orm/sql';
import { type DescribeTableResult } from '@ydbjs/api/table';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { Int64, Timestamp, Utf8 } from '@ydbjs/value/primitive';
import type { YdbConnection } from './YdbConnection.js';

interface NativeSqlConnection extends AbstractSqlConnection {
  getYdbConnection(): YdbConnection;
}

/**
 * SQL migration history without server-side generated columns or timestamp defaults.
 * id=0 is reserved for a durable run lock; positive identifiers describe committed history.
 */
export class YdbMigrationStorage extends MigrationStorage {
  #ensuring?: Promise<void>;

  override async ensureTable(): Promise<void> {
    if (!this.#ensuring) {
      this.#ensuring = this.ensureTrackingTable().finally(() => {
        this.#ensuring = undefined;
      });
    }
    return this.#ensuring;
  }

  private async ensureTrackingTable(): Promise<void> {
    const native = this.native();
    const { tableName } = this.getTableName();
    let table = await native.describeTable(tableName);
    if (!table) {
      const quoted = this.quotedTable();
      try {
        await native.executeScheme(
          `CREATE TABLE ${quoted} (id Int64 NOT NULL, name Utf8 NOT NULL, executed_at Timestamp NOT NULL, PRIMARY KEY (id))`,
        );
      } catch (error) {
        // Two first-time migration runners may both observe an absent tracking table.
        // A real schema/authentication/transport error must not be treated as table creation.
        if (!(error instanceof TableExistsException)) throw error;
      }
      table = await native.describeTable(tableName);
    }
    if (!table) throw new Error(`YDB migration tracking table ${tableName} was not created.`);
    this.validateTrackingTable(tableName, table);
  }

  private validateTrackingTable(name: string, table: DescribeTableResult): void {
    const types = new Map([
      ['id', Type_PrimitiveTypeId.INT64],
      ['name', Type_PrimitiveTypeId.UTF8],
      ['executed_at', Type_PrimitiveTypeId.TIMESTAMP],
    ]);
    const valid =
      table.primaryKey.length === 1 &&
      table.primaryKey[0] === 'id' &&
      table.columns.length === 3 &&
      table.columns.every(
        column =>
          column.type?.type.case === 'typeId' &&
          column.type.type.value === types.get(column.name) &&
          column.notNull !== false &&
          column.defaultValue.case === undefined,
      );
    if (!valid) {
      throw new Error(
        `YDB migration tracking table ${name} has an incompatible definition; expected id Int64, name Utf8 and executed_at Timestamp, all NOT NULL, with primary key id and no defaults.`,
      );
    }
  }

  override getTableName(): ReturnType<MigrationStorage['getTableName']> {
    const tableName = this.options.tableName ?? 'mikro_orm_migrations';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || this.options.schema || this.driver.config.get('schema')) {
      throw new Error('YDB migrations require a simple tracking table name and do not support SQL schemas.');
    }
    const entity = new EntitySchema({
      name: 'YdbMigration',
      tableName,
      properties: {
        id: { type: new BigIntType('number'), primary: true, autoincrement: false, fieldName: 'id' },
        name: { type: 'string', fieldName: 'name' },
        executedAt: { type: 'Date', fieldName: 'executed_at' },
      },
    }).init();
    entity.meta.sync();
    return { tableName, schemaName: '', entity };
  }

  override async getExecutedMigrations(): Promise<MigrationRow[]> {
    await this.ensureTable();
    const rows = await this.native().query(
      `SELECT id, name, executed_at FROM ${this.quotedTable()} WHERE id > 0 ORDER BY id ASC`,
    );
    return rows.map(row => {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id < 1 || typeof row.name !== 'string' || !(row.executed_at instanceof Date)) {
        throw new Error('YDB migration tracking table contains an invalid history row.');
      }
      return { id, name: row.name, executed_at: row.executed_at };
    });
  }

  override async logMigration(params: { name: string }, tx?: Transaction): Promise<void> {
    this.rejectTransaction(tx);
    await this.ensureTable();
    const native = this.native();
    const table = this.quotedTable();
    const name = this.getMigrationName(params.name);
    // Only this small DML transaction may be retried. Migration bodies and DDL are never replayed.
    for (let attempt = 0; ; attempt++) {
      try {
        await native.transactional(async ctx => {
          const duplicate = await native.query(
            `SELECT id FROM ${table} WHERE name = $name AND id > 0`,
            { $name: new Utf8(name) },
            ctx,
          );
          if (duplicate.length) throw new Error(`YDB migration ${name} is already recorded.`);
          const [last] = await native.query(`SELECT MAX(id) AS last_id FROM ${table}`, {}, ctx);
          const id = last.last_id == null ? 1n : BigInt(last.last_id) + 1n;
          if (id > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error('YDB migration history exhausted the safe identifier range.');
          await native.query(
            `INSERT INTO ${table} (id, name, executed_at) VALUES ($id, $name, $time)`,
            {
              $id: new Int64(id),
              $name: new Utf8(name),
              $time: new Timestamp(new Date()),
            },
            ctx,
          );
        });
        return;
      } catch (error) {
        if (!(error instanceof DeadlockException) || attempt >= 2) throw error;
      }
    }
  }

  override async unlogMigration(params: { name: string }, tx?: Transaction): Promise<void> {
    this.rejectTransaction(tx);
    await this.ensureTable();
    const name = this.getMigrationName(params.name);
    await this.native().query(`DELETE FROM ${this.quotedTable()} WHERE id > 0 AND name IN ($name, $js, $ts)`, {
      $name: new Utf8(name),
      $js: new Utf8(`${name}.js`),
      $ts: new Utf8(`${name}.ts`),
    });
  }

  /** Serializes migration runs across processes. Interrupted runs intentionally retain their lock. */
  async withMigrationLock<T>(run: () => Promise<T>): Promise<T> {
    await this.ensureTable();
    const owner = randomUUID();
    const native = this.native();
    const table = this.quotedTable();
    try {
      await native.query(`INSERT INTO ${table} (id, name, executed_at) VALUES ($id, $name, $time)`, {
        $id: new Int64(0n),
        $name: new Utf8(owner),
        $time: new Timestamp(new Date()),
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new Error(
          `Another YDB migration run holds the lock in ${this.getTableName().tableName} (id=0). If a process was interrupted, confirm that no migration runner remains active before manually removing that lock row.`,
          { cause: error },
        );
      }
      throw error;
    }

    let outcome: { success: true; result: T } | { success: false; error: unknown };
    try {
      outcome = { success: true, result: await run() };
    } catch (error) {
      outcome = { success: false, error };
    }
    try {
      await native.transactional(async ctx => {
        const [lock] = await native.query(`SELECT name FROM ${table} WHERE id = $id`, { $id: new Int64(0n) }, ctx);
        if (lock?.name !== owner)
          throw new Error(
            'The YDB migration run no longer owns its lock; inspect the tracking table before another run.',
          );
        await native.query(
          `DELETE FROM ${table} WHERE id = $id AND name = $name`,
          { $id: new Int64(0n), $name: new Utf8(owner) },
          ctx,
        );
      });
    } catch (error) {
      if (!outcome.success)
        throw new AggregateError(
          [outcome.error, error],
          'YDB migration failed and its run lock could not be released.',
        );
      throw error;
    }
    if (!outcome.success) throw outcome.error;
    return outcome.result;
  }

  override setMasterMigration(trx: Transaction): void {
    this.rejectTransaction(trx);
  }

  override unsetMasterMigration(): void {}

  override setRunSchema(schema?: string): void {
    if (schema) throw new Error('YDB migrations do not support runtime SQL schemas.');
  }

  override unsetRunSchema(): void {}

  private rejectTransaction(tx?: Transaction): void {
    if (tx)
      throw new Error('YDB migration history cannot share a transaction with DDL; use nontransactional migrations.');
  }

  private native(): YdbConnection {
    const connection = this.driver.getConnection() as NativeSqlConnection;
    if (typeof connection.getYdbConnection !== 'function') throw new Error('YdbMigrator requires YdbSqlDriver.');
    return connection.getYdbConnection();
  }

  private quotedTable(): string {
    return this.driver.getPlatform().quoteIdentifier(this.getTableName().tableName);
  }
}

/** Standard MikroORM SQL migrations with native YDB history and explicit nontransactional DDL. */
class Migrator extends SqlMigrator {
  constructor(em: EntityManager) {
    super(em);
    if (this.options.transactional !== false || this.options.allOrNothing !== false) {
      throw new Error(
        'YDB schema changes commit independently. Configure migrations.transactional: false and migrations.allOrNothing: false.',
      );
    }
    if (this.options.schema || this.options.includeWildcardSchema) {
      throw new Error('YDB migrations do not support SQL schemas or wildcard schema fan-out.');
    }
  }

  static override register(orm: MikroORM): void {
    orm.config.registerExtension('@mikro-orm/migrator', () => new Migrator(orm.em as EntityManager));
  }

  protected override createStorage(): YdbMigrationStorage {
    return new YdbMigrationStorage(this.driver, this.options);
  }

  override getStorage(): YdbMigrationStorage {
    return this.storage as YdbMigrationStorage;
  }

  protected override async runMigrations(
    method: 'up' | 'down',
    options?: string | string[] | MigrateOptions,
  ): Promise<MigrationInfo[]> {
    if (options && typeof options === 'object' && !Array.isArray(options) && (options.transaction || options.schema)) {
      throw new Error('YDB migrations do not accept a caller transaction or runtime SQL schema.');
    }
    await this.init();
    return this.getStorage().withMigrationLock(() => super.runMigrations(method, options));
  }
}

// MikroORM's optional dependency loader detects an explicit extension by its runtime name.
// Keep the class named Migrator so it does not append and register the generic SQL migrator.
export { Migrator as YdbMigrator };
