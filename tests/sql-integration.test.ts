import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  Collection,
  EntitySchema,
  LoadStrategy,
  MikroORM,
  OptimisticLockError,
  PrimaryKeyProp,
  Type,
  UniqueConstraintViolationException,
  raw,
  type Options,
} from '@mikro-orm/core';
import { YdbSqlDriver } from '../src/index.js';
import { YdbMigrator } from '../src/YdbMigrator.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `mikro_ydb_sql_${process.pid}_${Date.now().toString(36)}`;
const pivotTable = `${prefix}_book_tag`;

class SqlAuthor {
  id!: string;
  name!: string;
  books = new Collection<SqlBook>(this);
  profile?: SqlProfile;
}

class SqlProfile {
  id!: string;
  bio!: string;
  author!: SqlAuthor;
}

class SqlBook {
  id!: string;
  title!: string;
  rating!: number;
  author!: SqlAuthor;
  tags = new Collection<SqlTag>(this);
}

class SqlTag {
  id!: string;
  name!: string;
  books = new Collection<SqlBook>(this);
}

const authorSchema = new EntitySchema<SqlAuthor>({
  class: SqlAuthor,
  tableName: `${prefix}_author`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string', fieldName: 'display_name' },
    books: { kind: '1:m', entity: () => SqlBook, mappedBy: 'author' },
    profile: { kind: '1:1', entity: () => SqlProfile, mappedBy: 'author', nullable: true },
  },
});

const profileSchema = new EntitySchema<SqlProfile>({
  class: SqlProfile,
  tableName: `${prefix}_profile`,
  properties: {
    id: { type: 'string', primary: true },
    bio: { type: 'string' },
    author: { kind: '1:1', entity: () => SqlAuthor, owner: true, inversedBy: 'profile' },
  },
});

const bookSchema = new EntitySchema<SqlBook>({
  class: SqlBook,
  tableName: `${prefix}_book`,
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    rating: { type: 'integer' },
    author: { kind: 'm:1', entity: () => SqlAuthor, inversedBy: 'books' },
    tags: {
      kind: 'm:n',
      entity: () => SqlTag,
      owner: true,
      inversedBy: 'books',
      pivotTable,
      orderBy: { name: 'asc' },
    },
  },
});

const tagSchema = new EntitySchema<SqlTag>({
  class: SqlTag,
  tableName: `${prefix}_tag`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string' },
    books: { kind: 'm:n', entity: () => SqlBook, mappedBy: 'tags' },
  },
});

function options(entities: Options<YdbSqlDriver>['entities']): Partial<Options<YdbSqlDriver>> {
  return {
    driver: YdbSqlDriver,
    entities,
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
    driverOptions: { connectTimeoutMs: 60_000, queryTimeoutMs: 30_000 },
  };
}

