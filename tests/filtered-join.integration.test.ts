import {
  Collection,
  EntitySchema,
  LoadStrategy,
  MikroORM,
  PrimaryKeyProp,
  raw,
  type FilterOptions,
  type Options,
} from '@mikro-orm/core';
import { toJs, type Value } from '@ydbjs/value';
import { YdbSqlDriver } from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `filtered_join_${process.pid}_${Date.now().toString(36)}`;
const removedAt = new Date('2026-02-03T04:05:06.789Z');

class FilteredParent {
  id!: string;
  label!: string;
  profile?: FilteredProfile | null;
  children = new Collection<FilteredChild>(this);
}

class FilteredChild {
  id!: string;
  parent!: FilteredParent;
  profile?: FilteredProfile | null;
  tenant!: string;
  status!: string;
  deletedAt!: Date | null;
}

class FilteredProfile {
  id!: string;
  label!: string;
  deletedAt!: Date | null;
}

const parentSchema = new EntitySchema<FilteredParent>({
  class: FilteredParent,
  tableName: `${prefix}_parent`,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    profile: { kind: 'm:1', entity: () => FilteredProfile, nullable: true },
    children: { kind: '1:m', entity: () => FilteredChild, mappedBy: 'parent', orderBy: { id: 'asc' } },
  },
});

const profileSchema = new EntitySchema<FilteredProfile>({
  class: FilteredProfile,
  tableName: `${prefix}_profile`,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    deletedAt: { type: 'Date', nullable: true },
  },
  filters: { visibleProfiles: { name: 'visibleProfiles', cond: { deletedAt: null }, default: true } },
});

const childSchema = new EntitySchema<FilteredChild>({
  class: FilteredChild,
  tableName: `${prefix}_child`,
  properties: {
    id: { type: 'string', primary: true },
    parent: { kind: 'm:1', entity: () => FilteredParent, inversedBy: 'children' },
    profile: { kind: 'm:1', entity: () => FilteredProfile, nullable: true },
    tenant: { type: 'string' },
    status: { type: 'string' },
    deletedAt: { type: 'Date', nullable: true },
  },
  filters: {
    visibleChildren: { name: 'visibleChildren', cond: { deletedAt: null }, default: true },
    tenantStatus: {
      name: 'tenantStatus',
      cond: args => ({ tenant: String(args.tenant), status: String(args.status) }),
      default: false,
    },
    structuredScope: {
      name: 'structuredScope',
      cond: { $and: [{ $or: [{ tenant: 'tenant-a' }, { status: 'active' }] }, { $not: { tenant: 'tenant-b' } }] },
      default: false,
    },
    deletedBefore: {
      name: 'deletedBefore',
      cond: args => ({ deletedAt: { $lt: args.cutoff as Date } }),
      default: false,
    },
  },
});

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

function unbox(value: unknown): unknown {
  return value != null && typeof value === 'object' && 'encode' in value && 'type' in value
    ? toJs(value as Value)
    : value;
}

interface DirectDatabase {
  [table: string]: {
    id: string;
    parent_id: string;
    deleted_at: Date | null;
    tenant: string;
    status: string;
    label: string;
  };
}

async function withFilteredSchema(
  entities: Options<YdbSqlDriver>['entities'],
  run: (orm: MikroORM<YdbSqlDriver>) => Promise<void>,
): Promise<void> {
  const orm = await MikroORM.init<YdbSqlDriver>({
    driver: YdbSqlDriver,
    entities,
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://127.0.0.1:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
  });
  try {
    await orm.schema.create();
    await run(orm);
  } finally {
    try {
      await orm.schema.drop();
    } finally {
      await orm.close(true);
    }
  }
}

