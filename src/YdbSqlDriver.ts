import {
  type Configuration,
  type DeleteOptions,
  type EntityName,
  type EntityDictionary,
  type NativeInsertUpdateManyOptions,
  type NativeInsertUpdateOptions,
  type UpsertOptions,
  type UpsertManyOptions,
  type Primary,
  type RequiredEntityData,
  type FilterQuery,
  type MetadataStorage,
  type QueryResult,
} from '@mikro-orm/core';
import { Kysely } from 'kysely';
import { AbstractSqlDriver, Kysely as SqlKysely, type QBFilterQuery } from '@mikro-orm/sql';
import { YdbSqlConnection } from './YdbSqlConnection.js';
import { YdbSqlPlatform } from './YdbSqlPlatform.js';

/** Native YDB implementation of the MikroORM v7 SQL driver contracts. */
export class YdbSqlDriver extends AbstractSqlDriver<YdbSqlConnection, YdbSqlPlatform> {
  constructor(config: Configuration) {
    super(config, new YdbSqlPlatform(), YdbSqlConnection, ['@ydbjs/core', 'kysely']);
    if (!Object.is(Kysely, SqlKysely))
      throw new Error(
        'YDB SQL requires one shared Kysely runtime with @mikro-orm/sql. Install the Kysely version used by @mikro-orm/sql and deduplicate the dependency tree.',
      );
    const driverOptions = config.get('driverOptions');
    if (
      driverOptions instanceof Kysely ||
      (driverOptions && typeof driverOptions === 'object' && 'createDriver' in driverOptions)
    )
      throw new Error(
        'Pass native YDB SDK options to this driver; external Kysely instances or dialects have separate ownership and are unsupported.',
      );
    if (config.get('replicas')?.length)
      throw new Error('YDB manages its topology; MikroORM read replicas are unsupported.');
  }
  override setMetadata(metadata: MetadataStorage): void {
    super.setMetadata(metadata);
    const native = this.connection.getYdbConnection();
    native.setMetadata(metadata);
    native.setPlatform(this.platform);
  }
  override async nativeInsertMany<T extends object>(
    entityName: EntityName<T>,
    data: EntityDictionary<T>[],
    options: NativeInsertUpdateManyOptions<T> = {},
    transform?: (sql: string) => string,
  ): Promise<QueryResult<T>> {
    if (transform) {
      throw new Error('YDB nativeInsertMany SQL transforms are not supported; use QueryBuilder for INSERT SELECT');
    }
    if (!data.length) {
      return { affectedRows: 0, insertId: 0 as Primary<T>, insertedIds: [], rows: [] };
    }
    if (!options.ctx)
      return this.connection.transactional(ctx => this.nativeInsertMany(entityName, data, { ...options, ctx }));
    options = { convertCustomTypes: true, processCollections: true, ...options };
    const discovered = this.metadata.get(entityName);
    const meta = discovered.inheritanceType === 'tpt' ? discovered : discovered.root;
    const collections = options.processCollections ? data.map(row => this.extractManyToMany(meta, row)) : [];
    const qb = this.createQueryBuilder(
      entityName,
      options.ctx,
      'write',
      options.convertCustomTypes,
      options.loggerContext,
    ).withSchema(this.getSchemaName(meta, options));
    qb.setAbortOptions({ signal: options.signal, inflightQueryAbortStrategy: options.inflightQueryAbortStrategy });
    // QueryBuilderHelper.processData handles arrays at runtime; its public insert signature models one row.
    const res = await this.rethrow(qb.insert(data as unknown as RequiredEntityData<T>).execute('run', false));
    const primaryKeys = this.resolveInsertedPrimaryKeys(meta, data, res);
    for (let i = 0; i < collections.length; i++) {
      await this.processManyToMany(meta, primaryKeys[i], collections[i], false, options);
    }
    return res;
  }

  override async nativeInsert<T extends object>(
    entityName: EntityName<T>,
    data: EntityDictionary<T>,
    options: NativeInsertUpdateOptions<T> = {},
  ): Promise<QueryResult<T>> {
    return options.ctx
      ? super.nativeInsert(entityName, data, options)
      : this.connection.transactional(ctx => super.nativeInsert(entityName, data, { ...options, ctx }));
  }
  override async nativeUpdate<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    data: EntityDictionary<T>,
    options: NativeInsertUpdateOptions<T> & UpsertOptions<T> = {},
  ): Promise<QueryResult<T>> {
    return options.ctx
      ? super.nativeUpdate(entityName, where, data, options)
      : this.connection.transactional(ctx => super.nativeUpdate(entityName, where, data, { ...options, ctx }));
  }
  override async nativeUpdateMany<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>[],
    data: EntityDictionary<T>[],
    options: NativeInsertUpdateManyOptions<T> & UpsertManyOptions<T> = {},
    transform?: (sql: string, params: unknown[]) => string,
  ): Promise<QueryResult<T>> {
    if (transform) throw new Error('YDB nativeUpdateMany SQL transforms are unsupported; use QueryBuilder.');
    if (!data.length) return { affectedRows: 0, insertId: 0 as Primary<T>, rows: [] };
    if (!options.ctx)
      return this.connection.transactional(ctx => this.nativeUpdateMany(entityName, where, data, { ...options, ctx }));
    if (options.upsert) return super.nativeUpdateMany(entityName, where, data, options);
    if (where.length !== data.length) throw new Error('YDB nativeUpdateMany requires a condition for every row.');
    const results: QueryResult<T>[] = [];
    for (let i = 0; i < data.length; i++)
      results.push(await super.nativeUpdate(entityName, where[i], data[i], options));
    return {
      insertId: 0 as Primary<T>,
      affectedRows: results.reduce((sum, result) => sum + result.affectedRows, 0),
      rows: results.flatMap(result => result.rows ?? []),
    };
  }
  override async nativeDelete<T extends object>(
    entityName: EntityName<T>,
    where: FilterQuery<T>,
    options: DeleteOptions<T> = {},
  ): Promise<QueryResult<T>> {
    options.signal?.throwIfAborted();
    const meta = this.metadata.get(entityName);
    const pivots = [...this.metadata].filter(m => m.pivotTable && m.props.some(p => p.targetMeta?.root === meta.root));
    if (!pivots.length) return super.nativeDelete(entityName, where, options);
    const remove = async (ctx: NonNullable<typeof options.ctx>): Promise<QueryResult<T>> => {
      const qb = this.createQueryBuilder(entityName, ctx);
      qb.setAbortOptions({ signal: options.signal, inflightQueryAbortStrategy: options.inflightQueryAbortStrategy });
      const rows = await qb
        .select(meta.primaryKeys)
        .where(where as QBFilterQuery<T>)
        .execute('all', false);
      for (const pivot of pivots) {
        for (const prop of pivot.props.filter(p => p.targetMeta?.root === meta.root)) {
          if (!rows.length) continue;
          const conditions = rows.map(row =>
            Object.fromEntries(prop.fieldNames.map((field, i) => [field, row[prop.referencedColumnNames[i]]])),
          );
          await super.nativeDelete(pivot.class, { $or: conditions }, { ...options, ctx });
        }
      }
      return super.nativeDelete(entityName, where, { ...options, ctx });
    };
    return options.ctx ? remove(options.ctx) : this.connection.transactional(remove);
  }
}
