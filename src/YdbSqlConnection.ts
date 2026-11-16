import {
  type Dictionary,
  isRaw,
  raw,
  type RawQueryFragment,
  type QueryResult,
  type EntityData,
  type AnyEntity,
  type Transaction,
  type LoggingOptions,
} from '@mikro-orm/core';
import { AbstractSqlConnection, NativeQueryBuilder } from '@mikro-orm/sql';
import { CompiledQuery, Kysely } from 'kysely';
import { YdbConnection } from './YdbConnection.js';
import { YdbDialect } from './YdbDialect.js';

/** Retains typed parameter binding instead of interpolating SQL before calling Kysely. */
export class YdbSqlConnection extends AbstractSqlConnection {
  #native?: YdbConnection;
  getYdbConnection(): YdbConnection {
    this.#native ??= new YdbConnection(this.config, this.options, this.type);
    return this.#native;
  }
  override createKysely(): void | Promise<void> {
    let options = this.options.driverOptions ?? this.config.get('driverOptions');
    if (typeof options === 'function') options = options();
    if (
      options instanceof Kysely ||
      (options && typeof options === 'object' && ('createDriver' in options || 'getExecutor' in options))
    ) {
      throw new Error('External Kysely instances or dialects are unsupported; pass native YDB SDK options.');
    }
    this.options.driverOptions = options;
    return super.createKysely();
  }
  override async close(force?: boolean): Promise<void> {
    try {
      await super.close(force);
    } finally {
      await this.#native?.close(force);
      this.#native = undefined;
    }
  }
  override createKyselyDialect(_overrides: Dictionary): YdbDialect {
    return new YdbDialect(this.getYdbConnection());
  }
  override async connect(options?: { skipOnConnect?: boolean }): Promise<void> {
    await this.initClient();
    await this.getYdbConnection().connect({ skipOnConnect: true });
    this.connected = true;
    if (!options?.skipOnConnect) await this.onConnect();
  }
  override async checkConnection() {
    return this.getYdbConnection().checkConnection();
  }
  override async getNativeClient() {
    await this.ensureConnection();
    return this.getYdbConnection().getNativeClient();
  }
  override async execute<
    T extends QueryResult | EntityData<AnyEntity> | EntityData<AnyEntity>[] = EntityData<AnyEntity>[],
  >(
    query: string | NativeQueryBuilder | RawQueryFragment,
    params: readonly unknown[] | Dictionary<unknown> = [],
    method: 'all' | 'get' | 'run' = 'all',
    ctx?: Transaction,
    loggerContext?: LoggingOptions,
  ): Promise<T> {
    const context = loggerContext as LoggingOptions & { signal?: AbortSignal; inflightQueryAbortStrategy?: string };
    context?.signal?.throwIfAborted();
    if (context?.inflightQueryAbortStrategy && context.inflightQueryAbortStrategy !== 'ignore query') {
      throw new Error('YDB SQL does not support SQL session cancellation strategies; use signal to cancel the RPC.');
    }
    await this.ensureConnection();
    if (query instanceof NativeQueryBuilder) query = query.toRaw();
    if (typeof query === 'string' && !Array.isArray(params))
      query = raw<RawQueryFragment>(query, params as Dictionary<unknown>);
    if (isRaw(query)) {
      params = query.params;
      query = query.sql;
    }
    const text = this.config.get('onQuery')(query as string, params as readonly unknown[]);
    const native = this.getYdbConnection();
    const drop = /^\s*drop\s+table\s+if\s+exists\s+`((?:``|[^`])+)`\s*;?\s*$/i.exec(text);
    if (/^\s*(?:create|alter|drop)\b/i.test(text)) {
      if (ctx)
        throw new Error(
          'YDB schema changes cannot run inside a transaction. Set migrations.transactional and allOrNothing to false.',
        );
      if ((params as readonly unknown[]).length) throw new Error('YDB DDL does not accept positional parameters.');
      if (drop) {
        const table = drop[1].replaceAll('``', '`');
        if (await native.describeTable(table))
          await native.executeScheme(`drop table ${this.platform.quoteIdentifier(table)}`, context?.signal);
      } else await native.executeScheme(text, context?.signal);
      return (method === 'all' ? [] : method === 'get' ? undefined : { affectedRows: 0, rows: [] }) as unknown as T;
    }
    const res = await (ctx ?? this.getClient()).executeQuery(
      CompiledQuery.raw(text, [...(params as readonly unknown[])]),
      context?.signal ? { signal: context.signal } : undefined,
    );
    // SQL QueryBuilder.getCount() coerces this well-known aggregate alias with unary +.
    // Keep the decimal representation exact, as PostgreSQL does for bigint counts.
    for (const row of res.rows as Dictionary[]) {
      if (typeof row.count === 'bigint') row.count = row.count.toString();
    }
    return this.transformRawResult<T>(res, method);
  }
  override async executeDump(dump: string): Promise<void> {
    await this.execute(dump, [], 'run');
  }
}