describe.skipIf(!enabled)('default and parameterized filters on YDB joined relations', () => {
  let orm: MikroORM<YdbSqlDriver>;
  const queries: CapturedQuery[] = [];

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>({
      driver: YdbSqlDriver,
      entities: [parentSchema, childSchema, profileSchema],
      clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://127.0.0.1:2136',
      dbName: process.env.YDB_DATABASE ?? '/local',
      allowGlobalContext: true,
      schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
      onQuery: (sql, params) => {
        if (/^\s*(?:select\b|\$[A-Za-z_][A-Za-z0-9_]*\s*=)/i.test(sql)) queries.push({ sql, params: [...params] });
        return sql;
      },
    });
    await orm.schema.create();
    await orm.em.insertMany(FilteredProfile, [
      { id: 'profile-live', label: 'Visible', deletedAt: null },
      { id: 'profile-deleted', label: 'Removed', deletedAt: removedAt },
    ]);
    await orm.em.insertMany(FilteredParent, [
      { id: 'parent-0-empty', label: 'No children', profile: null },
      { id: 'parent-1-deleted', label: 'Only deleted children', profile: 'profile-deleted' },
      { id: 'parent-2-mixed', label: 'Visible and deleted children', profile: 'profile-live' },
    ]);
    await orm.em.insertMany(FilteredChild, [
      {
        id: 'child-only-deleted',
        parent: 'parent-1-deleted',
        profile: null,
        tenant: 'tenant-a',
        status: 'active',
        deletedAt: removedAt,
      },
      {
        id: 'child-active',
        parent: 'parent-2-mixed',
        profile: 'profile-live',
        tenant: 'tenant-a',
        status: 'active',
        deletedAt: null,
      },
      {
        id: 'child-deleted',
        parent: 'parent-2-mixed',
        profile: 'profile-live',
        tenant: 'tenant-a',
        status: 'active',
        deletedAt: removedAt,
      },
      {
        id: 'child-other-status',
        parent: 'parent-2-mixed',
        profile: 'profile-deleted',
        tenant: 'tenant-a',
        status: 'pending',
        deletedAt: null,
      },
      {
        id: 'child-other-tenant',
        parent: 'parent-2-mixed',
        profile: 'profile-deleted',
        tenant: 'tenant-b',
        status: 'active',
        deletedAt: null,
      },
    ]);
  });

  beforeEach(() => {
    orm.em.clear();
    queries.length = 0;
  });

  afterAll(async () => {
    if (!orm) return;
    try {
      await orm.schema.drop();
    } finally {
      await orm.close(true);
    }
  });

  async function loadChildren(strategy: LoadStrategy, filters: FilterOptions = { visibleProfiles: false }) {
    const em = orm.em.fork();
    const parents = await em.find(
      FilteredParent,
      {},
      {
        populate: ['children'],
        strategy,
        filters,
        orderBy: { id: 'asc' },
      },
    );
    for (const parent of parents) {
      expect(await em.findOneOrFail(FilteredParent, parent.id, { filters })).toBe(parent);
      for (const child of parent.children.getItems()) expect(child.parent).toBe(parent);
    }
    return parents;
  }

  function childIds(parents: FilteredParent[]) {
    return parents.map(parent => ({
      id: parent.id,
      children: parent.children
        .getItems()
        .map(child => child.id)
        .sort(),
    }));
  }

  test('retains parents with no children or only deleted children while filtering a joined collection', async () => {
    const selected = await loadChildren(LoadStrategy.SELECT_IN);
    const expected = [
      { id: 'parent-0-empty', children: [] },
      { id: 'parent-1-deleted', children: [] },
      { id: 'parent-2-mixed', children: ['child-active', 'child-other-status', 'child-other-tenant'] },
    ];
    expect(childIds(selected)).toEqual(expected);
    const joined = await loadChildren(LoadStrategy.JOINED);
    expect(childIds(joined)).toEqual(expected);
    expect(childIds(joined)).toEqual(childIds(selected));
    expect(joined[2].children.getItems().every(child => child.deletedAt === null)).toBe(true);
  });

  test('retains parents and maps filtered nullable to-one targets to null with either loading strategy', async () => {
    async function loadProfiles(strategy: LoadStrategy) {
      const em = orm.em.fork();
      const parents = await em.find(
        FilteredParent,
        {},
        {
          populate: ['profile'],
          strategy,
          orderBy: { id: 'asc' },
        },
      );
      const visible = parents.find(parent => parent.id === 'parent-2-mixed')?.profile;
      expect(visible).toBe(await em.findOneOrFail(FilteredProfile, 'profile-live'));
      return parents.map(parent => ({ id: parent.id, profile: parent.profile?.id ?? null }));
    }
    const expected = [
      { id: 'parent-0-empty', profile: null },
      { id: 'parent-1-deleted', profile: null },
      { id: 'parent-2-mixed', profile: 'profile-live' },
    ];
    expect(await loadProfiles(LoadStrategy.SELECT_IN)).toEqual(expected);
    expect(await loadProfiles(LoadStrategy.JOINED)).toEqual(expected);
  });

  test('keeps parameterized tenant and status filters bound and scoped to the joined child', async () => {
    const filters = { visibleProfiles: false, tenantStatus: { tenant: 'tenant-a', status: 'active' } };
    const selected = await loadChildren(LoadStrategy.SELECT_IN, filters);
    const expected = [
      { id: 'parent-0-empty', children: [] },
      { id: 'parent-1-deleted', children: [] },
      { id: 'parent-2-mixed', children: ['child-active'] },
    ];
    expect(childIds(selected)).toEqual(expected);
    queries.length = 0;
    const joined = await loadChildren(LoadStrategy.JOINED, filters);
    expect(childIds(joined)).toEqual(expected);
    const joinQueries = queries.filter(query => /\bjoin\b/i.test(query.sql));
    expect(joinQueries.length).toBeGreaterThan(0);
    expect(joinQueries.flatMap(query => query.params).map(unbox)).toContain('tenant-a');
    expect(joinQueries.flatMap(query => query.params).map(unbox)).toContain('active');
    for (const query of joinQueries) {
      expect(query.sql).not.toContain('tenant-a');
      expect(query.sql).not.toContain("'active'");
    }
  });

  test('preserves typed Date parameters and excludes nullable timestamps when a date filter replaces soft deletion', async () => {
    const cutoff = new Date('2026-03-01T00:00:00.000Z');
    const filters = { visibleChildren: false, visibleProfiles: false, deletedBefore: { cutoff } };
    const selected = await loadChildren(LoadStrategy.SELECT_IN, filters);
    const expected = [
      { id: 'parent-0-empty', children: [] },
      { id: 'parent-1-deleted', children: ['child-only-deleted'] },
      { id: 'parent-2-mixed', children: ['child-deleted'] },
    ];
    expect(childIds(selected)).toEqual(expected);
    queries.length = 0;
    const joined = await loadChildren(LoadStrategy.JOINED, filters);
    expect(childIds(joined)).toEqual(expected);
    for (const parent of joined) {
      for (const child of parent.children.getItems()) expect(child.deletedAt).toEqual(removedAt);
    }
    const boundDates = queries
      .flatMap(query => query.params)
      .map(unbox)
      .filter(value => value instanceof Date);
    expect(boundDates.some(value => value.getTime() === cutoff.getTime())).toBe(true);
  });

  test('applies nested target filters while sharing hydrated profile instances', async () => {
    async function loadNested(strategy: LoadStrategy) {
      const em = orm.em.fork();
      const parents = await em.find(
        FilteredParent,
        {},
        {
          populate: ['profile', 'children', 'children.profile'],
          strategy,
          orderBy: { id: 'asc' },
        },
      );
      const mixed = parents.find(parent => parent.id === 'parent-2-mixed')!;
      const active = mixed.children.getItems().find(child => child.id === 'child-active')!;
      expect(active.profile).toBe(mixed.profile);
      expect(active.parent).toBe(mixed);
      return parents.map(parent => ({
        id: parent.id,
        profile: parent.profile?.id ?? null,
        children: parent.children
          .getItems()
          .map(child => ({ id: child.id, profile: child.profile?.id ?? null }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }));
    }
    const selected = await loadNested(LoadStrategy.SELECT_IN);
    expect(selected.map(parent => parent.id)).toEqual(['parent-0-empty', 'parent-1-deleted', 'parent-2-mixed']);
    expect(selected[2].children).toEqual([
      { id: 'child-active', profile: 'profile-live' },
      { id: 'child-other-status', profile: null },
      { id: 'child-other-tenant', profile: null },
    ]);
    expect(await loadNested(LoadStrategy.JOINED)).toEqual(selected);
  });

  test('preserves filtered joins across QueryBuilder clone, count and joined pagination', async () => {
    const em = orm.em.fork();
    const query = em
      .createQueryBuilder(FilteredParent, 'p')
      .select('*')
      .leftJoinAndSelect('p.children', 'c', { deletedAt: null, tenant: 'tenant-a', status: 'active' })
      .orderBy({ 'p.id': 'asc' });
    const clone = query.clone();
    const [page, count] = await clone.limit(2, 1).getResultAndCount();
    expect(count).toBe(3);
    expect(childIds(page)).toEqual([
      { id: 'parent-1-deleted', children: [] },
      { id: 'parent-2-mixed', children: ['child-active'] },
    ]);
    expect(await query.clone().getCount()).toBe(3);
    const all = await query.getResultList();
    expect(all.map(parent => parent.id)).toEqual(['parent-0-empty', 'parent-1-deleted', 'parent-2-mixed']);
    const child = all[2].children.getItems()[0];
    expect(child.parent).toBe(all[2]);
    expect(all[2]).toBe(page[1]);
  });

  test('preserves target-local OR and NOT grouping in joined entity filters', async () => {
    const filters = { visibleProfiles: false, structuredScope: true };
    const selected = await loadChildren(LoadStrategy.SELECT_IN, filters);
    const expected = [
      { id: 'parent-0-empty', children: [] },
      { id: 'parent-1-deleted', children: [] },
      { id: 'parent-2-mixed', children: ['child-active', 'child-other-status'] },
    ];
    expect(childIds(selected)).toEqual(expected);
    expect(childIds(await loadChildren(LoadStrategy.JOINED, filters))).toEqual(expected);
  });

  test('executes target-local filters through the direct Kysely AST path', async () => {
    const db = orm.em.getConnection().getClient<DirectDatabase>();
    const query = db
      .selectFrom(`${prefix}_parent as p`)
      .leftJoin(`${prefix}_child as c`, join =>
        join
          .onRef('c.parent_id', '=', 'p.id')
          .on('c.deleted_at', 'is', null)
          .on('c.tenant', '=', 'tenant-a')
          .on('c.status', '=', 'active'),
      )
      .select(['p.id as parent_id', 'c.id as child_id'])
      .orderBy('p.id');
    const compiled = query.compile();
    expect(compiled.parameters).toContain('tenant-a');
    expect(compiled.parameters).toContain('active');
    expect(compiled.sql).not.toContain('tenant-a');
    expect(await query.execute()).toEqual([
      { parent_id: 'parent-0-empty', child_id: null },
      { parent_id: 'parent-1-deleted', child_id: null },
      { parent_id: 'parent-2-mixed', child_id: 'child-active' },
    ]);
  });

  test('rejects raw and cross-alias ORM join predicates before sending a query', () => {
    const crossAlias = orm.em
      .createQueryBuilder(FilteredParent, 'p')
      .select('*')
      // @ts-expect-error Deliberately pass a non-target alias to verify the runtime boundary.
      .leftJoinAndSelect('p.children', 'c', { 'p.label': 'No children' });
    expect(() => crossAlias.getQuery()).toThrow(/joined target|cross-alias/i);
    const rawPredicate = orm.em
      .createQueryBuilder(FilteredParent, 'p')
      .select('*')
      .leftJoinAndSelect('p.children', 'c', { [raw('c.deleted_at is null')]: [] });
    expect(() => rawPredicate.getQuery()).toThrow(/raw predicate|structured target-local/i);
    expect(queries).toEqual([]);
  });
});

