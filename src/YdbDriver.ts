import {
  DatabaseDriver,
  type Configuration,
  type CountOptions,
  type DeleteOptions,
  type Dictionary,
  type EntityData,
  type EntityDictionary,
  type EntityMetadata,
  type EntityName,
  type FilterQuery,
  type FindOneOptions,
  type FindOptions,
  type NativeInsertUpdateManyOptions,
  type NativeInsertUpdateOptions,
  type Primary,
  type QueryResult,
  type StreamOptions,
  Utils,
} from '@mikro-orm/core';
import { YdbConnection, type YdbTransaction } from './YdbConnection.js';
import { YdbPlatform } from './YdbPlatform.js';
import { YqlQuery } from './YqlQuery.js';

/** A native YQL core driver preserving MikroORM's EntityManager and Unit of Work. */
export class YdbDriver extends DatabaseDriver<YdbConnection> {
  protected override readonly connection = new YdbConnection(this.config);
  protected override readonly platform = new YdbPlatform();

  constructor(config: Configuration) {
    super(config, ['@ydbjs/core', '@ydbjs/api', '@ydbjs/value']);
    if (config.get('replicas')?.length)
      throw new Error('YDB driver does not support MikroORM read replicas; YDB manages its own topology.');
  }

  override getPlatform(): YdbPlatform {
    return this.platform;
  }

