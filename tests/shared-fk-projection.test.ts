import {
  Collection,
  EntitySchema,
  LoadStrategy,
  MikroORM,
  QueryFlag,
  ReferenceKind,
  type EntityMetadata,
} from '@mikro-orm/core';
import { YdbSqlDriver } from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `shared_fk_${process.pid}_${Date.now().toString(36)}`;

class ProjectionOwner {
  id!: string;
  name!: string;
  details!: string;
  children = new Collection<ProjectionChild>(this);
}

class ProjectionChild {
  id!: string;
  label!: string;
  lazyLabel!: string;
  lazyFormula?: string;
  ownerId!: string | null;
  owner?: ProjectionOwner | null;
  fallbackOwnerId!: string | null;
  computedOwner?: ProjectionOwner | null;
}

const ownerSchema = new EntitySchema<ProjectionOwner>({
  class: ProjectionOwner,
  tableName: `${prefix}_owner`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string' },
    details: { type: 'string' },
    children: { kind: '1:m', entity: () => ProjectionChild, mappedBy: 'owner' },
  },
});

const childSchema = new EntitySchema<ProjectionChild>({
  class: ProjectionChild,
  tableName: `${prefix}_child`,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    lazyLabel: { type: 'string', fieldName: 'lazy_label', lazy: true },
    lazyFormula: {
      type: 'string',
      fieldName: 'lazy_formula',
      persist: false,
      lazy: true,
      formula: alias => `${String(alias)}.\`label\``,
    },
    ownerId: {
      kind: 'm:1',
      type: 'ProjectionOwner',
      mapToPk: true,
      fieldName: 'owner_id',
      nullable: true,
    },
    owner: {
      kind: 'm:1',
      entity: () => ProjectionOwner,
      persist: false,
      fieldName: 'owner_id',
      nullable: true,
      inversedBy: 'children',
    },
    fallbackOwnerId: {
      kind: 'm:1',
      type: 'ProjectionOwner',
      mapToPk: true,
      fieldName: 'fallback_owner_id',
      nullable: true,
    },
    computedOwner: {
      kind: 'm:1',
      entity: () => ProjectionOwner,
      persist: false,
      fieldName: 'computed_owner_id',
      nullable: true,
      formula: alias => {
        const table = String(alias);
        return `Coalesce(${table}.\`owner_id\`, ${table}.\`fallback_owner_id\`)`;
      },
    },
  },
});

/** Reads the outer SELECT projection only; it never changes the query under test. */
function selectProjection(sql: string): string[] {
  const start = /^\s*select\s+(?:distinct\s+)?/i.exec(sql);
  if (!start) return [];
  const fields: string[] = [];
  let beginning = start[0].length;
  let depth = 0;
  let quote: string | undefined;
  for (let i = beginning; i < sql.length; i++) {
    const character = sql[i];
    if (quote) {
      if (character === '\\') i++;
      else if (character === quote && sql[i + 1] === quote) i++;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (['`', "'", '"'].includes(character)) quote = character;
    else if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (depth === 0 && character === ',') {
      fields.push(sql.slice(beginning, i).trim());
      beginning = i + 1;
    } else if (depth === 0 && /\s/.test(sql[i - 1] ?? '') && /^from\b/i.test(sql.slice(i))) {
      fields.push(sql.slice(beginning, i).trim());
      return fields;
    }
  }
  return [];
}

function physicalColumns(meta: EntityMetadata): string[] {
  return [
    ...new Set(
      meta.props
        .filter(
          prop =>
            prop.persist !== false &&
            !prop.formula &&
            ![ReferenceKind.ONE_TO_MANY, ReferenceKind.MANY_TO_MANY].includes(prop.kind),
        )
        .flatMap(prop => prop.fieldNames ?? []),
    ),
  ];
}

function outputColumns(sql: string, root: EntityMetadata): string[] {
  return selectProjection(sql).flatMap(field => {
    if (field === '*' || /^`(?:``|[^`])+`\.\*$/.test(field)) return physicalColumns(root);
    const alias = /\bas\s+`((?:``|[^`])+)`$/i.exec(field);
    if (alias) return [alias[1].replaceAll('``', '`')];
    const column = /`((?:``|[^`])+)`$/.exec(field);
    return column ? [column[1].replaceAll('``', '`')] : [field];
  });
}