describe.skipIf(!enabled)('filtered YDB joins with composite keys and inheritance', () => {
  test('retains both composite equijoin keys when a filtered target is pushed down', async () => {
    class CompositeFilteredParent {
      region!: string;
      code!: number;
      children = new Collection<CompositeFilteredChild>(this);
      [PrimaryKeyProp]?: ['region', 'code'];
    }
    class CompositeFilteredChild {
      id!: string;
      parent!: CompositeFilteredParent;
      deletedAt!: Date | null;
    }
    const parents = new EntitySchema<CompositeFilteredParent>({
      class: CompositeFilteredParent,
      tableName: `${prefix}_composite_parent`,
      properties: {
        region: { type: 'string', primary: true },
        code: { type: 'integer', primary: true, autoincrement: false },
        children: { kind: '1:m', entity: () => CompositeFilteredChild, mappedBy: 'parent' },
      },
    });
    const children = new EntitySchema<CompositeFilteredChild>({
      class: CompositeFilteredChild,
      tableName: `${prefix}_composite_child`,
      properties: {
        id: { type: 'string', primary: true },
        parent: { kind: 'm:1', entity: () => CompositeFilteredParent, inversedBy: 'children' },
        deletedAt: { type: 'Date', nullable: true },
      },
      filters: { visible: { name: 'visible', cond: { deletedAt: null }, default: true } },
    });
    await withFilteredSchema([parents, children], async orm => {
      const first = orm.em.create(CompositeFilteredParent, { region: 'a', code: 1 });
      const onlyDeleted = orm.em.create(CompositeFilteredParent, { region: 'a', code: 2 });
      const second = orm.em.create(CompositeFilteredParent, { region: 'b', code: 1 });
      orm.em.create(CompositeFilteredChild, { id: 'live-a1', parent: first, deletedAt: null });
      orm.em.create(CompositeFilteredChild, { id: 'deleted-a1', parent: first, deletedAt: removedAt });
      orm.em.create(CompositeFilteredChild, { id: 'deleted-a2', parent: onlyDeleted, deletedAt: removedAt });
      orm.em.create(CompositeFilteredChild, { id: 'live-b1', parent: second, deletedAt: null });
      await orm.em.flush();
      async function load(strategy: LoadStrategy) {
        const em = orm.em.fork();
        const result = await em.find(
          CompositeFilteredParent,
          {},
          {
            populate: ['children'],
            strategy,
            orderBy: { region: 'asc', code: 'asc' },
          },
        );
        for (const parent of result) {
          for (const child of parent.children.getItems()) expect(child.parent).toBe(parent);
        }
        return result.map(parent => ({
          region: parent.region,
          code: parent.code,
          children: parent.children
            .getItems()
            .map(child => child.id)
            .sort(),
        }));
      }
      const expected = [
        { region: 'a', code: 1, children: ['live-a1'] },
        { region: 'a', code: 2, children: [] },
        { region: 'b', code: 1, children: ['live-b1'] },
      ];
      expect(await load(LoadStrategy.SELECT_IN)).toEqual(expected);
      expect(await load(LoadStrategy.JOINED)).toEqual(expected);
    });
  });

  test('applies a late STI discriminator together with a default nullable target filter', async () => {
    abstract class BaseFilteredTarget {
      id!: string;
      label!: string;
      deletedAt!: Date | null;
    }
    class FilteredTargetA extends BaseFilteredTarget {
      value!: string;
    }
    class FilteredTargetB extends BaseFilteredTarget {
      other!: string;
    }
    class FilteredHolder {
      id!: string;
      target?: FilteredTargetA | null;
    }
    const base = new EntitySchema<BaseFilteredTarget>({
      class: BaseFilteredTarget,
      abstract: true,
      tableName: `${prefix}_sti_target`,
      discriminatorColumn: 'kind',
      discriminatorMap: { a: FilteredTargetA, b: FilteredTargetB },
      properties: {
        id: { type: 'string', primary: true },
        label: { type: 'string' },
        deletedAt: { type: 'Date', nullable: true },
      },
      filters: { visible: { name: 'visible', cond: { deletedAt: null }, default: true } },
    });
    const targetA = new EntitySchema<FilteredTargetA, BaseFilteredTarget>({
      class: FilteredTargetA,
      extends: BaseFilteredTarget,
      discriminatorValue: 'a',
      properties: { value: { type: 'string' } },
    });
    const targetB = new EntitySchema<FilteredTargetB, BaseFilteredTarget>({
      class: FilteredTargetB,
      extends: BaseFilteredTarget,
      discriminatorValue: 'b',
      properties: { other: { type: 'string' } },
    });
    const holders = new EntitySchema<FilteredHolder>({
      class: FilteredHolder,
      tableName: `${prefix}_sti_holder`,
      properties: {
        id: { type: 'string', primary: true },
        target: { kind: 'm:1', entity: () => FilteredTargetA, nullable: true },
      },
    });
    await withFilteredSchema([base, targetA, targetB, holders], async orm => {
      orm.em.create(FilteredTargetA, { id: 'target-a-live', label: 'Live A', value: 'a', deletedAt: null });
      orm.em.create(FilteredTargetA, {
        id: 'target-a-deleted',
        label: 'Deleted A',
        value: 'removed',
        deletedAt: removedAt,
      });
      orm.em.create(FilteredTargetB, { id: 'target-b', label: 'Other subtype', other: 'b', deletedAt: null });
      await orm.em.flush();
      await orm.em.insertMany(FilteredHolder, [
        { id: 'holder-0-empty', target: null },
        { id: 'holder-1-live', target: 'target-a-live' },
        { id: 'holder-2-deleted', target: 'target-a-deleted' },
        { id: 'holder-3-other', target: 'target-b' },
      ]);
      async function load(strategy: LoadStrategy) {
        const em = orm.em.fork();
        const result = await em.find(FilteredHolder, {}, { populate: ['target'], strategy, orderBy: { id: 'asc' } });
        expect(result[1].target).toBeInstanceOf(FilteredTargetA);
        expect(result[1].target).toBe(await em.findOneOrFail(FilteredTargetA, 'target-a-live'));
        expect(result[1].target?.deletedAt).toBeNull();
        return result.map(holder => ({ id: holder.id, target: holder.target?.id ?? null }));
      }
      const expected = [
        { id: 'holder-0-empty', target: null },
        { id: 'holder-1-live', target: 'target-a-live' },
        { id: 'holder-2-deleted', target: null },
        { id: 'holder-3-other', target: null },
      ];
      expect(await load(LoadStrategy.SELECT_IN)).toEqual(expected);
      expect(await load(LoadStrategy.JOINED)).toEqual(expected);
    });
  });
});