describe.skipIf(!enabled)('YDB SQL driver integration', () => {
  let orm: MikroORM<YdbSqlDriver>;

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>(options([authorSchema, profileSchema, bookSchema, tagSchema]));
    await orm.schema.create();
  });

  beforeEach(async () => {
    await orm.schema.clear({ truncate: false });
    orm.em.clear();
  });

  afterAll(async () => {
    if (orm) {
      try {
        await orm.schema.drop();
      } finally {
        await orm.close(true);
      }
    }
  });

  async function seed() {
    const first = orm.em.create(SqlAuthor, { id: 'author-a', name: 'Ada' });
    const second = orm.em.create(SqlAuthor, { id: 'author-b', name: 'Babbage' });
    const profile = orm.em.create(SqlProfile, { id: 'profile-a', bio: 'Mathematician', author: first });
    const alpha = orm.em.create(SqlBook, { id: 'book-a', title: 'Analytical Engine', rating: 9, author: first });
    const beta = orm.em.create(SqlBook, { id: 'book-b', title: 'Notes', rating: 8, author: first });
    const gamma = orm.em.create(SqlBook, { id: 'book-c', title: 'Difference Engine', rating: 6, author: second });
    const code = orm.em.create(SqlTag, { id: 'tag-code', name: 'Code' });
    const history = orm.em.create(SqlTag, { id: 'tag-history', name: 'History' });
    const math = orm.em.create(SqlTag, { id: 'tag-math', name: 'Mathematics' });
    alpha.tags.add(math, code);
    beta.tags.add(code);
    gamma.tags.add(history);
    await orm.em.flush();
    orm.em.clear();
    return { first, second, profile, alpha, beta, gamma, code, history, math };
  }

  test('creates mapped tables, one-to-one indexes and M:N pivots without introspection drift', async () => {
    const ddl = await orm.schema.getCreateSchemaSQL({ wrap: false });
    expect(ddl).toContain(pivotTable);
    expect(ddl).toContain(`${prefix}_profile`);
    expect(await orm.schema.getUpdateSchemaSQL({ wrap: false, dropTables: false })).toBe('');
    expect(await orm.schema.getUpdateSchemaMigrationSQL({ wrap: false, dropTables: false })).toEqual({
      up: '',
      down: '',
    });
    expect(await orm.em.count(SqlAuthor)).toBe(0);
  });

  test('hydrates joined to-one, inverse one-to-one and to-many relations with one identity map', async () => {
    await seed();
    const author = await orm.em.findOneOrFail(SqlAuthor, 'author-a', {
      populate: ['profile', 'books', 'books.tags'],
      strategy: LoadStrategy.JOINED,
    });
    expect(author.name).toBe('Ada');
    expect(author.profile?.bio).toBe('Mathematician');
    expect(author.profile?.author).toBe(author);
    expect(
      author.books
        .getItems()
        .map(book => book.id)
        .sort(),
    ).toEqual(['book-a', 'book-b']);
    const alpha = author.books.getItems().find(book => book.id === 'book-a')!;
    const beta = author.books.getItems().find(book => book.id === 'book-b')!;
    expect(alpha.author).toBe(author);
    expect(alpha.tags.getItems().map(tag => tag.name)).toEqual(['Code', 'Mathematics']);
    expect(alpha.tags.getItems()[0]).toBe(beta.tags.getItems()[0]);
    const separatelyLoaded = await orm.em.findOneOrFail(SqlBook, 'book-a', {
      populate: ['author', 'author.profile'],
      strategy: LoadStrategy.JOINED,
    });
    expect(separatelyLoaded).toBe(alpha);
    expect(separatelyLoaded.author.profile).toBe(author.profile);
  });

  test('executes QueryBuilder joins with aliases, bound filters and hydrated results', async () => {
    await seed();
    const query = orm.em
      .createQueryBuilder(SqlBook, 'b')
      .select('*')
      .leftJoinAndSelect('b.author', 'a')
      .where({ 'a.name': 'Ada', rating: { $gte: 8 } })
      .orderBy({ 'b.rating': 'desc' });
    expect(query.getQuery()).toMatch(/join/i);
    expect(query.getParams()).toContain('Ada');
    const books = await query.getResultList();
    expect(books.map(book => book.id)).toEqual(['book-a', 'book-b']);
    expect(books[0].author).toBe(books[1].author);
    expect(books[0].author.name).toBe('Ada');
  });

  test('binds a QueryBuilder IN subquery without rendering its parameter values', async () => {
    await seed();
    const qualifiedAuthors = orm.em
      .createQueryBuilder(SqlBook, 'b')
      .select('b.author')
      .where({ rating: { $gte: 8 } });
    const query = orm.em
      .createQueryBuilder(SqlAuthor, 'a')
      .select('*')
      .where({ id: { $in: qualifiedAuthors.getNativeQuery() } })
      .orderBy({ name: 'asc' });
    expect(query.getQuery()).toMatch(/in\s*\(select/i);
    expect(query.getParams()).toContain(8);
    expect((await query.getResultList()).map(author => author.id)).toEqual(['author-a']);
  });

  test('executes grouped aggregates and HAVING through QueryBuilder', async () => {
    await seed();
    const rows = await orm.em
      .createQueryBuilder(SqlBook, 'b')
      .select(['b.author', raw('count(*) as book_count')])
      .groupBy('b.author')
      .having({ [raw('count(*)')]: { $gte: 2 } })
      .execute('all', false);
    expect(rows).toHaveLength(1);
    expect(rows[0].author_id).toBe('author-a');
    expect(Number(rows[0].book_count)).toBe(2);
  });

  test('paginates scalar queries and joined collections without losing joined rows', async () => {
    await seed();
    const books = await orm.em
      .createQueryBuilder(SqlBook, 'b')
      .select('*')
      .orderBy({ rating: 'desc' })
      .limit(1, 1)
      .getResultList();
    expect(books.map(book => book.id)).toEqual(['book-b']);
    orm.em.clear();
    const authors = await orm.em
      .createQueryBuilder(SqlAuthor, 'a')
      .select('*')
      .leftJoinAndSelect('a.books', 'b')
      .orderBy({ 'a.id': 'asc', 'b.id': 'asc' })
      .limit(1)
      .getResultList();
    expect(authors.map(author => author.id)).toEqual(['author-a']);
    expect(
      authors[0].books
        .getItems()
        .map(book => book.id)
        .sort(),
    ).toEqual(['book-a', 'book-b']);
  });

  test('persists and removes M:N pivot rows, orders collections and updates the inverse side', async () => {
    await seed();
    const alpha = await orm.em.findOneOrFail(SqlBook, 'book-a', {
      populate: ['tags'],
      strategy: LoadStrategy.SELECT_IN,
    });
    const beta = await orm.em.findOneOrFail(SqlBook, 'book-b', {
      populate: ['tags'],
      strategy: LoadStrategy.SELECT_IN,
    });
    const code = alpha.tags.getItems().find(tag => tag.id === 'tag-code')!;
    expect(code).toBe(beta.tags.getItems()[0]);
    expect(alpha.tags.getItems().map(tag => tag.name)).toEqual(['Code', 'Mathematics']);
    const history = await orm.em.findOneOrFail(SqlTag, 'tag-history');
    alpha.tags.remove(code);
    alpha.tags.add(history);
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(SqlBook, 'book-a', {
      populate: ['tags'],
      strategy: LoadStrategy.SELECT_IN,
    });
    expect(reloaded.tags.getItems().map(tag => tag.name)).toEqual(['History', 'Mathematics']);
    const inverse = await orm.em.findOneOrFail(SqlTag, 'tag-code', {
      populate: ['books'],
      strategy: LoadStrategy.JOINED,
    });
    expect(inverse.books.getItems().map(book => book.id)).toEqual(['book-b']);
    const pivotRows = await orm.em.getConnection().execute(`SELECT COUNT(*) AS count FROM \`${pivotTable}\``);
    expect(Number(pivotRows[0].count)).toBe(4);
    await orm.em.remove(reloaded).flush();
    const remainingPivotRows = await orm.em.getConnection().execute(`SELECT COUNT(*) AS count FROM \`${pivotTable}\``);
    expect(Number(remainingPivotRows[0].count)).toBe(2);
  });

  test('enforces the generated unique index for an owning one-to-one relation', async () => {
    await seed();
    const em = orm.em.fork();
    await expect(
      em.insert(SqlProfile, {
        id: 'profile-duplicate',
        bio: 'Duplicate',
        author: 'author-a',
      }),
    ).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    expect(await orm.em.count(SqlProfile)).toBe(1);
  });

  test('rolls back scalar changes and M:N mutations together without replaying the callback', async () => {
    await seed();
    let calls = 0;
    await expect(
      orm.em.fork().transactional(async em => {
        calls++;
        const author = await em.findOneOrFail(SqlAuthor, 'author-a');
        author.name = 'Rolled back';
        const book = await em.findOneOrFail(SqlBook, 'book-a', {
          populate: ['tags'],
          strategy: LoadStrategy.SELECT_IN,
        });
        book.tags.removeAll();
        await em.flush();
        throw new Error('rollback SQL Unit of Work');
      }),
    ).rejects.toThrow('rollback SQL Unit of Work');
    expect(calls).toBe(1);
    orm.em.clear();
    expect((await orm.em.findOneOrFail(SqlAuthor, 'author-a')).name).toBe('Ada');
    const book = await orm.em.findOneOrFail(SqlBook, 'book-a', { populate: ['tags'], strategy: LoadStrategy.JOINED });
    expect(
      book.tags
        .getItems()
        .map(tag => tag.id)
        .sort(),
    ).toEqual(['tag-code', 'tag-math']);
  });
});

