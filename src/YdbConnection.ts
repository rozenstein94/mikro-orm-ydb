import { fromBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import {
  Connection,
  EventType,
  IsolationLevel,
  type Dictionary,
  type Transaction,
  type TransactionEventBroadcaster,
} from '@mikro-orm/core';
import { StatusIds_StatusCode as Status, type Operation } from '@ydbjs/api/operation';
import { SchemeServiceDefinition } from '@ydbjs/api/scheme';
import {
  BeginTransactionResultSchema,
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  ExecuteQueryResultSchema,
  TableServiceDefinition,
  type DescribeTableResult,
} from '@ydbjs/api/table';
import { Driver, type DriverOptions } from '@ydbjs/core';
import { YDBError } from '@ydbjs/error';
import { fromYdb, toJs, type Value } from '@ydbjs/value';
import { typeToString } from '@ydbjs/value/print';
import { isYdbTableNotFound, YdbExceptionConverter } from './YdbExceptionConverter.js';

/** Driver options are forwarded to the official SDK; credentials never enter query logs. */
export interface YdbConnectionOptions {
  driver?: Driver;
  driverConfig?: DriverOptions;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}

type TableMethod =
  | 'createSession'
  | 'deleteSession'
  | 'executeDataQuery'
  | 'executeSchemeQuery'
  | 'describeTable'
  | 'beginTransaction'
  | 'commitTransaction'
  | 'rollbackTransaction';
type TableClient = {
  [K in TableMethod]: (
    request: Parameters<(typeof TableServiceDefinition)[K]['requestSerialize']>[0],
    options?: { signal?: AbortSignal },
  ) => Promise<ReturnType<(typeof TableServiceDefinition)[K]['responseDeserialize']>>;
};

function tableClient(driver: Driver, nodeId?: bigint): TableClient {
  return driver.createClient(TableServiceDefinition, nodeId);
}

interface Session {
  id: string;
  client: ReturnType<typeof tableClient>;
  leased: boolean;
  invalid: boolean;
}

/** An explicit transaction owns one session until commit or rollback. */
export interface YdbTransaction {
  readonly connection: YdbConnection;
  readonly session: Session;
  readonly id: string;
  state: 'active' | 'committed' | 'rolledBack' | 'failed';
  busy: boolean;
}

type TransactionOptions = NonNullable<Parameters<Connection['begin']>[0]>;

/** Native Table API connection with bounded pooling and explicit transaction ownership. */
export class YdbConnection extends Connection {
  #driver?: Driver;
  #owned = false;
  #connecting?: Promise<void>;
  #closing = false;
  #lifetime = new AbortController();
  #sessions = new Set<Session>();
  #creating = 0;
  #waiters = new Set<() => void>();
  #transactions = new Set<YdbTransaction>();
  #rpcs = new Set<Promise<unknown>>();
  readonly #converter = new YdbExceptionConverter();

  override async connect(options?: { skipOnConnect?: boolean }): Promise<void> {
    if (this.#closing) {
      throw new Error('YDB connection is closing.');
    }
    if (this.connected) {
      return;
    }
    if (this.#connecting) {
      return this.#connecting;
    }

    this.#connecting = this.initialize(options).finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  private settings(): YdbConnectionOptions {
    let options = this.options.driverOptions ?? this.config.get('driverOptions');
    if (typeof options === 'function') {
      options = options();
    }
    return (options ?? {}) as YdbConnectionOptions;
  }

  private async initialize(options?: { skipOnConnect?: boolean }): Promise<void> {
    this.#closing = false;
    this.#lifetime = new AbortController();
    const settings = this.settings();
    const endpoint = new URL(this.options.clientUrl ?? this.config.get('clientUrl'));
    const database = this.options.dbName ?? this.config.get('dbName');

    if (!['grpc:', 'grpcs:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new Error(
        'YDB requires a grpc:// or grpcs:// endpoint without URL credentials; use driverConfig.credentialsProvider.',
      );
    }
    if (endpoint.search || endpoint.hash || !database?.startsWith('/')) {
      throw new Error(
        'Set dbName to the absolute YDB database path, and clientUrl to its grpc:// or grpcs:// endpoint.',
      );
    }
    if (endpoint.pathname && endpoint.pathname !== '/' && endpoint.pathname !== database) {
      throw new Error('The YDB clientUrl database path and dbName must match.');
    }
    endpoint.pathname = database;
    this.#driver = settings.driver ?? new Driver(endpoint.toString(), settings.driverConfig);
    this.#owned = !settings.driver;

    try {
      await this.#driver.ready(this.signal(settings.connectTimeoutMs ?? 10_000));
      if (settings.driver && settings.driver.database !== database) {
        throw new Error('The supplied YDB Driver targets a different database than dbName.');
      }
      this.connected = true;
      if (!options?.skipOnConnect) {
        await this.onConnect();
      }
    } catch (error) {
      this.connected = false;
      if (this.#owned) {
        this.#driver.close();
      }
      this.#driver = undefined;
      throw this.convert(error);
    }
  }

  override async getNativeClient(): Promise<Driver> {
    await this.ensureConnection();
    return this.#driver!;
  }

  override async isConnected(): Promise<boolean> {
    return (await this.checkConnection()).ok;
  }

  override async checkConnection(): Promise<{ ok: true } | { ok: false; reason: string; error?: Error }> {
    if (!this.connected || this.#closing) {
      return { ok: false, reason: 'YDB connection is not established.' };
    }
    try {
      await this.query('SELECT 1 AS ready');
      return { ok: true };
    } catch (error) {
      const converted = this.convert(error);
      return { ok: false, reason: converted.message, error: converted };
    }
  }

  override async close(_force?: boolean): Promise<void> {
    if (this.#connecting) {
      await this.#connecting.catch(() => undefined);
    }
    this.#closing = true;
    this.connected = false;
    this.#lifetime.abort(new Error('YDB connection closed.'));
    this.wakeWaiters();
    await Promise.allSettled(this.#rpcs);

    const driver = this.#driver;
    if (driver) {
      await Promise.allSettled(
        [...this.#transactions].map(async transaction => {
          transaction.state = 'failed';
          await transaction.session.client.rollbackTransaction(
            { sessionId: transaction.session.id, txId: transaction.id },
            { signal: AbortSignal.timeout(5_000) },
          );
        }),
      );
      await Promise.allSettled([...this.#sessions].map(session => this.deleteSession(session)));
      if (this.#owned) {
        driver.close();
      }
    }

    this.#transactions.clear();
    this.#sessions.clear();
    this.#driver = undefined;
    this.#closing = false;
  }

  override async execute<T>(
    sql: string,
    params: unknown[] = [],
    method: 'all' | 'get' | 'run' = 'all',
    ctx?: Transaction,
  ): Promise<T[] | T | undefined> {
    if (params.length) {
      throw new Error('YDB raw SQL uses named, typed parameters; use connection.query(sql, { $name: value }).');
    }
    if (method === 'run') {
      throw new Error(
        'YDB does not report affected rows through raw execute(); use EntityManager native CRUD operations.',
      );
    }
    const rows = await this.query(sql, {}, ctx as YdbTransaction | undefined);
    return (method === 'get' ? rows[0] : rows) as T[] | T | undefined;
  }

  /** Execute one result set, retrying only confirmed aborts or rejected expired sessions. */
  async query(
    sql: string,
    parameters: Record<string, Value> = {},
    ctx?: YdbTransaction,
    signal?: AbortSignal,
  ): Promise<Dictionary[]> {
    // Transaction control belongs to this connection. It must not split an atomic retry into partial commits.
    if (/(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
      throw new Error('Use MikroORM transaction methods instead of YQL transaction control statements.');
    }
    await this.ensureConnection();
    const declarations: string[] = [];
    const encoded = Object.fromEntries(
      Object.entries(parameters).map(([name, value]) => {
        if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error('YDB parameter names must start with $ followed by an identifier.');
        }
        declarations.push(`DECLARE ${name} AS ${typeToString(value.type)};`);
        return [name, structuredClone({ type: value.type.encode(), value: value.encode() })];
      }),
    );
    const text = [...declarations, sql].join('\n');

    return this.executeQuery(sql, async () => {
      for (let attempt = 0; ; attempt++) {
        const session = ctx ? this.assertTransaction(ctx).session : await this.acquire(signal);
        if (ctx?.busy) {
          throw new Error('Concurrent statements on a YDB transaction are not supported.');
        }
        if (ctx) {
          ctx.busy = true;
        }
        try {
          const response = await this.rpc(() =>
            session.client.executeDataQuery(
              {
                sessionId: session.id,
                query: { query: { case: 'yqlText', value: text } },
                parameters: encoded,
                txControl: ctx
                  ? { txSelector: { case: 'txId', value: ctx.id }, commitTx: false }
                  : {
                      txSelector: { case: 'beginTx', value: { txMode: { case: 'serializableReadWrite', value: {} } } },
                      commitTx: true,
                    },
              },
              { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000, signal) },
            ),
          );
          const result = this.unpack(response.operation, ExecuteQueryResultSchema);
          if (result.resultSets.some(set => set.truncated)) {
            throw new Error('YDB truncated the result set. Use a smaller limit and keyset pagination.');
          }
          if (result.resultSets.length > 1) {
            throw new Error('YDB connection.query() supports a single result set per call.');
          }
          const resultSet = result.resultSets[0];
          return (
            resultSet?.rows.map(row =>
              Object.fromEntries(
                resultSet.columns.map((column, index) => {
                  if (!column.type || !row.items[index]) {
                    throw new Error('YDB returned a result without a column type or value.');
                  }
                  return [column.name, toJs(fromYdb(row.items[index], column.type))];
                }),
              ),
            ) ?? []
          );
        } catch (error) {
          if (this.sessionFailed(error)) {
            session.invalid = true;
          }
          if (ctx) {
            // A failed statement must never be followed by a successful-looking commit.
            ctx.state = 'failed';
          }
          if (
            !ctx &&
            error instanceof YDBError &&
            (error.code === Status.ABORTED || this.sessionRejected(error)) &&
            attempt < 2 &&
            !signal?.aborted
          ) {
            continue;
          }
          throw this.convert(error);
        } finally {
          if (ctx) {
            ctx.busy = false;
          } else {
            await this.release(session);
          }
        }
      }
    });
  }

  async executeScheme(sql: string): Promise<void> {
    await this.ensureConnection();
    const session = await this.acquire();
    try {
      await this.executeQuery(sql, async () => {
        const response = await this.rpc(() =>
          session.client.executeSchemeQuery(
            { sessionId: session.id, yqlText: sql },
            { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
          ),
        );
        this.checkOperation(response.operation);
      });
    } catch (error) {
      session.invalid = this.sessionFailed(error);
      throw this.convert(error);
    } finally {
      await this.release(session);
    }
  }

  async describeTable(table: string): Promise<DescribeTableResult | undefined> {
    await this.ensureConnection();
    const database = this.#driver!.database.replace(/\/$/, '');
    const path = table.startsWith('/') ? table : `${database}/${table}`;
    if (!path.startsWith(`${database}/`) || path.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('YDB schema introspection requires a table path within the configured database.');
    }
    const session = await this.acquire();
    try {
      const response = await this.rpc(() =>
        session.client.describeTable(
          { sessionId: session.id, path },
          { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
        ),
      );
      return this.unpack(response.operation, DescribeTableResultSchema);
    } catch (error) {
      session.invalid = this.sessionFailed(error);
      if (isYdbTableNotFound(error)) {
        return undefined;
      }
      if (error instanceof YDBError && error.code === Status.SCHEME_ERROR) {
        // TableService omits missing-path details. SchemeService distinguishes that case
        // from schema/type problems without hiding authorization or transport errors.
        try {
          const response = await this.rpc(() =>
            this.#driver!.createClient(SchemeServiceDefinition).describePath(
              { path },
              { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
            ),
          );
          this.checkOperation(response.operation);
        } catch (pathError) {
          if (isYdbTableNotFound(pathError)) {
            return undefined;
          }
          throw this.convert(pathError);
        }
      }
      throw this.convert(error);
    } finally {
      await this.release(session);
    }
  }

  override async begin(options: TransactionOptions = {}): Promise<YdbTransaction> {
    if (options.ctx) {
      throw new Error('YDB does not support nested transactions or savepoints.');
    }
    if (options.sessionContext) {
      throw new Error('YDB does not support SQL session context.');
    }
    if (options.isolationLevel && options.isolationLevel !== IsolationLevel.SERIALIZABLE) {
      throw new Error('The YDB driver supports SERIALIZABLE transactions only.');
    }
    await this.ensureConnection();
    await options.eventBroadcaster?.dispatchEvent(EventType.beforeTransactionStart);
    for (let attempt = 0; ; attempt++) {
      const session = await this.acquire();
      let started = false;
      try {
        const response = await this.rpc(() =>
          session.client.beginTransaction(
            {
              sessionId: session.id,
              txSettings: {
                txMode: { case: options.readOnly ? 'snapshotReadOnly' : 'serializableReadWrite', value: {} },
              },
            },
            { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
          ),
        );
        const result = this.unpack(response.operation, BeginTransactionResultSchema);
        if (!result.txMeta?.id) {
          throw new Error('YDB did not return a transaction identifier.');
        }
        started = true;
        const transaction: YdbTransaction = {
          connection: this,
          session,
          id: result.txMeta.id,
          state: 'active',
          busy: false,
        };
        this.#transactions.add(transaction);
        this.logQuery('begin;', options.loggerContext);
        try {
          await options.eventBroadcaster?.dispatchEvent(EventType.afterTransactionStart, transaction);
        } catch (error) {
          await this.rollback(transaction).catch(() => undefined);
          throw error;
        }
        return transaction;
      } catch (error) {
        session.invalid = this.sessionFailed(error);
        if (session.leased) {
          await this.release(session);
        }
        if (!started && this.sessionRejected(error) && attempt < 2) {
          continue;
        }
        throw this.convert(error);
      }
    }
  }

  override async transactional<T>(
    cb: (trx: YdbTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const transaction = await this.begin(options);
    try {
      const result = await cb(transaction);
      await this.commit(transaction, options.eventBroadcaster, options.loggerContext);
      return result;
    } catch (error) {
      if (this.#transactions.has(transaction)) {
        // Preserve the operation/commit error if cleanup also fails, including uncertain commits.
        await this.rollback(transaction, options.eventBroadcaster, options.loggerContext).catch(() => undefined);
      }
      throw error;
    }
  }

  override async commit(
    ctx: Transaction,
    eventBroadcaster?: TransactionEventBroadcaster,
    loggerContext?: Parameters<Connection['commit']>[2],
  ): Promise<void> {
    const transaction = this.assertTransaction(ctx as YdbTransaction);
    if (transaction.busy) {
      throw new Error('Cannot commit a YDB transaction while a statement is in flight.');
    }
    transaction.busy = true;
    let commitStarted = false;
    try {
      await eventBroadcaster?.dispatchEvent(EventType.beforeTransactionCommit, transaction);
      commitStarted = true;
      const response = await this.rpc(() =>
        transaction.session.client.commitTransaction(
          { sessionId: transaction.session.id, txId: transaction.id },
          { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
        ),
      );
      this.checkOperation(response.operation);
      transaction.state = 'committed';
      this.logQuery('commit;', loggerContext);
    } catch (error) {
      if (commitStarted) {
        transaction.state = 'failed';
        transaction.session.invalid = true;
      }
      throw this.convert(error);
    } finally {
      transaction.busy = false;
      if (commitStarted) {
        this.#transactions.delete(transaction);
        await this.release(transaction.session);
      }
    }
    await eventBroadcaster?.dispatchEvent(EventType.afterTransactionCommit, transaction);
  }

  override async rollback(
    ctx: Transaction,
    eventBroadcaster?: TransactionEventBroadcaster,
    loggerContext?: Parameters<Connection['rollback']>[2],
  ): Promise<void> {
    const transaction = ctx as YdbTransaction;
    if (transaction.connection !== this || !this.#transactions.has(transaction)) {
      throw new Error('The YDB transaction is closed or belongs to another connection.');
    }
    if (transaction.busy) {
      throw new Error('Cannot roll back a YDB transaction while a statement is in flight.');
    }
    transaction.busy = true;
    let eventError: unknown;
    try {
      await eventBroadcaster?.dispatchEvent(EventType.beforeTransactionRollback, transaction);
    } catch (error) {
      // Rollback must still release the session when a subscriber fails.
      eventError = error;
    }
    try {
      const response = await this.rpc(() =>
        transaction.session.client.rollbackTransaction(
          { sessionId: transaction.session.id, txId: transaction.id },
          { signal: this.signal(this.settings().queryTimeoutMs ?? 30_000) },
        ),
      );
      this.checkOperation(response.operation);
      transaction.state = 'rolledBack';
      this.logQuery('rollback;', loggerContext);
    } catch (error) {
      transaction.state = 'failed';
      transaction.session.invalid = true;
      throw this.convert(error);
    } finally {
      transaction.busy = false;
      this.#transactions.delete(transaction);
      await this.release(transaction.session);
    }
    if (eventError) {
      throw eventError;
    }
    await eventBroadcaster?.dispatchEvent(EventType.afterTransactionRollback, transaction);
  }

  private assertTransaction(transaction: YdbTransaction): YdbTransaction {
    if (transaction?.connection !== this || transaction.state !== 'active' || !this.#transactions.has(transaction)) {
      throw new Error('The YDB transaction is closed, failed, or belongs to another connection.');
    }
    return transaction;
  }

  private async acquire(signal?: AbortSignal): Promise<Session> {
    const cancellation = this.signal(this.settings().queryTimeoutMs ?? 30_000, signal);
    const max = this.config.get('pool').max ?? 10;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error('YDB pool.max must be a positive integer.');
    }
    for (;;) {
      cancellation.throwIfAborted();
      if (this.#closing || !this.#driver) {
        throw new Error('YDB connection is closing.');
      }
      const idle = [...this.#sessions].find(session => !session.leased && !session.invalid);
      if (idle) {
        idle.leased = true;
        return idle;
      }
      if (this.#sessions.size + this.#creating < max) {
        this.#creating++;
        try {
          const response = await this.rpc(() => tableClient(this.#driver!).createSession({}, { signal: cancellation }));
          const result = this.unpack(response.operation, CreateSessionResultSchema);
          const node = new URL(result.sessionId).searchParams.get('node_id');
          const session: Session = {
            id: result.sessionId,
            client: tableClient(this.#driver!, node ? BigInt(node) : undefined),
            leased: true,
            invalid: false,
          };
          this.#sessions.add(session);
          return session;
        } catch (error) {
          throw this.convert(error);
        } finally {
          this.#creating--;
          this.wakeWaiters();
        }
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(cancellation.reason);
        };
        const cleanup = () => {
          this.#waiters.delete(wake);
          cancellation.removeEventListener('abort', abort);
        };
        this.#waiters.add(wake);
        cancellation.addEventListener('abort', abort, { once: true });
        if (cancellation.aborted) {
          abort();
        }
      });
    }
  }

  private async release(session: Session): Promise<void> {
    if (session.invalid || this.#closing) {
      await this.deleteSession(session);
    } else {
      session.leased = false;
    }
    this.wakeWaiters();
  }

  private async deleteSession(session: Session): Promise<void> {
    session.invalid = true;
    session.leased = false;
    this.#sessions.delete(session);
    await session.client
      .deleteSession({ sessionId: session.id }, { signal: AbortSignal.timeout(5_000) })
      .catch(() => undefined);
  }

  private wakeWaiters(): void {
    for (const wake of this.#waiters) {
      wake();
    }
  }

  private signal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  }

  private async rpc<T>(call: () => Promise<T>): Promise<T> {
    const promise = call();
    this.#rpcs.add(promise);
    try {
      return await promise;
    } finally {
      this.#rpcs.delete(promise);
    }
  }

  private checkOperation(operation?: Operation): asserts operation is Operation {
    if (!operation?.ready) {
      throw new Error('YDB returned an incomplete synchronous operation.');
    }
    if (operation.status !== Status.SUCCESS) {
      throw new YDBError(operation.status, operation.issues);
    }
  }

  private unpack<T extends DescMessage>(operation: Operation | undefined, schema: T): MessageShape<T> {
    this.checkOperation(operation);
    if (!operation.result) {
      throw new Error('YDB returned a successful operation without a result.');
    }
    return fromBinary(schema, operation.result.value);
  }

  private sessionFailed(error: unknown): boolean {
    return (
      error instanceof YDBError &&
      [Status.BAD_SESSION, Status.SESSION_EXPIRED, Status.SESSION_BUSY].includes(error.code)
    );
  }

  private sessionRejected(error: unknown): boolean {
    return error instanceof YDBError && [Status.BAD_SESSION, Status.SESSION_EXPIRED].includes(error.code);
  }

  private convert(error: unknown): Error {
    return this.#converter.convertException(error instanceof Error ? error : new Error(String(error)));
  }
}