function expectUniqueOutputColumns(sql: string, root: EntityMetadata): void {
  const output = outputColumns(sql, root);
  expect(output.length, sql).toBeGreaterThan(0);
  expect(new Set(output).size, sql).toBe(output.length);
}

describe.skipIf(!enabled)('shared stored FK and virtual relation projections', () => {
  let orm: MikroORM<YdbSqlDriver>;
  const selects: string[] = [];
  let ownerFormula: typeof childSchema.meta.properties.owner.formula;
  let computedFormula: typeof childSchema.meta.properties.computedOwner.formula;
  let ownerTargetMeta: EntityMetadata | undefined;
  let childProperties: string[];

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>({
      driver: YdbSqlDriver,
      entities: [ownerSchema, childSchema],
      clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://127.0.0.1:2136',
      dbName: process.env.YDB_DATABASE ?? '/local',
      allowGlobalContext: true,
      schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
      onQuery: sql => {
        if (/^\s*select\b/i.test(sql)) selects.push(sql);
        return sql;
      },
    });
    await orm.schema.create();
    const meta = orm.getMetadata(ProjectionChild);
    ownerFormula = meta.properties.owner.formula;
    computedFormula = meta.properties.computedOwner.formula;
    ownerTargetMeta = meta.properties.owner.targetMeta;
    childProperties = meta.props.map(prop => prop.name);
    expect(typeof ownerFormula).toBe('function');
  });

  beforeEach(async () => {
    await orm.schema.clear({ truncate: false });
    await orm.em.insertMany(ProjectionOwner, [
      { id: 'owner-a', name: 'Alpha', details: 'Unrequested Alpha details' },
      { id: 'owner-b', name: 'Beta', details: 'Unrequested Beta details' },
    ]);
    await orm.em.insertMany(ProjectionChild, [
      { id: 'child-a', label: 'Owned', lazyLabel: 'Lazy owned', ownerId: 'owner-a', fallbackOwnerId: 'owner-b' },
      { id: 'child-null', label: 'Unowned', lazyLabel: 'Lazy unowned', ownerId: null, fallbackOwnerId: 'owner-b' },
    ]);
    orm.em.clear();
    selects.length = 0;
  });

  afterEach(() => {
    const meta = orm.getMetadata(ProjectionChild);
    expect(meta.properties.owner.formula).toBe(ownerFormula);
    expect(meta.properties.computedOwner.formula).toBe(computedFormula);
    expect(meta.properties.owner.persist).toBe(false);
    expect(meta.properties.owner.fieldNames).toEqual(['owner_id']);
    expect(meta.properties.owner.targetMeta).toBe(ownerTargetMeta);
    expect(meta.properties.ownerId.mapToPk).toBe(true);
    expect(meta.properties.ownerId.fieldNames).toEqual(['owner_id']);
    expect(meta.props.map(prop => prop.name)).toEqual(childProperties);
  });

  afterAll(async () => {
    if (!orm) return;
    try {
      await orm.schema.drop();
    } finally {
      await orm.close(true);
    }
  });

  function expectUniqueSelects(): void {
    expect(selects.length).toBeGreaterThan(0);
    for (const sql of selects) {
      const table = /\bfrom\s+`([^`]+)`/i.exec(sql)?.[1];
      const meta = table === `${prefix}_owner` ? orm.getMetadata(ProjectionOwner) : orm.getMetadata(ProjectionChild);
      expectUniqueOutputColumns(sql, meta);
    }
  }

  test('loads a default root projection and preserves computed and nullable relation values', async () => {
    const children = await orm.em.find(ProjectionChild, {}, { orderBy: { id: 'asc' } });
    expect(children.map(child => child.ownerId)).toEqual(['owner-a', null]);
    await orm.em.populate(children, ['owner', 'computedOwner']);
    const owner = await orm.em.findOneOrFail(ProjectionOwner, 'owner-a');
    const fallback = await orm.em.findOneOrFail(ProjectionOwner, 'owner-b');
    expect(children[0].owner).toBe(owner);
    expect(children[0].computedOwner).toBe(owner);
    expect(children[1].owner).toBeNull();
    expect(children[1].computedOwner).toBe(fallback);
    expectUniqueSelects();
  });

  test('preserves lazy physical columns and explicit lazy-formula flags when expanding a root wildcard', async () => {
    const defaults = await orm.em.find(ProjectionChild, {}, { orderBy: { id: 'asc' } });
    expect(defaults.map(child => child.lazyLabel)).toEqual([undefined, undefined]);
    expect(defaults.map(child => child.lazyFormula)).toEqual([undefined, undefined]);
    orm.em.clear();

    const wildcard = await orm.em.find(ProjectionChild, {}, { fields: ['*'], orderBy: { id: 'asc' } });
    expect(wildcard.map(child => child.lazyLabel)).toEqual(['Lazy owned', 'Lazy unowned']);
    expect(wildcard.map(child => child.lazyFormula)).toEqual([undefined, undefined]);
    orm.em.clear();

    const withFormulas = await orm.em.find(
      ProjectionChild,
      {},
      {
        fields: ['*'],
        flags: [QueryFlag.INCLUDE_LAZY_FORMULAS],
        orderBy: { id: 'asc' },
      },
    );
    expect(withFormulas.map(child => child.lazyLabel)).toEqual(['Lazy owned', 'Lazy unowned']);
    expect(withFormulas.map(child => child.lazyFormula)).toEqual(['Owned', 'Unowned']);
    expectUniqueSelects();
  });

  test('hydrates a full joined inverse collection without selecting the shared FK output twice', async () => {
    const owners = await orm.em.find(
      ProjectionOwner,
      {},
      {
        populate: ['children', 'children.computedOwner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    expect(owners[0].children.getItems()).toHaveLength(1);
    const child = owners[0].children.getItems()[0];
    expect(child.ownerId).toBe('owner-a');
    expect(child.owner).toBe(owners[0]);
    expect(child.computedOwner).toBe(owners[0]);
    expect(await orm.em.findOneOrFail(ProjectionChild, 'child-a')).toBe(child);
    expect(owners[1].children.getItems()).toEqual([]);
    expectUniqueSelects();
  });

  test('keeps an alias-only FK selection inside a partially selected joined child', async () => {
    const owners = await orm.em.find(
      ProjectionOwner,
      {},
      {
        fields: ['id', 'children.id', 'children.label', 'children.owner'],
        populate: ['children', 'children.owner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = owners.find(item => item.id === 'owner-a')!;
    expect(owner.children.getItems()).toHaveLength(1);
    const child = owner.children.getItems()[0];
    expect(child.id).toBe('child-a');
    expect(child.label).toBe('Owned');
    expect(child.owner).toBe(owner);
    expect(owners.find(item => item.id === 'owner-b')!.children.getItems()).toEqual([]);
    expectUniqueSelects();
  });

  test('keeps the joined child virtual relation when its stored FK is excluded by a nested path', async () => {
    const owners = await orm.em.find(
      ProjectionOwner,
      {},
      {
        exclude: ['children.ownerId'],
        populate: ['children', 'children.owner', 'children.computedOwner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = owners.find(item => item.id === 'owner-a')!;
    expect(owner.children.getItems()).toHaveLength(1);
    const child = owner.children.getItems()[0];
    expect(child.owner).toBe(owner);
    expect(child.computedOwner).toBe(owner);
    expect(child.label).toBe('Owned');
    expectUniqueSelects();
  });

  test('keeps a stored-only FK selection inside a partially selected joined child', async () => {
    const owners = await orm.em.find(
      ProjectionOwner,
      {},
      {
        fields: ['id', 'children.id', 'children.label', 'children.ownerId'],
        populate: ['children'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = owners.find(item => item.id === 'owner-a')!;
    expect(owner.children.getItems()).toHaveLength(1);
    expect(owner.children.getItems()[0]).toMatchObject({ id: 'child-a', label: 'Owned', ownerId: 'owner-a' });
    expect(owners.find(item => item.id === 'owner-b')!.children.getItems()).toEqual([]);
    expectUniqueSelects();
  });

  test('keeps an explicitly selected stored mapToPk FK when the virtual alias is omitted', async () => {
    const children = await orm.em.find(
      ProjectionChild,
      {},
      {
        fields: ['id', 'label', 'ownerId', 'fallbackOwnerId'],
        orderBy: { id: 'asc' },
      },
    );
    expect(children.map(child => child.ownerId)).toEqual(['owner-a', null]);
    expect(children.map(child => child.fallbackOwnerId)).toEqual(['owner-b', 'owner-b']);
    expectUniqueSelects();
  });

  test('keeps the virtual FK projection for alias-only fields and hydrates its joined owner', async () => {
    const children = await orm.em.find(
      ProjectionChild,
      {},
      {
        fields: ['id', 'label', 'owner'],
        populate: ['owner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = await orm.em.findOneOrFail(ProjectionOwner, 'owner-a');
    expect(children[0].owner).toBe(owner);
    expect(children[1].owner).toBeNull();
    expectUniqueSelects();
  });

  test('keeps nested select-in fields while selecting the shared root FK once', async () => {
    const em = orm.em.fork();
    const children = await em.find(
      ProjectionChild,
      {},
      {
        fields: ['id', 'ownerId', 'owner.name'],
        populate: ['owner'],
        strategy: LoadStrategy.SELECT_IN,
        orderBy: { id: 'asc' },
      },
    );
    expect(children.map(child => child.ownerId)).toEqual(['owner-a', null]);
    expect(children[0].owner?.id).toBe('owner-a');
    expect(children[0].owner?.name).toBe('Alpha');
    expect((children[0].owner as ProjectionOwner).details).toBeUndefined();
    expect(children[1].owner).toBeNull();
    expect(await em.findOneOrFail(ProjectionOwner, 'owner-a', { fields: ['name'] })).toBe(children[0].owner);
    const rootQueries = selects.filter(sql => sql.includes(`from \`${prefix}_child\``));
    expect(rootQueries.length).toBeGreaterThan(0);
    for (const sql of rootQueries) {
      expect(outputColumns(sql, orm.getMetadata(ProjectionChild)).filter(column => column === 'owner_id')).toHaveLength(
        1,
      );
    }
    expectUniqueSelects();
  });

  test.each([
    { selection: 'an explicit wildcard', fields: ['*'] },
    { selection: 'both stored and virtual FK properties', fields: ['id', 'label', 'ownerId', 'owner'] },
  ] as const)('deduplicates the root output with $selection', async ({ fields }) => {
    const children = await orm.em.find(
      ProjectionChild,
      {},
      {
        fields: [...fields],
        populate: ['owner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = await orm.em.findOneOrFail(ProjectionOwner, 'owner-a');
    expect(children.map(child => child.ownerId)).toEqual(['owner-a', null]);
    expect(children[0].owner).toBe(owner);
    expect(children[1].owner).toBeNull();
    expectUniqueSelects();
  });

  test('keeps an excluded stored FK available through its selected virtual relation', async () => {
    const children = await orm.em.find(
      ProjectionChild,
      {},
      {
        exclude: ['ownerId'],
        populate: ['owner', 'computedOwner'],
        strategy: LoadStrategy.JOINED,
        orderBy: { id: 'asc' },
      },
    );
    const owner = await orm.em.findOneOrFail(ProjectionOwner, 'owner-a');
    const fallback = await orm.em.findOneOrFail(ProjectionOwner, 'owner-b');
    expect(children[0].owner).toBe(owner);
    expect(children[0].computedOwner).toBe(owner);
    expect(children[1].owner).toBeNull();
    expect(children[1].computedOwner).toBe(fallback);
    expectUniqueSelects();
  });

  test('keeps stored-only data when both virtual relation projections are excluded', async () => {
    const children = await orm.em.find(
      ProjectionChild,
      {},
      {
        exclude: ['owner', 'computedOwner'],
        orderBy: { id: 'asc' },
      },
    );
    expect(children.map(child => child.ownerId)).toEqual(['owner-a', null]);
    expect(children.map(child => child.fallbackOwnerId)).toEqual(['owner-b', 'owner-b']);
    expectUniqueSelects();
  });
});
