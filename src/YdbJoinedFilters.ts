import { type Dictionary, isRaw, isSubquery, RawQueryFragment, Utils } from '@mikro-orm/core';
import {
  type AnyQueryBuilder,
  type JoinOptions,
  JoinType,
  type NativeQueryBuilder,
  QueryBuilder,
  QueryType,
} from '@mikro-orm/sql';
import { YdbNativeQueryBuilder } from './YdbNativeQueryBuilder.js';

interface Compilation {
  reserved: Set<string>;
  filters: { name: string; query: NativeQueryBuilder }[];
  next: number;
}

// Query compilation is synchronous. Pagination/count clones share declarations with the outer statement.
let compilation: Compilation | undefined;
const builders = new WeakSet<object>();
const helpers = new WeakSet<object>();
const filteredQueries = new WeakSet<object>();

function checkEmbedding(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  // Some core APIs retain a live source and infer its projection later (e.g. insertFrom).
  // Inspect a clone so this validation cannot finalize or change that source.
  const inspected = value instanceof QueryBuilder ? value.clone().getNativeQuery() : value;
  if (filteredQueries.has(value) || filteredQueries.has(inspected)) {
    throw new Error(
      'YDB filtered ORM subqueries cannot be embedded eagerly; execute them as standalone queries or use a structured Kysely query.',
    );
  }
  if (Array.isArray(value)) value.forEach(item => checkEmbedding(item, seen));
  else if (Utils.isPlainObject(value)) Object.values(value).forEach(item => checkEmbedding(item, seen));
}

function guardEagerEmbedding<T extends object>(qb: AnyQueryBuilder<T>): void {
  // Core compiles these arguments to SQL eagerly, before the owning statement exists.
  // Reject a filtered ORM source while it still has provenance, rather than extracting SQL text.
  for (const name of [
    'where',
    'having',
    'with',
    'withRecursive',
    'from',
    'join',
    'innerJoin',
    'leftJoin',
    'joinAndSelect',
    'withSubQuery',
    'select',
    'insertFrom',
    'union',
    'unionAll',
  ] as const) {
    const original = qb[name];
    Object.defineProperty(qb, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        if (!compilation) args.forEach(value => checkEmbedding(value));
        return Reflect.apply(original, qb, args);
      },
    });
  }
  const toRaw = qb.toRaw.bind(qb);
  qb.toRaw = () => {
    const fragment = toRaw();
    if (filteredQueries.has(qb)) filteredQueries.add(fragment);
    return fragment;
  };
}

function checkValue(value: unknown): void {
  if (isRaw(value) || isSubquery(value)) {
    throw new Error(
      'YDB joined filters do not support raw or subquery predicates; use structured target-local conditions.',
    );
  }
  if (Array.isArray(value)) value.forEach(checkValue);
  else if (Utils.isPlainObject(value)) Object.values(value).forEach(checkValue);
}

function checkCondition(condition: Dictionary, alias: string): void {
  for (const key of Reflect.ownKeys(condition)) {
    if (typeof key !== 'string' || RawQueryFragment.isKnownFragmentSymbol(key)) {
      throw new Error('YDB joined filters do not support raw predicate keys.');
    }
    const value = condition[key];
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) throw new Error('YDB joined filter logical conditions require an array.');
      for (const child of value) {
        if (!Utils.isPlainObject(child)) throw new Error('YDB joined filters require structured conditions.');
        checkCondition(child, alias);
      }
    } else if (key === '$not') {
      if (!Utils.isPlainObject(value)) throw new Error('YDB joined NOT filters require a structured condition.');
      checkCondition(value, alias);
    } else {
      if (!key.startsWith(`${alias}.`) || key.slice(alias.length + 1).includes('.')) {
        throw new Error(
          'YDB joined filters must reference only the joined target; cross-alias predicates are unsupported.',
        );
      }
      checkValue(value);
    }
  }
}

