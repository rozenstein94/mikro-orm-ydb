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
  type EntityMetadata,
  type EntityProperty,
  type FindOptions,
  type PopulateOptions,
  ReferenceKind,
  QueryFlag,
  type ConnectionType,
  type Transaction,
  type LoggingOptions,
} from '@mikro-orm/core';
import { Kysely } from 'kysely';
import {
  AbstractSqlDriver,
  Kysely as SqlKysely,
  type QBFilterQuery,
  type AnyQueryBuilder,
  type InternalField,
  type SqlEntityManager,
} from '@mikro-orm/sql';
import { YdbSqlConnection } from './YdbSqlConnection.js';
import { YdbSqlPlatform } from './YdbSqlPlatform.js';
import { withYdbJoinedFilters } from './YdbJoinedFilters.js';

/** Components created for one ORM instance. `driverOptions` remains reserved for native SDK options. */
export interface YdbSqlDriverComponents {
  readonly platform?: YdbSqlPlatform;
  readonly connection?: new (...args: ConstructorParameters<typeof YdbSqlConnection>) => YdbSqlConnection;
}

/** Native YDB implementation of the MikroORM v7 SQL driver contracts. */
export class YdbSqlDriver extends AbstractSqlDriver<YdbSqlConnection, YdbSqlPlatform> {
  constructor(config: Configuration, components: YdbSqlDriverComponents = {}) {
    super(config, components.platform ?? new YdbSqlPlatform(), components.connection ?? YdbSqlConnection, [
      '@ydbjs/core',
      'kysely',
    ]);
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
    this.platform.setMetadata(metadata);
    const native = this.connection.getYdbConnection();
    native.setMetadata(metadata);
    native.setPlatform(this.platform);
  }

  override createQueryBuilder<T extends object>(
    entityName: EntityName<T> | AnyQueryBuilder<T>,
    ctx?: Transaction,
    preferredConnectionType?: ConnectionType,
    convertCustomTypes?: boolean,
    loggerContext?: LoggingOptions,
    alias?: string,
    em?: SqlEntityManager,
  ): AnyQueryBuilder<T> {
    return withYdbJoinedFilters(
      super.createQueryBuilder(entityName, ctx, preferredConnectionType, convertCustomTypes, loggerContext, alias, em),
    );
  }

  private getSharedForeignKey(meta: EntityMetadata, prop: EntityProperty): EntityProperty | undefined {
    if (
      prop.persist !== false ||
      prop.kind !== ReferenceKind.MANY_TO_ONE ||
      !prop.formula ||
      prop.embedded ||
      prop.fieldNames?.length !== 1 ||
      !prop.targetMeta
    )
      return;
    const targetMeta = prop.targetMeta;
    return meta.props.find(
      stored =>
        stored.persist !== false &&
        stored.kind === ReferenceKind.MANY_TO_ONE &&
        stored.mapToPk &&
        !stored.formula &&
        stored.fieldNames?.length === 1 &&
        stored.fieldNames[0] === prop.fieldNames[0] &&
        stored.targetMeta?.root === targetMeta.root &&
        stored.targetKey === prop.targetKey &&
        stored.referencedColumnNames[0] === prop.referencedColumnNames[0],
    );
  }

  protected override shouldHaveColumn<T, U>(
    meta: EntityMetadata<T>,
    prop: EntityProperty<U>,
    populate: readonly PopulateOptions<U>[],
    fields?: readonly InternalField<U>[],
    exclude?: readonly InternalField<U>[],
  ): boolean {
    if (!super.shouldHaveColumn(meta, prop, populate, fields, exclude)) return false;
    const stored = this.getSharedForeignKey(meta, prop);
    // Joined aliases share the same physical output column; retain the alias when the stored property is absent.
    return !stored || !super.shouldHaveColumn(meta, stored, populate, fields, exclude);
  }

  protected override buildFields<T extends object>(
    meta: EntityMetadata<T>,
    populate: PopulateOptions<T>[],
    joinedProps: PopulateOptions<T>[],
    qb: AnyQueryBuilder<T>,
    alias: string,
    options: Pick<FindOptions<T, any, any, any>, 'strategy' | 'fields' | 'exclude' | 'flags'>,
    schema?: string,
  ): InternalField<T>[] {
    if (!meta.props.some(prop => this.getSharedForeignKey(meta, prop))) {
      return super.buildFields(meta, populate, joinedProps, qb, alias, options, schema);
    }
    const normalized = options.fields ? this.normalizeFields(options.fields as InternalField<T>[]) : undefined;
    const isRootWildcard = (field: string) => field === '*' || field === `${alias}.*`;
    if (!normalized || normalized.some(isRootWildcard)) {
      // A wildcard makes core QueryBuilder append virtual formulas later. Select metadata fields explicitly
      // so the physical FK is emitted once, while independent formulas and nested selections remain intact.
      const exclude = options.exclude ? [...options.exclude] : undefined;
      const formulaPopulate = options.flags?.includes(QueryFlag.INCLUDE_LAZY_FORMULAS)
        ? true
        : normalized
          ? []
          : populate;
      const projection = meta.props
        .filter(
          prop =>
            this.platform.shouldHaveColumn(prop, normalized ? true : populate, exclude, false, false) ||
            (prop.formula && this.platform.shouldHaveColumn(prop, formulaPopulate, exclude)),
        )
        .map(prop => prop.name);
      const fields = normalized?.flatMap(field => (isRootWildcard(field) ? projection : [field])) ?? projection;
      options = { ...options, fields: fields as typeof options.fields };
    }
    const fields = super.buildFields(meta, populate, joinedProps, qb, alias, options, schema);
    return fields.filter(field => {
      if (typeof field !== 'string') return true;
      const prop = meta.props.find(prop => prop.name === field);
      const stored = prop && this.getSharedForeignKey(meta, prop);
      return !stored || !fields.includes(stored.name);
    });
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