  async find<T extends object, P extends string = never, F extends string = never, E extends string = never>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    options: FindOptions<T, P, F, E> = {},
  ): Promise<EntityData<T>[]> {
    this.validateOptions(options);
    const meta = this.metadata.get(entityName);
    const compiler = new YqlQuery(meta, this.platform);
    const fields = this.fields(
      meta,
      options.fields as string[] | undefined,
      options.exclude as string[] | undefined,
      options.populate,
    );
    const filter = compiler.where(where);
    const sql = `SELECT ${fields.map(p => this.platform.quoteIdentifier(p.fieldNames[0])).join(', ')} FROM ${this.platform.quoteIdentifier(meta.tableName)} WHERE ${filter}${compiler.orderBy(options.orderBy)}${compiler.pagination(options.limit, options.offset)}`;
    const rows = await this.connection.query(sql, compiler.parameters, options.ctx as YdbTransaction, options.signal);
    return rows.map(row => this.mapResult<T>(this.normalizeResult(meta, row) as EntityDictionary<T>, meta)!);
  }

  async findOne<T extends object, P extends string = never, F extends string = never, E extends string = never>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    options: FindOneOptions<T, P, F, E> = {},
  ): Promise<EntityData<T> | null> {
    const rows = await this.find(entityName, where, { ...options, limit: 1 } as FindOptions<T, P, F, E>);
    return rows[0] ?? null;
  }

  async count<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    options: CountOptions<T> = {},
  ): Promise<number> {
    this.validateOptions(options);
    return this.countRows(this.metadata.get(entityName), where, options.ctx as YdbTransaction, options.signal);
  }

  private async countRows(
    meta: EntityMetadata,
    where: unknown,
    ctx?: YdbTransaction,
    signal?: AbortSignal,
  ): Promise<number> {
    const compiler = new YqlQuery(meta, this.platform);
    const filter = compiler.where(where);
    const [row] = await this.connection.query(
      `SELECT COUNT(*) AS count FROM ${this.platform.quoteIdentifier(meta.tableName)} WHERE ${filter}`,
      compiler.parameters,
      ctx,
      signal,
    );
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('YDB count exceeds the JavaScript safe integer range');
    return count;
  }

  async nativeInsert<T extends object>(
    entityName: EntityName<T>,
    data: EntityDictionary<T>,
    options: NativeInsertUpdateOptions<T> = {},
  ): Promise<QueryResult<T>> {
    return this.nativeInsertMany(entityName, [data], options);
  }

  async nativeInsertMany<T extends object>(
    entityName: EntityName<T>,
    data: EntityDictionary<T>[],
    options: NativeInsertUpdateManyOptions<T> = {},
  ): Promise<QueryResult<T>> {
    this.validateOptions(options);
    const meta = this.metadata.get(entityName);
    const rows: Dictionary[] = [];
    // Validate the complete batch before opening a transaction or writing its first row.
    const queries = data.map(item => {
      const compiler = new YqlQuery(meta, this.platform);
      const entries = compiler.data(item, options.convertCustomTypes ?? true);
      for (const prop of this.platform.columnProperties(meta)) {
        if (!entries.some(([p]) => p === prop) && !prop.nullable) {
          throw new Error(
            `YDB insert requires ${meta.className}.${prop.name}; use an application default or supply the value`,
          );
        }
      }
      const columns = entries.map(([p]) => this.platform.quoteIdentifier(p.fieldNames[0]));
      const values = entries.map(([p, value]) => compiler.bind(p, value));
      rows.push(Object.fromEntries(entries.filter(([p]) => p.primary).map(([p, value]) => [p.fieldNames[0], value])));
      return {
        sql: `INSERT INTO ${this.platform.quoteIdentifier(meta.tableName)} (${columns.join(', ')}) VALUES (${values.join(', ')})`,
        parameters: compiler.parameters,
      };
    });
    if (queries.length) {
      await this.inTransaction(options.ctx, async ctx => {
        for (const query of queries) await this.connection.query(query.sql, query.parameters, ctx, options.signal);
      });
    }
    return {
      affectedRows: data.length,
      insertId: this.primaryKey(meta, data[0]) as Primary<T>,
      insertedIds: data.map(row => this.primaryKey(meta, row) as Primary<T>),
      rows,
    };
  }

  async nativeUpdate<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    data: EntityDictionary<T>,
    options: NativeInsertUpdateOptions<T> = {},
  ): Promise<QueryResult<T>> {
    this.validateOptions(options);
    const meta = this.metadata.get(entityName);
    const compiler = new YqlQuery(meta, this.platform);
    const entries = compiler.data(data, options.convertCustomTypes ?? true);
    if (entries.some(([p]) => p.primary))
      throw new Error('YDB cannot update primary key columns; delete and insert explicitly');
    const assignments = entries.map(
      ([p, value]) => `${this.platform.quoteIdentifier(p.fieldNames[0])} = ${compiler.bind(p, value)}`,
    );
    const filter = compiler.where(where);
    if (!assignments.length) return { affectedRows: 0, insertId: 0 as Primary<T> };
    const affectedRows = await this.inTransaction(options.ctx, async ctx => {
      const count = await this.countRows(meta, where, ctx, options.signal);
      if (count)
        await this.connection.query(
          `UPDATE ${this.platform.quoteIdentifier(meta.tableName)} SET ${assignments.join(', ')} WHERE ${filter}`,
          compiler.parameters,
          ctx,
          options.signal,
        );
      return count;
    });
    return { affectedRows, insertId: 0 as Primary<T> };
  }

  async nativeDelete<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    options: DeleteOptions<T> = {},
  ): Promise<QueryResult<T>> {
    this.validateOptions(options);
    const meta = this.metadata.get(entityName);
    const compiler = new YqlQuery(meta, this.platform);
    const filter = compiler.where(where);
    const affectedRows = await this.inTransaction(options.ctx, async ctx => {
      const count = await this.countRows(meta, where, ctx, options.signal);
      if (count)
        await this.connection.query(
          `DELETE FROM ${this.platform.quoteIdentifier(meta.tableName)} WHERE ${filter}`,
          compiler.parameters,
          ctx,
          options.signal,
        );
      return count;
    });
    return { affectedRows, insertId: 0 as Primary<T> };
  }

  private async inTransaction<T>(
    ctx: YdbTransaction | undefined,
    callback: (ctx: YdbTransaction) => Promise<T>,
  ): Promise<T> {
    if (ctx) return callback(ctx as YdbTransaction);
    return this.connection.transactional(callback);
  }

  /** Core streaming is explicitly rejected instead of buffering an unbounded table. */
  stream<T extends object>(
    _entityName: EntityName<T>,
    _where: FilterQuery<T>,
    _options: StreamOptions<T, any, any, any> & { rawResults?: boolean },
  ): AsyncIterableIterator<T> {
    throw new Error('YDB driver does not support EntityManager streaming; use bounded find() pages or the native SDK');
  }

  private primaryKey(meta: EntityMetadata, data?: Dictionary): unknown {
    if (!data) return 0;
    const keys = meta.primaryKeys.map(key => data[key]);
    return meta.compositePK ? keys : keys[0];
  }

  private fields(meta: EntityMetadata, requested?: string[], excluded?: string[], populate?: unknown) {
    const columns = this.platform.columnProperties(meta);
    let fields = columns.filter(prop => !prop.lazy);
    if (requested?.length) {
      const compiler = new YqlQuery(meta, this.platform);
      const explicit = requested
        .filter(name => name !== '*')
        .filter(name => !meta.properties[name]?.targetMeta || columns.includes(meta.properties[name]))
        .map(name => compiler.field(name));
      fields = requested.includes('*') ? [...fields, ...explicit] : explicit;
    }
    const hints = Utils.asArray(populate ?? []) as (string | { field: string; all?: boolean })[];
    fields.push(
      ...columns.filter(
        prop =>
          prop.lazy &&
          hints.some(hint =>
            typeof hint === 'string' ? hint === prop.name || hint === '*' : hint.field === prop.name || hint.all,
          ),
      ),
    );
    if (excluded?.length) {
      for (const name of excluded) {
        if (!meta.properties[name]) throw new Error(`Unknown YDB excluded property ${name}`);
      }
      fields = fields.filter(p => !excluded.includes(p.name));
    }
    return Utils.unique([...meta.getPrimaryProps(), ...fields]);
  }

  private normalizeResult(meta: EntityMetadata, row: Dictionary): Dictionary {
    for (const prop of this.platform.columnProperties(meta)) {
      const key = prop.fieldNames[0];
      if (row[key] instanceof Uint8Array && this.platform.getYdbType(prop) === 'String')
        row[key] = Buffer.from(row[key]);
    }
    return row;
  }

  private validateOptions(options: object): void {
    const unsupported = [
      '_partitionLimit',
      'schema',
      'lockMode',
      'lockTableAliases',
      'groupBy',
      'having',
      'indexHint',
      'collation',
      'using',
      'first',
      'last',
      'before',
      'after',
      'onConflictFields',
      'onConflictAction',
      'onConflictMergeFields',
      'onConflictExcludeFields',
      'upsert',
      'returning',
      'inflightQueryAbortStrategy',
    ];
    const opts = options as Dictionary;
    for (const key of unsupported) {
      if (opts[key] != null && opts[key] !== false) throw new Error(`YDB driver does not support option ${key}`);
    }
    if (opts.strategy != null && opts.strategy !== 'select-in')
      throw new Error('YDB driver supports select-in loading only');
    if (opts.flags?.length) throw new Error('YDB driver does not support SQL query flags');
  }
}
