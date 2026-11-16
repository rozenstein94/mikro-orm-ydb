import { setTimeout as delay } from 'node:timers/promises';
import { DeadlockException, IsolationLevel } from '@mikro-orm/core';
import { Type_PrimitiveTypeId, type Type as YdbType } from '@ydbjs/api/value';
import { Int32, Utf8 } from '@ydbjs/value/primitive';
import {
  AbortedTransactionError,
  DefaultQueryCompiler,
  DialectAdapterBase,
  type AbortableOperationOptions,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type LimitNode,
  type MigrationLockOptions,
  type OffsetNode,
  type QueryCompiler,
  type QueryResult,
  type SchemaMetadata,
  type SelectQueryNode,
  type TableMetadata,
  type TransactionSettings,
  type TableNode,
  type WithNode,
} from 'kysely';
import { compileYdbBindings } from './YdbBindings.js';
import { type YdbConnection, type YdbTransaction } from './YdbConnection.js';
import { YdbJoinTransformer } from './YdbJoinTransformer.js';

/** Allows the MikroORM SQL connection to preserve its richer binding and result context. */
export type YdbQueryExecutor = (
  query: CompiledQuery,
  transaction?: YdbTransaction,
  signal?: AbortSignal,
) => Promise<QueryResult<unknown>>;

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`YDB requires a simple table or column identifier: ${value}`);
  }
  return `\`${value}\``;
}

/** YQL uses backtick identifiers; value placeholders remain positional until the binding layer. */
export class YdbQueryCompiler extends DefaultQueryCompiler {
  readonly #namedQueries = new Set<string>();

  override compileQuery(...args: Parameters<DefaultQueryCompiler['compileQuery']>): CompiledQuery {
    this.#namedQueries.clear();
    try {
      const [node, queryId] = args;
      return super.compileQuery(new YdbJoinTransformer().transformNode(node, queryId), queryId);
    } finally {
      this.#namedQueries.clear();
    }
  }

  protected override visitWith(node: WithNode): void {
    if (node.recursive) throw new Error('YDB named queries do not support recursive CTEs.');
    for (const expression of node.expressions) {
      const name = expression.name.table.table.identifier.name;
      identifier(name);
      if (expression.name.columns?.length || expression.materialized !== undefined) {
        throw new Error('YDB named queries do not support CTE column lists or materialization hints.');
      }
      if (!['SelectQueryNode', 'RawNode'].includes(expression.expression.kind)) {
        throw new Error('YDB named query prefixes must be read-only SELECT expressions.');
      }
      this.append(`$${name} = `);
      if (expression.expression.kind === 'RawNode') this.append('(');
      this.visitNode(expression.expression);
      if (expression.expression.kind === 'RawNode') this.append(')');
      this.append('; ');
      this.#namedQueries.add(name);
    }
  }

  protected override visitTable(node: TableNode): void {
    const name = node.table.identifier.name;
    const parent = this.parentNode?.kind;
    if (
      !node.table.schema &&
      this.#namedQueries.has(name) &&
      ['FromNode', 'JoinNode', 'AliasNode'].includes(parent ?? '')
    ) {
      this.append(`$${name}`);
      if (parent !== 'AliasNode') this.append(` as ${identifier(name)}`);
      return;
    }
    super.visitTable(node);
  }
  protected override getLeftIdentifierWrapper(): string {
    return '`';
  }
  protected override getRightIdentifierWrapper(): string {
    return '`';
  }
  protected override getCurrentParameterPlaceholder(): string {
    return '?';
  }
  protected override sanitizeIdentifier(value: string): string {
    identifier(value);
    return value;
  }

  protected override visitLimit(node: LimitNode): void {
    this.append('limit ');
    this.paginationValue(node.limit);
  }

  protected override visitOffset(node: OffsetNode): void {
    if (this.parentNode?.kind === 'SelectQueryNode' && !(this.parentNode as SelectQueryNode).limit) {
      this.append('limit 18446744073709551615ul ');
    }
    this.append('offset ');
    this.paginationValue(node.offset);
  }

