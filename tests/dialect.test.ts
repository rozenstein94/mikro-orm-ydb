import { create } from '@bufbuild/protobuf';
import { DeadlockException, IsolationLevel } from '@mikro-orm/core';
import { DescribeTableResultSchema } from '@ydbjs/api/table';
import { Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { toJs } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import { Utf8Type } from '@ydbjs/value/primitive';
import { AbortedTransactionError, CompiledQuery, Kysely, sql, type QueryResult } from 'kysely';
import { YdbDialect, type YdbQueryExecutor } from '../src/YdbDialect.js';
import { type YdbConnection, type YdbTransaction } from '../src/YdbConnection.js';

interface Database {
  users: { id: string; name: string | null; rank: number };
}

function fixture() {
  const transaction = { id: 'transaction-id', state: 'active' } as YdbTransaction;
  const transactions = new Set<YdbTransaction>();
  const methods = {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    begin: vi.fn().mockImplementation(async () => {
      transaction.state = 'active';
      transactions.add(transaction);
      return transaction;
    }),
    commit: vi.fn().mockImplementation(async (ctx: YdbTransaction) => {
      if (ctx.busy) throw new Error('Cannot commit while a statement is in flight.');
      if (ctx.state !== 'active') throw new Error('The transaction is failed.');
      ctx.state = 'committed';
      transactions.delete(ctx);
    }),
    rollback: vi.fn().mockImplementation(async (ctx: YdbTransaction) => {
      if (ctx.busy) throw new Error('Cannot roll back while a statement is in flight.');
      ctx.state = 'rolledBack';
      transactions.delete(ctx);
    }),
    hasTransaction: vi.fn().mockImplementation((ctx: YdbTransaction) => transactions.has(ctx)),
    query: vi.fn<YdbConnection['query']>().mockResolvedValue([]),
    executeScheme: vi.fn().mockResolvedValue(undefined),
    listTables: vi.fn().mockResolvedValue([]),
    describeTable: vi.fn<YdbConnection['describeTable']>().mockResolvedValue(undefined),
  };
  const native = methods as unknown as YdbConnection;
  const dialect = new YdbDialect(native);
  const db = new Kysely<Database>({ dialect });
  return { transaction, transactions, methods, native, dialect, db };
}

describe('YDB Kysely dialect', () => {
  test('compiles joins, filters and ordering with YQL identifiers and separately bound values', async () => {
    const { db, methods } = fixture();
    methods.query.mockResolvedValue([{ id: 'a', name: 'A' }]);
    const value = "value'`; DROP TABLE users; --";

    const query = db
      .selectFrom('users as u')
      .innerJoin('users as v', 'v.id', 'u.id')
      .select(['u.id', 'v.name'])
      .where('u.name', '=', value)
      .orderBy('u.rank', 'desc')
      .limit(3)
      .offset(1);
    const compiled = query.compile();
    expect(compiled.sql).toBe(
      'select `u`.`id`, `v`.`name` from `users` as `u` inner join `users` as `v` on `v`.`id` = `u`.`id` where `u`.`name` = ? order by `u`.`rank` desc limit 3 offset 1',
    );
    expect(compiled.parameters).toEqual([value]);

    expect(await query.execute()).toEqual([{ id: 'a', name: 'A' }]);
    const [text, parameters] = methods.query.mock.calls[0];
    expect(text).not.toContain(value);
    expect(text).toContain('$p0');
    expect(toJs(parameters!.$p0)).toBe(value);
    expect(methods.connect).toHaveBeenCalledWith({ skipOnConnect: true });
    await db.destroy();
    expect(methods.close).toHaveBeenCalledOnce();
  });

  test('adds an unlimited Uint64 LIMIT for standalone OFFSET and rejects invalid pagination', () => {
    const { db } = fixture();
    expect(db.selectFrom('users').selectAll().offset(3).compile().sql).toBe(
      'select * from `users` limit 18446744073709551615ul offset 3',
    );
    expect(() => db.selectFrom('users').selectAll().limit(-1).compile()).toThrow(/limit|non-negative/i);
    expect(() => db.selectFrom('users').selectAll().offset(1.5).compile()).toThrow(/offset|non-negative/i);
  });

  test('compiles Kysely CTEs as native named queries and preserves their bound values', async () => {
    const { db, methods } = fixture();
    methods.query.mockResolvedValue([{ id: 'a' }]);
    const query = db
      .with('selected', builder => builder.selectFrom('users').select('id').where('rank', '>', 1))
      .selectFrom('selected')
      .select('selected.id');

    expect(query.compile().sql).toBe(
      '$selected = (select `id` from `users` where `rank` > ?);  select `selected`.`id` from $selected as `selected`',
    );
    expect(await query.execute()).toEqual([{ id: 'a' }]);
    expect(toJs(methods.query.mock.calls[0][1]!.$p0)).toBe(1);
    await db.destroy();
  });

  test('accepts leading read-only named queries and still rejects multiple operative statements', async () => {
    const { db, methods } = fixture();
    const text = '$one = (SELECT ? AS id); /* read only */ $two = (SELECT id FROM $one); SELECT * FROM $two;';
    await db.executeQuery(CompiledQuery.raw(text, ['a']));
    expect(methods.query.mock.calls[0][0]).toContain('$one = (SELECT $p0 AS id)');
    expect(toJs(methods.query.mock.calls[0][1]!.$p0)).toBe('a');
    await expect(
      db.executeQuery(CompiledQuery.raw('$evil = (UPDATE users SET rank=1 RETURNING id); SELECT * FROM $evil')),
    ).rejects.toThrow(/read-only/);
    await expect(db.executeQuery(CompiledQuery.raw('$read = (SELECT 1); COMMIT; DELETE FROM users'))).rejects.toThrow(
      /one statement/,
    );
    await expect(db.executeQuery(CompiledQuery.raw('$read = (SELECT 1); ROLLBACK'))).rejects.toThrow(/supports SELECT/);
    expect(methods.query).toHaveBeenCalledOnce();
    await db.destroy();
  });

  test('returns actual affected rows from RETURNING rather than a fabricated success count', async () => {
    const { db, methods } = fixture();
    methods.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const result = await db.executeQuery(db.updateTable('users').set({ name: 'Changed' }).returning('id').compile());

    expect(result).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], numAffectedRows: 2n });
    methods.query.mockResolvedValue([]);
    expect(await db.executeQuery(db.deleteFrom('users').where('id', '=', 'missing').returning('id').compile())).toEqual(
      { rows: [], numAffectedRows: 0n },
    );
    await db.destroy();
  });

  test('adds RETURNING to DML without an explicit clause to obtain its actual affected count', async () => {
    const { db, methods } = fixture();
    methods.query.mockResolvedValue([{ id: 'a' }]);

    expect((await db.updateTable('users').set({ name: 'Changed' }).execute())[0].numUpdatedRows).toBe(1n);
    expect(
      (await db.insertInto('users').values({ id: 'a', name: 'A', rank: 1 }).execute())[0].numInsertedOrUpdatedRows,
    ).toBe(1n);
    expect(methods.query.mock.calls[0][0]).toMatch(/ RETURNING \*$/);
    expect(methods.query.mock.calls[1][0]).toMatch(/ RETURNING \*$/);
    await db.destroy();
  });

  test('does not mistake comments, quoted data or nested queries for a mutation RETURNING clause', async () => {
    const { db, methods } = fixture();

    await db.executeQuery(CompiledQuery.raw("UPDATE users SET name = 'RETURNING'; -- RETURNING id"));
    await db.executeQuery(CompiledQuery.raw('UPDATE users SET rank = (SELECT 1 AS returning)'));
    expect(methods.query.mock.calls[0][0]).toBe("UPDATE users SET name = 'RETURNING' RETURNING *; -- RETURNING id");
    expect(methods.query.mock.calls[1][0]).toBe('UPDATE users SET rank = (SELECT 1 AS returning) RETURNING *');
    await expect(
      db.executeQuery(CompiledQuery.raw('UPDATE users SET rank = 1 RETURNING id; DELETE FROM users RETURNING id')),
    ).rejects.toThrow(/one statement/);
    expect(methods.query).toHaveBeenCalledTimes(2);
    await db.destroy();
  });

  test('rolls back standalone DML when its RETURNING result cannot be validated', async () => {
    const { db, methods, transaction } = fixture();
    methods.query.mockRejectedValue(new Error('YDB truncated the result set'));

    await expect(db.updateTable('users').set({ rank: 2 }).execute()).rejects.toThrow(/truncated/);

    expect(methods.rollback).toHaveBeenCalledExactlyOnceWith(transaction);
    expect(methods.commit).not.toHaveBeenCalled();
    await db.destroy();
  });

  test('allows explicitly typed null bindings and compiles IS NULL without a parameter', async () => {
    const { db, methods } = fixture();
    const nullable = new Optional(null, new Utf8Type());
    await sql`SELECT ${nullable} AS value`.execute(db);
    expect(toJs(methods.query.mock.calls[0][1]!.$p0)).toBeNull();
    const query = db.selectFrom('users').select('id').where('name', 'is', null).compile();
    expect(query.sql).toContain('`name` is null');
    expect(query.parameters).toEqual([]);
    await db.destroy();
  });

  test('rejects ambiguous untyped null and preserves subsecond timestamp parameters', async () => {
    const { db, methods } = fixture();
    await expect(db.executeQuery(CompiledQuery.raw('SELECT ? AS value', [null]))).rejects.toThrow(/typed Optional/);
    expect(methods.query).not.toHaveBeenCalled();
    const instant = new Date('2026-11-16T01:02:03.456Z');

    await db.executeQuery(CompiledQuery.raw('SELECT ? AS value', [instant]));

    expect(toJs(methods.query.mock.calls[0][1]!.$p0)).toEqual(instant);
    await db.destroy();
  });

  test('pins statements to a real native transaction and commits exactly once', async () => {
    const { db, methods, transaction } = fixture();
    methods.query.mockResolvedValue([{ id: 'a' }]);

    await db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async trx => {
        await trx.selectFrom('users').select('id').execute();
        await trx.updateTable('users').set({ rank: 2 }).returning('id').execute();
      });

    expect(methods.begin).toHaveBeenCalledWith({ isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: false });
    expect(methods.query.mock.calls.every(call => call[2] === transaction)).toBe(true);
    expect(methods.commit).toHaveBeenCalledExactlyOnceWith(transaction);
    expect(methods.rollback).not.toHaveBeenCalled();
    await db.destroy();
  });

  test('rolls back callback failures without replaying the callback', async () => {
    const { db, methods, transaction } = fixture();
    const failure = new Error('application callback failed');
    const callback = vi.fn(async trx => {
      await trx.selectFrom('users').select('id').execute();
      throw failure;
    });

    await expect(db.transaction().execute(callback)).rejects.toBe(failure);

    expect(callback).toHaveBeenCalledOnce();
    expect(methods.rollback).toHaveBeenCalledExactlyOnceWith(transaction);
    expect(methods.commit).not.toHaveBeenCalled();
    await db.destroy();
  });

  test('preserves confirmed abort information for Kysely controlled transactions', async () => {
    const { dialect, methods, transactions } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    const conflict = new DeadlockException(new Error('YDB transaction conflict'));
    methods.commit.mockImplementationOnce(async ctx => {
      ctx.state = 'failed';
      transactions.delete(ctx);
      throw conflict;
    });

    let error: unknown;
    try {
      await driver.commitTransaction(connection);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AbortedTransactionError);
    expect((error as Error).cause).toBe(conflict);
    await driver.releaseConnection(connection);
    expect(methods.rollback).not.toHaveBeenCalled();
    await driver.destroy();
  });

  test('passes read-only settings and rejects unsupported isolation or savepoints', async () => {
    const { dialect, methods } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();

    await expect(driver.beginTransaction(connection, { isolationLevel: 'read committed' })).rejects.toThrow(
      /serializable/,
    );
    expect(methods.begin).not.toHaveBeenCalled();
    await driver.beginTransaction(connection, { accessMode: 'read only' });
    expect(methods.begin).toHaveBeenCalledWith({ isolationLevel: IsolationLevel.SERIALIZABLE, readOnly: true });
    await expect(driver.beginTransaction(connection, {})).rejects.toThrow(/nested/);
    const compiler = dialect.createQueryCompiler();
    await expect(driver.savepoint!(connection, 'nested', (...args) => compiler.compileQuery(...args))).rejects.toThrow(
      /savepoints/,
    );
    await driver.rollbackTransaction(connection);
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  test('rejects concurrent lifecycle control and queries instead of losing a pinned transaction', async () => {
    const { dialect, methods, transaction } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    let finishBegin!: (transaction: YdbTransaction) => void;
    methods.begin.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishBegin = resolve;
        }),
    );
    const beginning = driver.beginTransaction(connection, {});
    await expect(driver.beginTransaction(connection, {})).rejects.toThrow(/in flight/);
    await expect(connection.executeQuery(CompiledQuery.raw('SELECT 1'))).rejects.toThrow(/in flight/);
    await expect(driver.releaseConnection(connection)).rejects.toThrow(/in flight/);
    expect(methods.begin).toHaveBeenCalledOnce();
    finishBegin(transaction);
    await beginning;

    let finishCommit!: () => void;
    methods.commit.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishCommit = resolve;
        }),
    );
    const committing = driver.commitTransaction(connection);
    await expect(driver.commitTransaction(connection)).rejects.toThrow(/in flight/);
    await expect(connection.executeQuery(CompiledQuery.raw('SELECT 1'))).rejects.toThrow(/in flight/);
    finishCommit();
    await committing;

    await connection.executeQuery(CompiledQuery.raw('SELECT 1'));
    expect(methods.query.mock.calls[0][2]).toBeUndefined();
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  test('rolls back a leaked transaction when releasing a handle and rejects its further use', async () => {
    const { dialect, methods, transaction } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});

    await driver.releaseConnection(connection);

    expect(methods.rollback).toHaveBeenCalledExactlyOnceWith(transaction);
    await expect(connection.executeQuery(CompiledQuery.raw('SELECT 1'))).rejects.toThrow(/released/);
    await expect(driver.commitTransaction(connection)).rejects.toThrow(/released|another driver/);
    await driver.destroy();
  });

  test.each(['commit', 'rollback', 'release'] as const)(
    'retains transaction ownership after native %s rejects a busy session',
    async operation => {
      const { dialect, methods, transaction } = fixture();
      const driver = dialect.createDriver();
      await driver.init();
      const connection = await driver.acquireConnection();
      await driver.beginTransaction(connection, {});
      transaction.busy = true;

      const control =
        operation === 'commit'
          ? () => driver.commitTransaction(connection)
          : operation === 'rollback'
            ? () => driver.rollbackTransaction(connection)
            : () => driver.releaseConnection(connection);
      await expect(control()).rejects.toThrow(/in flight/);
      expect(methods.hasTransaction(transaction)).toBe(true);

      transaction.busy = false;
      await driver.releaseConnection(connection);
      expect(methods.hasTransaction(transaction)).toBe(false);
      expect(methods.rollback).toHaveBeenCalledWith(transaction);
      await driver.destroy();
    },
  );

  test('retains a failed statement context until native rollback actually releases its session', async () => {
    const { dialect, methods, transaction } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    methods.query.mockImplementationOnce(async () => {
      transaction.state = 'failed';
      throw new Error('statement failed');
    });

    await expect(connection.executeQuery(CompiledQuery.raw('SELECT invalid'))).rejects.toThrow(/statement failed/);
    await expect(driver.commitTransaction(connection)).rejects.toThrow(/transaction is failed/);
    expect(methods.hasTransaction(transaction)).toBe(true);
    await driver.releaseConnection(connection);
    expect(methods.hasTransaction(transaction)).toBe(false);
    expect(methods.rollback).toHaveBeenCalledExactlyOnceWith(transaction);
    await driver.destroy();
  });

  test('blocks transaction control before a logical statement has reached the native busy guard', async () => {
    const { dialect, methods, transaction } = fixture();
    const driver = dialect.createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    let finish!: (rows: { ready: number }[]) => void;
    methods.query.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const statement = connection.executeQuery(CompiledQuery.raw('SELECT 1 AS ready'));
    expect(transaction.busy).toBeFalsy();

    await expect(driver.commitTransaction(connection)).rejects.toThrow(/statement is in flight/);
    await expect(driver.rollbackTransaction(connection)).rejects.toThrow(/statement is in flight/);
    await expect(driver.releaseConnection(connection)).rejects.toThrow(/statement is in flight/);
    expect(methods.commit).not.toHaveBeenCalled();
    expect(methods.rollback).not.toHaveBeenCalled();
    finish([{ ready: 1 }]);
    await statement;
    await driver.releaseConnection(connection);
    expect(methods.hasTransaction(transaction)).toBe(false);
    await driver.destroy();
  });

  test('rejects cancelled acquisition and closes active transactions on destroy', async () => {
    const { dialect, methods } = fixture();
    const driver = dialect.createDriver();
    const reason = new Error('request cancelled');
    await expect(driver.acquireConnection({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});

    await driver.destroy();
    await driver.destroy();

    expect(methods.rollback).toHaveBeenCalledOnce();
    expect(methods.close).toHaveBeenCalledOnce();
    await expect(driver.acquireConnection()).rejects.toThrow(/destroyed/);
  });

  test('supports an injected executor without losing SQL parameters, transaction or cancellation context', async () => {
    const { native, methods, transaction } = fixture();
    const result: QueryResult<unknown> = { rows: [{ id: 'a' }], numAffectedRows: 1n };
    const executor = vi.fn<YdbQueryExecutor>().mockResolvedValue(result);
    const driver = new YdbDialect(native, executor).createDriver();
    await driver.init();
    const connection = await driver.acquireConnection();
    await driver.beginTransaction(connection, {});
    const controller = new AbortController();
    const query = CompiledQuery.raw('UPDATE users SET name = ? WHERE id = ?', ['Changed', 'a']);

    expect(await connection.executeQuery(query, { signal: controller.signal })).toBe(result);
    expect(executor).toHaveBeenCalledWith(query, transaction, controller.signal);
    expect(methods.query).not.toHaveBeenCalled();
    await driver.rollbackTransaction(connection);
    await driver.releaseConnection(connection);
    await driver.destroy();
  });

  test('routes standalone DDL to the scheme API and rejects data-transaction DDL', async () => {
    const { db, methods } = fixture();
    const ddl = 'CREATE TABLE users (id Utf8 NOT NULL, PRIMARY KEY (id))';
    const controller = new AbortController();

    await db.executeQuery(CompiledQuery.raw(ddl), { signal: controller.signal });
    expect(methods.executeScheme).toHaveBeenCalledExactlyOnceWith(ddl, controller.signal);
    await expect(db.transaction().execute(trx => trx.executeQuery(CompiledQuery.raw(ddl)))).rejects.toThrow(
      /DDL cannot execute inside/,
    );
    expect(methods.executeScheme).toHaveBeenCalledOnce();
    await db.destroy();
  });

  test('reports native table metadata and hides Kysely internal tables by default', async () => {
    const { db, methods } = fixture();
    methods.listTables.mockResolvedValue(['users', 'kysely_migration', 'kysely_migration_lock']);
    methods.describeTable.mockResolvedValue(
      create(DescribeTableResultSchema, {
        columns: [
          { name: 'id', type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } }, notNull: true },
          {
            name: 'name',
            type: {
              type: {
                case: 'optionalType',
                value: { item: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } } },
              },
            },
          },
        ],
        primaryKey: ['id'],
      }),
    );

    expect(await db.introspection.getSchemas()).toEqual([]);
    expect(await db.introspection.getTables()).toEqual([
      {
        name: 'users',
        isView: false,
        isForeign: false,
        columns: [
          { name: 'id', dataType: 'Utf8', isNullable: false, isAutoIncrementing: false, hasDefaultValue: false },
          { name: 'name', dataType: 'Utf8', isNullable: true, isAutoIncrementing: false, hasDefaultValue: false },
        ],
      },
    ]);
    expect((await db.introspection.getTables({ withInternalKyselyTables: true })).map(table => table.name)).toEqual([
      'users',
      'kysely_migration',
      'kysely_migration_lock',
    ]);
    await db.destroy();
  });

  test('serializes nontransactional migrations using an atomic native transaction lock', async () => {
    const { dialect, methods, transaction } = fixture();
    methods.query.mockResolvedValueOnce([{ is_locked: 0 }]).mockResolvedValue([]);
    const adapter = dialect.createAdapter();
    const lock = { lockTable: 'kysely_migration_lock', lockRowId: 'migration_lock' };

    await adapter.acquireMigrationLock({} as never, lock);

    expect(methods.query.mock.calls[0][0]).toBe('SELECT is_locked FROM `kysely_migration_lock` WHERE id = $id');
    expect(methods.query.mock.calls[1][0]).toBe(
      'UPDATE `kysely_migration_lock` SET is_locked = $locked WHERE id = $id',
    );
    expect(methods.query.mock.calls.slice(0, 2).every(call => call[2] === transaction)).toBe(true);
    expect(methods.commit).toHaveBeenCalledExactlyOnceWith(transaction);
    await expect(adapter.acquireMigrationLock({} as never, lock)).rejects.toThrow(/already held/);

    await adapter.releaseMigrationLock({} as never, lock);
    expect(methods.query.mock.calls[2][0]).toBe(
      'UPDATE `kysely_migration_lock` SET is_locked = $unlocked WHERE id = $id',
    );
    expect(methods.query.mock.calls[2][2]).toBeUndefined();
    expect(adapter.supportsTransactionalDdl).toBe(false);
    expect(adapter.supportsReturning).toBe(true);
  });
});