function installHelper<T extends object>(qb: AnyQueryBuilder<T>): void {
  const helper = qb.helper;
  if (helpers.has(helper)) return;
  helpers.add(helper);
  const process = helper.processJoins.bind(helper);
  helper.processJoins = (native, joins, schema, schemaOverride) => {
    const context = compilation;
    if (!context) throw new Error('YDB joined filters require an active query compilation.');
    context.reserved.add(qb.mainAlias.meta.tableName);
    for (const cte of qb.state.ctes) context.reserved.add(cte.name);
    for (const join of Object.values(joins)) context.reserved.add(join.table);
    const copies = new Map<JoinOptions, JoinOptions>();
    const lower = (join: JoinOptions): JoinOptions => {
      const existing = copies.get(join);
      if (existing) return existing;
      const copy: JoinOptions = { ...join, cond: { ...join.cond }, nested: undefined, parent: undefined };
      copies.set(join, copy);
      const target = join.prop.targetMeta;
      const discriminator =
        target?.root.inheritanceType === 'sti' && target.discriminatorValue && !join.path?.endsWith('[pivot]');
      if (discriminator) {
        const alias = join.inverseAlias ?? join.alias;
        copy.cond[`${alias}.${target.root.discriminatorColumn}`] = helper.getDiscriminatorCondition(target);
      }
      if (Object.keys(copy.cond).length || Reflect.ownKeys(copy.cond).some(key => typeof key === 'symbol')) {
        if (
          ![
            JoinType.leftJoin,
            JoinType.innerJoin,
            JoinType.nestedLeftJoin,
            JoinType.nestedInnerJoin,
            JoinType.pivotJoin,
          ].includes(join.type)
        ) {
          throw new Error(
            'YDB filtered joins support INNER and LEFT JOIN; filtering a preserved RIGHT/FULL target is unsupported.',
          );
        }
        if (join.subquery || join.prop.name === '__subquery__' || join.prop.polymorphic) {
          throw new Error(
            'YDB joined filters currently require a mapped physical target without a raw subquery or polymorphic join.',
          );
        }
        checkCondition(copy.cond, join.alias);
        let name: string;
        do {
          name = `__ydb_join_filter_${context.next++}`;
        } while (context.reserved.has(name));
        context.reserved.add(name);
        const query = native instanceof YdbNativeQueryBuilder ? native.createSibling() : undefined;
        if (!query) throw new Error('YDB joined filters require the native YQL query builder.');
        const effectiveSchema = join.schema === '*' ? schema : (join.schema ?? schemaOverride);
        query.from(join.table, { alias: join.alias, schema: effectiveSchema }).select('*');
        helper.appendQueryCondition(QueryType.SELECT, copy.cond, query);
        context.filters.push({ name, query });
        filteredQueries.add(qb);
        copy.table = name;
        copy.schema = undefined;
        copy.cond = {};
        // The discriminator is already in the filtered source; prevent the core renderer adding it again.
        if (discriminator) copy.prop = { ...join.prop, targetMeta: undefined };
      }
      if (join.nested) copy.nested = new Set([...join.nested].map(lower));
      if (join.parent) copy.parent = lower(join.parent);
      return copy;
    };
    process(
      native,
      Object.fromEntries(Object.entries(joins).map(([key, join]) => [key, lower(join)])),
      schema,
      schemaOverride,
    );
    if (native instanceof YdbNativeQueryBuilder)
      native.registerExternalNamedQueries(context.filters.map(filter => filter.name));
  };
}

/** Compose the public compiler/clone seams, retaining core's private state, cancellation and lifecycle. */
export function withYdbJoinedFilters<T extends object>(qb: AnyQueryBuilder<T>): AnyQueryBuilder<T> {
  if (builders.has(qb)) return qb;
  builders.add(qb);
  guardEagerEmbedding(qb);
  const clone = qb.clone.bind(qb);
  qb.clone = (...args) => withYdbJoinedFilters(clone(...args));
  const getNativeQuery = qb.getNativeQuery.bind(qb);
  qb.getNativeQuery = (...args) => {
    const parent = compilation;
    if (!parent) {
      // insertFrom/select can retain a live builder that gained a join after registration.
      // Validate before it compiles inside this statement and caches external declarations.
      checkEmbedding(qb.state.insertSubQuery);
      checkEmbedding(qb.state.fields);
    }
    const context = parent ?? { reserved: new Set<string>(), filters: [], next: 0 };
    compilation = context;
    try {
      // Reserve user declarations before finalize() compiles any pagination/count clones.
      context.reserved.add(qb.mainAlias.meta.tableName);
      for (const cte of qb.state.ctes) context.reserved.add(cte.name);
      for (const join of Object.values(qb.state.joins)) context.reserved.add(join.table);
      installHelper(qb);
      const native = getNativeQuery(...args);
      if (filteredQueries.has(qb)) filteredQueries.add(native);
      if (!parent) {
        for (const filter of context.filters) native.with(filter.name, filter.query);
      }
      return native;
    } finally {
      compilation = parent;
    }
  };
  return qb;
}