  private paginationValue(node: LimitNode['limit']): void {
    if (node.kind !== 'ValueNode' || !('value' in node)) {
      this.visitNode(node);
      return;
    }
    const value = node.value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      this.append(String(value));
    } else if (typeof value === 'bigint' && value >= 0n && value < 1n << 64n) {
      this.append(`${value}ul`);
    } else {
      throw new Error('YDB limit and offset must be non-negative safe integers or Uint64 bigints.');
    }
  }
}

/** Recognizes top-level commands without mistaking strings or comments for RETURNING. */
function skipTrivia(sql: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i])) i++;
    if (sql.slice(i, i + 2) === '--') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.slice(i, i + 2) === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated YDB SQL comment.');
      i = end + 2;
    } else {
      return i;
    }
  }
}

/** Leading named queries are expressions, not independently committed statements. */
function namedQueryPrefixEnd(sql: string): number {
  let start = 0;
  for (;;) {
    const cursor = skipTrivia(sql, start);
    if (sql[cursor] !== '$') return start;
    const prefix = /^\$[A-Za-z_][A-Za-z0-9_]*\s*=\s*\(/.exec(sql.slice(cursor));
    if (!prefix) throw new Error('YDB named query prefixes require $identifier = (SELECT ...); syntax.');
    const bodyStart = cursor + prefix[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < sql.length && depth; i++) {
      const char = sql[i];
      if (sql.slice(i, i + 2) === '--' || sql.slice(i, i + 2) === '/*') {
        i = skipTrivia(sql, i) - 1;
      } else if (char === "'" || char === '"' || char === '`') {
        const quote = char;
        let closed = false;
        while (++i < sql.length) {
          if (sql[i] === '\\') {
            i++;
            continue;
          }
          if (sql[i] === quote) {
            if (sql[i + 1] === quote) {
              i++;
              continue;
            }
            closed = true;
            break;
          }
        }
        if (!closed) throw new Error('Unterminated literal in a YDB named query.');
      } else if (char === '(') {
        depth++;
      } else if (char === ')') {
        depth--;
      }
    }
    if (depth) throw new Error('Unterminated YDB named query expression.');
    const body = commandWords(sql.slice(bodyStart, i - 1)).words;
    if (body[0] !== 'SELECT') throw new Error('YDB named query prefixes must be read-only SELECT expressions.');
    const end = skipTrivia(sql, i);
    if (sql[end] !== ';') throw new Error('YDB named query prefixes must end with a semicolon.');
    start = end + 1;
  }
}

function commandWords(sql: string): { words: string[]; end: number } {
  const words: string[] = [];
  let depth = 0;
  let ended = false;
  let codeEnd = 0;
  for (let i = namedQueryPrefixEnd(sql); i < sql.length;) {
    const char = sql[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated YDB SQL comment.');
      i = end + 2;
      continue;
    }
    if (ended) throw new Error('The YDB Kysely connection executes one statement at a time.');
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated YDB SQL literal or identifier.');
      codeEnd = i;
      continue;
    }
    if (char === '(') {
      depth++;
      i++;
      codeEnd = i;
      continue;
    }
    if (char === ')') {
      depth--;
      i++;
      codeEnd = i;
      continue;
    }
    if (char === ';' && depth === 0) {
      ended = true;
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const token = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))![0];
      if (depth === 0) words.push(token.toUpperCase());
      i += token.length;
      codeEnd = i;
    } else {
      i++;
      codeEnd = i;
    }
  }
  return { words, end: codeEnd };
}