describe.skipIf(!enabled)('YDB SQL entity contracts', () => {
  async function withSchema(
    entities: Options<YdbSqlDriver>['entities'],
    run: (orm: MikroORM<YdbSqlDriver>) => Promise<void>,
  ) {
    const orm = await MikroORM.init<YdbSqlDriver>(options(entities));
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

  test('upserts new and existing entities, preserves omitted columns and hydrates excluded merge fields', async () => {
    class UpsertEntity {
      id!: string;
      label!: string;
      kept?: string | null;
    }
    const schema = new EntitySchema<UpsertEntity>({
      class: UpsertEntity,
      tableName: `${prefix}_upsert_single`,
      properties: {
        id: { type: 'string', primary: true },
        label: { type: 'string' },
        kept: { type: 'string', nullable: true },
      },
    });
    await withSchema([schema], async orm => {
      await orm.em.insert(UpsertEntity, { id: 'existing', label: 'original', kept: 'preserved' });
      const created = await orm.em.upsert(UpsertEntity, { id: 'new', label: 'inserted', kept: 'new-value' });
      expect(created).toMatchObject({ id: 'new', label: 'inserted', kept: 'new-value' });
      expect(await orm.em.findOneOrFail(UpsertEntity, 'new')).toBe(created);
      const merged = await orm.em.upsert(UpsertEntity, { id: 'existing', label: 'partial' });
      expect(merged).toMatchObject({ id: 'existing', label: 'partial', kept: 'preserved' });
      expect(await orm.em.findOneOrFail(UpsertEntity, 'existing')).toBe(merged);

      orm.em.clear();
      const excluded = await orm.em.upsert(
        UpsertEntity,
        {
          id: 'existing',
          label: 'merged',
          kept: 'must-not-overwrite',
        },
        { onConflictExcludeFields: ['kept'] },
      );
      expect(excluded).toMatchObject({ id: 'existing', label: 'merged', kept: 'preserved' });
      orm.em.clear();
      expect(await orm.em.findOneOrFail(UpsertEntity, 'existing')).toMatchObject({
        label: 'merged',
        kept: 'preserved',
      });
      expect(await orm.em.findOneOrFail(UpsertEntity, 'new')).toMatchObject({ label: 'inserted', kept: 'new-value' });
    });
  });

  test('upsertMany returns entities in input order and distinguishes partial merge from ignore', async () => {
    class BatchUpsertEntity {
      id!: string;
      label!: string;
      kept?: string | null;
    }
    const schema = new EntitySchema<BatchUpsertEntity>({
      class: BatchUpsertEntity,
      tableName: `${prefix}_upsert_batch`,
      properties: {
        id: { type: 'string', primary: true },
        label: { type: 'string' },
        kept: { type: 'string', nullable: true },
      },
    });
    await withSchema([schema], async orm => {
      await orm.em.insertMany(BatchUpsertEntity, [
        { id: 'existing-a', label: 'original-a', kept: 'keep-a' },
        { id: 'existing-b', label: 'original-b', kept: 'keep-b' },
      ]);
      const merged = await orm.em.upsertMany(
        BatchUpsertEntity,
        [
          { id: 'new-z', label: 'inserted-z', kept: 'keep-z' },
          { id: 'existing-b', label: 'merged-b', kept: 'discard-b' },
          { id: 'existing-a', label: 'merged-a', kept: 'discard-a' },
        ],
        { onConflictExcludeFields: ['kept'] },
      );
      expect(merged.map(entity => entity.id)).toEqual(['new-z', 'existing-b', 'existing-a']);
      expect(merged.map(entity => entity.kept)).toEqual(['keep-z', 'keep-b', 'keep-a']);
      for (const entity of merged) {
        expect(await orm.em.findOneOrFail(BatchUpsertEntity, entity.id)).toBe(entity);
      }

      orm.em.clear();
      const ignored = await orm.em.upsertMany(
        BatchUpsertEntity,
        [
          { id: 'existing-b', label: 'ignored', kept: 'ignored' },
          { id: 'new-y', label: 'inserted-y', kept: 'keep-y' },
        ],
        { onConflictAction: 'ignore' },
      );
      expect(ignored.map(entity => entity.id)).toEqual(['existing-b', 'new-y']);
      expect(ignored[0]).toMatchObject({ label: 'merged-b', kept: 'keep-b' });
      expect(ignored[1]).toMatchObject({ label: 'inserted-y', kept: 'keep-y' });
      orm.em.clear();
      expect(await orm.em.findOneOrFail(BatchUpsertEntity, 'existing-a')).toMatchObject({
        label: 'merged-a',
        kept: 'keep-a',
      });
      expect(await orm.em.findOneOrFail(BatchUpsertEntity, 'existing-b')).toMatchObject({
        label: 'merged-b',
        kept: 'keep-b',
      });
      expect(await orm.em.count(BatchUpsertEntity)).toBe(4);
    });
  });

  test('rejects an ORM upsert conflict target other than the complete primary key before changing data', async () => {
    class ConflictUpsertEntity {
      id!: string;
      label!: string;
      kept?: string | null;
    }
    const schema = new EntitySchema<ConflictUpsertEntity>({
      class: ConflictUpsertEntity,
      tableName: `${prefix}_upsert_conflict`,
      properties: {
        id: { type: 'string', primary: true },
        label: { type: 'string', unique: true },
        kept: { type: 'string', nullable: true },
      },
    });
    await withSchema([schema], async orm => {
      await orm.em.insert(ConflictUpsertEntity, { id: 'original', label: 'unique', kept: 'preserved' });
      await expect(
        orm.em.upsert(
          ConflictUpsertEntity,
          {
            id: 'replacement',
            label: 'unique',
            kept: 'must-not-write',
          },
          { onConflictFields: ['label'] },
        ),
      ).rejects.toThrow(/complete primary key|primary-key columns/i);
      expect(await orm.em.count(ConflictUpsertEntity)).toBe(1);
      expect(await orm.em.findOne(ConflictUpsertEntity, 'replacement')).toBeNull();
      expect(await orm.em.findOneOrFail(ConflictUpsertEntity, 'original')).toMatchObject({ kept: 'preserved' });
    });
  });

  test('hydrates composite-key relations and preserves both key constituents in queries and updates', async () => {
    class CompositeParent {
      tenant!: string;
      code!: number;
      label!: string;
      children = new Collection<CompositeChild>(this);
      [PrimaryKeyProp]?: ['tenant', 'code'];
    }
    class CompositeChild {
      id!: string;
      parent!: CompositeParent;
      label!: string;
    }
    const parentSchema = new EntitySchema<CompositeParent>({
      class: CompositeParent,
      tableName: `${prefix}_composite_parent`,
      properties: {
        tenant: { type: 'string', primary: true },
        code: { type: 'integer', primary: true, autoincrement: false },
        label: { type: 'string' },
        children: { kind: '1:m', entity: () => CompositeChild, mappedBy: 'parent' },
      },
    });
    const childSchema = new EntitySchema<CompositeChild>({
      class: CompositeChild,
      tableName: `${prefix}_composite_child`,
      properties: {
        id: { type: 'string', primary: true },
        parent: { kind: 'm:1', entity: () => CompositeParent, inversedBy: 'children' },
        label: { type: 'string' },
      },
    });
    await withSchema([parentSchema, childSchema], async orm => {
      const first = orm.em.create(CompositeParent, { tenant: 'a', code: 1, label: 'a-one' });
      const second = orm.em.create(CompositeParent, { tenant: 'b', code: 1, label: 'b-one' });
      orm.em.create(CompositeChild, { id: 'child-a', parent: first, label: 'A' });
      orm.em.create(CompositeChild, { id: 'child-b', parent: second, label: 'B' });
      await orm.em.flush();
      orm.em.clear();
      const loaded = await orm.em.findOneOrFail(CompositeParent, ['a', 1], {
        populate: ['children'],
        strategy: LoadStrategy.JOINED,
      });
      expect(loaded.children.getItems().map(child => child.id)).toEqual(['child-a']);
      expect(loaded.children.getItems()[0].parent).toBe(loaded);
      loaded.label = 'changed';
      await orm.em.flush();
      orm.em.clear();
      expect((await orm.em.findOneOrFail(CompositeParent, ['a', 1])).label).toBe('changed');
      expect((await orm.em.findOneOrFail(CompositeParent, ['b', 1])).label).toBe('b-one');
      const joined = await orm.em.findOneOrFail(CompositeChild, 'child-a', {
        populate: ['parent'],
        strategy: LoadStrategy.JOINED,
      });
      expect(joined.parent).toBe(await orm.em.findOneOrFail(CompositeParent, ['a', 1]));
    });
  });

  test('converts custom types for Unit of Work, native mutations and query conditions', async () => {
    class HexType extends Type<number, string> {
      override convertToDatabaseValue(value: number): string {
        return value.toString(16);
      }
      override convertToJSValue(value: string): number {
        return Number.parseInt(value, 16);
      }
      override getColumnType(): string {
        return 'Utf8';
      }
      override compareAsType(): string {
        return 'string';
      }
    }
    class CustomEntity {
      id!: string;
      amount!: number;
    }
    const schema = new EntitySchema<CustomEntity>({
      class: CustomEntity,
      tableName: `${prefix}_custom_type`,
      properties: { id: { type: 'string', primary: true }, amount: { type: new HexType() } },
    });
    await withSchema([schema], async orm => {
      const entity = orm.em.create(CustomEntity, { id: 'custom', amount: 255 });
      await orm.em.flush();
      orm.em.clear();
      const loaded = await orm.em.findOneOrFail(CustomEntity, { amount: 255 });
      expect(loaded.amount).toBe(255);
      expect((await orm.em.getConnection().execute(`SELECT amount FROM \`${prefix}_custom_type\``))[0].amount).toBe(
        'ff',
      );
      loaded.amount = 16;
      await orm.em.flush();
      orm.em.clear();
      expect((await orm.em.findOneOrFail(CustomEntity, 'custom')).amount).toBe(16);
      await orm.em.nativeUpdate(CustomEntity, { id: 'custom' }, { amount: 32 });
      orm.em.clear();
      expect((await orm.em.findOneOrFail(CustomEntity, { amount: 32 })).amount).toBe(32);
      expect((await orm.em.getConnection().execute(`SELECT amount FROM \`${prefix}_custom_type\``))[0].amount).toBe(
        '20',
      );
      await orm.em.insert(CustomEntity, { id: 'native', amount: 1024 });
      expect((await orm.em.findOneOrFail(CustomEntity, 'native')).amount).toBe(1024);
      expect(entity.id).toBe('custom');
    });
  });

  test('rejects a stale optimistic update and keeps the committed version intact', async () => {
    class VersionedEntity {
      id!: string;
      title!: string;
      version!: number;
    }
    const schema = new EntitySchema<VersionedEntity>({
      class: VersionedEntity,
      tableName: `${prefix}_versioned`,
      properties: {
        id: { type: 'string', primary: true },
        title: { type: 'string' },
        version: { type: 'integer', version: true, default: 1 },
      },
    });
    await withSchema([schema], async orm => {
      orm.em.create(VersionedEntity, { id: 'versioned', title: 'original', version: 1 });
      await orm.em.flush();
      const firstEm = orm.em.fork();
      const secondEm = orm.em.fork();
      const first = await firstEm.findOneOrFail(VersionedEntity, 'versioned');
      const second = await secondEm.findOneOrFail(VersionedEntity, 'versioned');
      first.title = 'committed';
      await firstEm.flush();
      expect(first.version).toBe(2);
      second.title = 'stale';
      await expect(secondEm.flush()).rejects.toBeInstanceOf(OptimisticLockError);
      orm.em.clear();
      expect(await orm.em.findOneOrFail(VersionedEntity, 'versioned')).toMatchObject({
        title: 'committed',
        version: 2,
      });
    });
  });

  test('hydrates single-table inheritance subclasses and applies discriminator filters', async () => {
    abstract class SqlContent {
      id!: string;
      title!: string;
    }
    class SqlTextContent extends SqlContent {
      body!: string;
    }
    class SqlImageContent extends SqlContent {
      source!: string;
    }
    const contentSchema = new EntitySchema<SqlContent>({
      class: SqlContent,
      abstract: true,
      tableName: `${prefix}_sti`,
      discriminatorColumn: 'kind',
      discriminatorMap: { text: SqlTextContent, image: SqlImageContent },
      properties: { id: { type: 'string', primary: true }, title: { type: 'string' } },
    });
    const textSchema = new EntitySchema<SqlTextContent, SqlContent>({
      class: SqlTextContent,
      extends: SqlContent,
      discriminatorValue: 'text',
      properties: { body: { type: 'string' } },
    });
    const imageSchema = new EntitySchema<SqlImageContent, SqlContent>({
      class: SqlImageContent,
      extends: SqlContent,
      discriminatorValue: 'image',
      properties: { source: { type: 'string' } },
    });
    await withSchema([contentSchema, textSchema, imageSchema], async orm => {
      orm.em.create(SqlTextContent, { id: 'text', title: 'Text', body: 'Body' });
      orm.em.create(SqlImageContent, { id: 'image', title: 'Image', source: '/image.png' });
      await orm.em.flush();
      orm.em.clear();
      const rows = await orm.em.find(SqlContent, {}, { orderBy: { id: 'asc' } });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toBeInstanceOf(SqlImageContent);
      expect(rows[1]).toBeInstanceOf(SqlTextContent);
      expect((rows[0] as SqlImageContent).source).toBe('/image.png');
      expect((rows[1] as SqlTextContent).body).toBe('Body');
      expect(await orm.em.find(SqlTextContent, {})).toEqual([rows[1]]);
      // A clear fork exercises the SQL discriminator instead of STI's shared-root identity cache.
      expect(await orm.em.fork().findOne(SqlTextContent, 'image')).toBeNull();
      const text = rows[1] as SqlTextContent;
      text.body = 'Updated body';
      await orm.em.flush();
      orm.em.clear();
      expect((await orm.em.findOneOrFail(SqlTextContent, 'text')).body).toBe('Updated body');
    });
  });

  test('hydrates YDB Serial primary keys generated during native and Unit of Work inserts', async () => {
    class SerialEntity {
      id!: number;
      value!: string;
    }
    const schema = new EntitySchema<SerialEntity>({
      class: SerialEntity,
      tableName: `${prefix}_serial`,
      properties: { id: { type: 'integer', primary: true, autoincrement: true }, value: { type: 'string' } },
    });
    await withSchema([schema], async orm => {
      const first = orm.em.create(SerialEntity, { value: 'first' });
      const second = orm.em.create(SerialEntity, { value: 'second' });
      await orm.em.flush();
      expect(Number.isInteger(first.id)).toBe(true);
      expect(Number.isInteger(second.id)).toBe(true);
      expect(first.id).not.toBe(second.id);
      const nativeIds = await orm.em.insertMany(SerialEntity, [{ value: 'third' }, { value: 'fourth' }]);
      expect(nativeIds).toHaveLength(2);
      expect(new Set([first.id, second.id, ...nativeIds]).size).toBe(4);
      orm.em.clear();
      expect((await orm.em.findOneOrFail(SerialEntity, first.id)).value).toBe('first');
      expect(await orm.em.count(SerialEntity)).toBe(4);
    });
  });
});

describe.skipIf(!enabled)('YDB SQL schema evolution', () => {
  const table = `${prefix}_evolution`;
  const schema = (withNote: boolean) =>
    new EntitySchema({
      name: 'SqlEvolution',
      tableName: table,
      properties: {
        id: { type: 'string', primary: true },
        name: { type: 'string' },
        ...(withNote ? { note: { type: 'string', nullable: true } } : {}),
      },
    });

  test('introspects, applies and reverses nullable column changes without touching other tables', async () => {
    const initialSchema = schema(false);
    const expandedSchema = schema(true);
    const initial = await MikroORM.init<YdbSqlDriver>(options([initialSchema]));
    let expanded: MikroORM<YdbSqlDriver> | undefined;
    try {
      await initial.schema.create();
      await initial.em.insert(initialSchema.class, { id: 'preserved', name: 'Original' });
      expanded = await MikroORM.init<YdbSqlDriver>(options([expandedSchema]));
      const migration = await expanded.schema.getUpdateSchemaMigrationSQL({ wrap: false, dropTables: false });
      expect(migration.up).toMatch(/add\s+(?:column\s+)?`?note`?/i);
      expect(migration.down).toMatch(/drop\s+(?:column\s+)?`?note`?/i);
      await expanded.schema.update({ wrap: false, dropTables: false });
      expect(await expanded.schema.getUpdateSchemaSQL({ wrap: false, dropTables: false })).toBe('');
      expect(await expanded.em.findOneOrFail(expandedSchema.class, 'preserved')).toMatchObject({
        id: 'preserved',
        name: 'Original',
        note: null,
      });

      const reverse = await initial.schema.getUpdateSchemaMigrationSQL({ wrap: false, dropTables: false, safe: false });
      expect(reverse.up).toMatch(/drop\s+(?:column\s+)?`?note`?/i);
      await initial.schema.update({ wrap: false, dropTables: false, safe: false });
      expect(await initial.schema.getUpdateSchemaSQL({ wrap: false, dropTables: false })).toBe('');
      expect(await initial.em.findOneOrFail(initialSchema.class, 'preserved')).toMatchObject({
        id: 'preserved',
        name: 'Original',
      });
    } finally {
      await initial.schema.drop();
      await Promise.all([initial.close(true), expanded?.close(true)]);
    }
  });
});

describe.skipIf(!enabled)('YDB SQL migrations', () => {
  const table = `${prefix}_migration_entity`;
  const historyTable = `${prefix}_migration_history`;

  test('generates, applies, records and rolls back a standard MikroORM SQL migration', async () => {
    const migrationPath = await mkdtemp(path.join(import.meta.dirname, '.generated-sql-migrations-'));
    const migratedSchema = new EntitySchema<{ id: string; value: string }>({
      name: 'SqlMigratedEntity',
      tableName: table,
      properties: { id: { type: 'string', primary: true }, value: { type: 'string' } },
    });
    let orm: MikroORM<YdbSqlDriver> | undefined;
    try {
      orm = await MikroORM.init<YdbSqlDriver>({
        ...options([migratedSchema]),
        extensions: [YdbMigrator],
        schemaGenerator: { skipTables: [new RegExp(`^(?!${table}$).+`)] },
        migrations: {
          path: migrationPath,
          emit: 'cjs',
          snapshot: false,
          silent: true,
          tableName: historyTable,
          transactional: false,
          allOrNothing: false,
          dropTables: true,
          safe: false,
        },
      });
      const migrator = orm.migrator as YdbMigrator;
      expect(migrator).toBeInstanceOf(YdbMigrator);
      const generated = await migrator.create(migrationPath, false, false, 'create_sql_entity');
      expect(generated.fileName).toMatch(/create_sql_entity\.cjs$/);
      expect(generated.diff.up.join('\n')).toContain(table);
      expect(generated.diff.down.join('\n')).toMatch(/drop table/i);
      const pending = await migrator.getPending();
      expect(pending).toHaveLength(1);
      expect(await migrator.getExecuted()).toEqual([]);
      const applied = await migrator.up();
      expect(applied).toHaveLength(1);
      const history = await migrator.getExecuted();
      expect(history.map(row => row.name)).toEqual(pending.map(row => row.name));
      expect(history[0].executed_at).toBeInstanceOf(Date);
      expect(await migrator.getPending()).toEqual([]);
      expect(await migrator.up()).toEqual([]);
      expect(await migrator.checkSchema()).toBe(false);
      await orm.em.insert(migratedSchema.class, { id: 'migration-row', value: 'applied' });
      expect(await orm.em.findOneOrFail(migratedSchema.class, 'migration-row')).toMatchObject({ value: 'applied' });
      expect(await migrator.down()).toHaveLength(1);
      expect(await migrator.getExecuted()).toEqual([]);
      expect(await migrator.getPending()).toHaveLength(1);
      await migrator.up();
      expect(await orm.em.count(migratedSchema.class)).toBe(0);
    } finally {
      if (orm) {
        try {
          await orm.schema.drop({ dropMigrationsTable: true });
        } finally {
          await orm.close(true);
        }
      }
      await rm(migrationPath, { recursive: true, force: true });
    }
  });
});