function defaultExecutor(native: YdbConnection): YdbQueryExecutor {
  return async (query, transaction, signal) => {
    signal?.throwIfAborted();
    const { words, end } = commandWords(query.sql);
    const command =
      words[0] === 'WITH'
        ? words.find(word => ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE'].includes(word))
        : words[0];
    if (['CREATE', 'ALTER', 'DROP'].includes(command ?? '')) {
      if (transaction) throw new Error('YDB DDL cannot execute inside a data transaction.');
      if (query.parameters.length) throw new Error('YDB DDL does not support positional value parameters.');
      await native.executeScheme(query.sql, signal);
      return { rows: [] };
    }
    const mutation = ['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'REPLACE'].includes(command ?? '');
    if (!mutation && command !== 'SELECT') {
      throw new Error('YDB Kysely execution supports SELECT, DML with RETURNING, and standalone DDL.');
    }
    // SQLDriver can omit RETURNING for assigned keys. Collect changed rows to
    // report the actual count, inserting the clause before trailing comments.
    const text =
      mutation && !words.includes('RETURNING')
        ? `${query.sql.slice(0, end)} RETURNING *${query.sql.slice(end)}`
        : query.sql;
    const bindings = compileYdbBindings(text, query.parameters);
    const ownTransaction = mutation && !transaction ? await native.begin() : undefined;
    try {
      const rows = await native.query(bindings.sql, bindings.parameters, transaction ?? ownTransaction, signal);
      // query() validates result completeness before a standalone mutation commits.
      if (ownTransaction) await native.commit(ownTransaction);
      return mutation ? { rows, numAffectedRows: BigInt(rows.length) } : { rows };
    } catch (error) {
      if (ownTransaction) await native.rollback(ownTransaction).catch(() => undefined);
      throw error;
    }
  };
}

/** A logical Kysely connection. An active transaction pins the native session. */
export class YdbKyselyConnection implements DatabaseConnection {
  #transaction?: YdbTransaction;
  #released = false;
  #transition = false;
  #executing = 0;

  get released(): boolean {
    return this.#released;
  }

  constructor(
    readonly native: YdbConnection,
    readonly executor: YdbQueryExecutor,
  ) {}

  async executeQuery<R>(query: CompiledQuery, options?: AbortableOperationOptions): Promise<QueryResult<R>> {
    this.assertUsable();
    options?.signal?.throwIfAborted();
    this.#executing++;
    try {
      return (await this.executor(query, this.#transaction, options?.signal)) as QueryResult<R>;
    } finally {
      this.#executing--;
    }
  }

  streamQuery<R>(
    _query: CompiledQuery,
    _chunkSize: number,
    _options?: AbortableOperationOptions,
  ): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(
      'The YDB Table API does not expose a streaming cursor; use bounded queries or the native streaming API.',
    );
  }

  async begin(settings: TransactionSettings): Promise<void> {
    this.assertUsable();
    this.assertIdle();
    if (this.#transaction) throw new Error('YDB does not support nested transactions or savepoints.');
    if (settings.isolationLevel && settings.isolationLevel !== 'serializable') {
      throw new Error('The YDB driver supports serializable transactions only.');
    }
    this.#transition = true;
    try {
      this.#transaction = await this.native.begin({
        isolationLevel: IsolationLevel.SERIALIZABLE,
        readOnly: settings.accessMode === 'read only',
      });
    } finally {
      this.#transition = false;
    }
  }

  async commit(): Promise<void> {
    this.assertUsable();
    this.assertIdle();
    const transaction = this.requireTransaction();
    this.#transition = true;
    let completed = false;
    try {
      await this.native.commit(transaction);
      completed = true;
    } catch (error) {
      if (error instanceof DeadlockException && !this.native.hasTransaction(transaction)) {
        const aborted = new AbortedTransactionError();
        aborted.cause = error;
        throw aborted;
      }
      throw error;
    } finally {
      // A preflight error (busy session or a failed statement) leaves the
      // native lease owned and still requires rollback before releasing it.
      if (completed || !this.native.hasTransaction(transaction)) this.#transaction = undefined;
      this.#transition = false;
    }
  }

  async rollback(): Promise<void> {
    this.assertUsable();
    this.assertIdle();
    const transaction = this.requireTransaction();
    this.#transition = true;
    let completed = false;
    try {
      await this.native.rollback(transaction);
      completed = true;
    } finally {
      if (completed || !this.native.hasTransaction(transaction)) this.#transaction = undefined;
      this.#transition = false;
    }
  }

  async release(): Promise<void> {
    if (this.#released) return;
    if (this.#transition) throw new Error('Cannot release a YDB connection while transaction control is in flight.');
    this.assertIdle();
    const transaction = this.#transaction;
    this.#transition = true;
    let completed = !transaction;
    try {
      if (transaction && this.native.hasTransaction(transaction)) await this.native.rollback(transaction);
      completed = true;
    } finally {
      if (completed || !transaction || !this.native.hasTransaction(transaction)) {
        this.#transaction = undefined;
        this.#released = true;
      }
      this.#transition = false;
    }
  }

  private requireTransaction(): YdbTransaction {
    if (!this.#transaction) throw new Error('This YDB Kysely connection has no active transaction.');
    return this.#transaction;
  }

  private assertUsable(): void {
    if (this.#released) throw new Error('This YDB Kysely connection has been released.');
    if (this.#transition) throw new Error('YDB transaction control is already in flight on this connection.');
  }

  private assertIdle(): void {
    if (this.#executing) throw new Error('Cannot change or release a YDB transaction while a statement is in flight.');
  }
}

/** Kysely owns logical handles; the native connection owns the bounded session pool. */
export class YdbKyselyDriver implements Driver {
  readonly #connections = new Set<YdbKyselyConnection>();
  #destroyed = false;

  constructor(
    readonly native: YdbConnection,
    readonly executor: YdbQueryExecutor,
  ) {}

  async init(options?: AbortableOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.assertUsable();
    await this.native.connect({ skipOnConnect: true });
    options?.signal?.throwIfAborted();
  }

  async acquireConnection(options?: AbortableOperationOptions): Promise<YdbKyselyConnection> {
    options?.signal?.throwIfAborted();
    this.assertUsable();
    const connection = new YdbKyselyConnection(this.native, this.executor);
    this.#connections.add(connection);
    return connection;
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    await this.connection(connection).begin(settings);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.connection(connection).commit();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.connection(connection).rollback();
  }

  async savepoint(): Promise<void> {
    throw new Error('YDB does not support savepoints.');
  }
  async rollbackToSavepoint(): Promise<void> {
    throw new Error('YDB does not support savepoints.');
  }
  async releaseSavepoint(): Promise<void> {
    throw new Error('YDB does not support savepoints.');
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const owned = this.connection(connection);
    try {
      await owned.release();
    } finally {
      if (owned.released) this.#connections.delete(owned);
    }
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const results = await Promise.allSettled([...this.#connections].map(connection => connection.release()));
    this.#connections.clear();
    await this.native.close();
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private connection(connection: DatabaseConnection): YdbKyselyConnection {
    this.assertUsable();
    if (!(connection instanceof YdbKyselyConnection) || !this.#connections.has(connection)) {
      throw new Error('The YDB Kysely connection is released or belongs to another driver.');
    }
    return connection;
  }

  private assertUsable(): void {
    if (this.#destroyed) throw new Error('The YDB Kysely driver has been destroyed.');
  }
}

class YdbDialectAdapter extends DialectAdapterBase {
  readonly #heldLocks = new Set<string>();
  constructor(readonly native: YdbConnection) {
    super();
  }
  override get supportsReturning(): boolean {
    return true;
  }
  override get supportsTransactionalDdl(): boolean {
    return false;
  }
  override get supportsMultipleConnections(): boolean {
    return true;
  }

  /** Atomic flag locking serializes nontransactional migrations; a crashed owner requires manual unlock. */
  override async acquireMigrationLock(_db: unknown, options: MigrationLockOptions): Promise<void> {
    if (options.lockTableSchema) throw new Error('YDB does not support SQL migration lock schemas.');
    const table = identifier(options.lockTable);
    const key = `${options.lockTable}:${options.lockRowId}`;
    if (this.#heldLocks.has(key)) throw new Error('This YDB migration lock is already held by the driver.');
    const parameters = { $id: new Utf8(options.lockRowId), $locked: new Int32(1), $unlocked: new Int32(0) };
    const deadline = Date.now() + 30_000;
    for (;;) {
      const transaction = await this.native.begin();
      try {
        const [row] = await this.native.query(
          `SELECT is_locked FROM ${table} WHERE id = $id`,
          { $id: parameters.$id },
          transaction,
        );
        if (!row) throw new Error(`YDB migration lock row ${options.lockRowId} is missing.`);
        if (Number(row.is_locked) === 0) {
          await this.native.query(
            `UPDATE ${table} SET is_locked = $locked WHERE id = $id`,
            { $id: parameters.$id, $locked: parameters.$locked },
            transaction,
          );
          await this.native.commit(transaction);
          this.#heldLocks.add(key);
          return;
        }
        await this.native.rollback(transaction);
      } catch (error) {
        await this.native.rollback(transaction).catch(() => undefined);
        if (!(error instanceof DeadlockException)) throw error;
      }
      if (Date.now() >= deadline)
        throw new Error(`Timed out acquiring the YDB migration lock ${key}; inspect a possible stale migration owner.`);
      await delay(100);
    }
  }

  override async releaseMigrationLock(_db: unknown, options: MigrationLockOptions): Promise<void> {
    const key = `${options.lockTable}:${options.lockRowId}`;
    if (!this.#heldLocks.has(key)) throw new Error('This YDB migration lock is not held by the driver.');
    await this.native.query(`UPDATE ${identifier(options.lockTable)} SET is_locked = $unlocked WHERE id = $id`, {
      $id: new Utf8(options.lockRowId),
      $unlocked: new Int32(0),
    });
    this.#heldLocks.delete(key);
  }
}

function typeName(type?: YdbType): string {
  if (!type) throw new Error('YDB introspection returned a column without a type.');
  if (type.type.case === 'optionalType') return typeName(type.type.value.item);
  if (type.type.case === 'decimalType') return `Decimal(${type.type.value.precision},${type.type.value.scale})`;
  if (type.type.case !== 'typeId') throw new Error(`YDB introspection does not support column type ${type.type.case}.`);
  const name = Type_PrimitiveTypeId[type.type.value];
  const canonical: Record<string, string> = {
    UTF8: 'Utf8',
    STRING: 'String',
    BOOL: 'Bool',
    JSON: 'Json',
    JSON_DOCUMENT: 'JsonDocument',
    YSON: 'Yson',
    UUID: 'Uuid',
    DYNUMBER: 'DyNumber',
  };
  return canonical[name] ?? name[0] + name.slice(1).toLowerCase();
}

class YdbIntrospector implements DatabaseIntrospector {
  constructor(readonly native: YdbConnection) {}
  async getSchemas(): Promise<SchemaMetadata[]> {
    return [];
  }

  async getTables(options: DatabaseMetadataOptions = { withInternalKyselyTables: false }): Promise<TableMetadata[]> {
    const names = await this.native.listTables();
    const filtered = options.withInternalKyselyTables
      ? names
      : names.filter(name => !['kysely_migration', 'kysely_migration_lock'].includes(name));
    return Promise.all(
      filtered.map(async name => {
        const table = await this.native.describeTable(name);
        if (!table)
          throw new Error(`YDB table ${name} disappeared during introspection; retry after schema changes finish.`);
        return {
          name,
          isView: false,
          isForeign: false,
          columns: table.columns.map(column => ({
            name: column.name,
            dataType: typeName(column.type),
            isAutoIncrementing: column.defaultValue.case === 'fromSequence',
            isNullable: column.notNull === undefined ? column.type?.type.case === 'optionalType' : !column.notNull,
            hasDefaultValue: column.defaultValue.case !== undefined,
          })),
        };
      }),
    );
  }
}

/** Native YQL Kysely dialect shared by MikroORM's complete SQL driver surface. */
export class YdbDialect implements Dialect {
  readonly #executor: YdbQueryExecutor;
  constructor(
    readonly native: YdbConnection,
    executor?: YdbQueryExecutor,
  ) {
    this.#executor = executor ?? defaultExecutor(native);
  }
  createDriver(): Driver {
    return new YdbKyselyDriver(this.native, this.#executor);
  }
  createQueryCompiler(): QueryCompiler {
    return new YdbQueryCompiler();
  }
  createAdapter(): DialectAdapter {
    return new YdbDialectAdapter(this.native);
  }
  createIntrospector(): DatabaseIntrospector {
    return new YdbIntrospector(this.native);
  }
}
