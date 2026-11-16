import {
  Collection,
  DeadlockException,
  EntitySchema,
  IsolationLevel,
  MikroORM,
  PrimaryKeyProp,
  TransactionPropagation,
  UniqueConstraintViolationException,
  type EventSubscriber,
  type FilterQuery,
  type Options,
} from '@mikro-orm/core';
import { YdbDriver } from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `mikro_ydb_${process.pid}_${Date.now().toString(36)}`;

class Author {
  id!: string;
  name!: string;
  books = new Collection<Book>(this);
}

class Book {
  id!: string;
  title!: string;
  author!: Author;
  rating!: number;
  published!: boolean;
  note?: string | null;
}

class Sample {
  id!: string;
  label!: string;
  rank!: number;
  active!: boolean;
  optional?: string | null;
  ratio!: number;
  total!: bigint;
  createdAt!: Date;
  payload!: Record<string, unknown>;
  bytes!: Buffer;
}

class Composite {
  tenant!: string;
  code!: number;
  value!: string;
  [PrimaryKeyProp]?: ['tenant', 'code'];
}

class JsonValue {
  id!: string;
  value!: unknown;
}

const authorSchema = new EntitySchema<Author>({
  class: Author,
  tableName: `${prefix}_author`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string', fieldName: 'display_name' },
    books: { kind: '1:m', entity: () => Book, mappedBy: 'author' },
  },
});

const bookSchema = new EntitySchema<Book>({
  class: Book,
  tableName: `${prefix}_book`,
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    author: { kind: 'm:1', entity: () => Author, inversedBy: 'books' },
    rating: { type: 'integer' },
    published: { type: 'boolean' },
    note: { type: 'string', nullable: true },
  },
});

const sampleSchema = new EntitySchema<Sample>({
  class: Sample,
  tableName: `${prefix}_sample`,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string', fieldName: 'display_label' },
    rank: { type: 'integer' },
    active: { type: 'boolean' },
    optional: { type: 'string', nullable: true },
    ratio: { type: 'double' },
    total: { type: 'bigint' },
    createdAt: { type: 'Date' },
    payload: { type: 'json' },
    bytes: { type: 'Buffer' },
  },
});

const compositeSchema = new EntitySchema<Composite>({
  class: Composite,
  tableName: `${prefix}_composite`,
  properties: {
    tenant: { type: 'string', primary: true },
    code: { type: 'integer', primary: true, autoincrement: false },
    value: { type: 'string' },
  },
});

const jsonSchema = new EntitySchema<JsonValue>({
  class: JsonValue,
  tableName: `${prefix}_json`,
  properties: {
    id: { type: 'string', primary: true },
    value: { type: 'json', nullable: true },
  },
});

const jsonValues: [string, unknown][] = [
  ['string-number', '123'],
  ['string-boolean', 'true'],
  ['string-null', 'null'],
  ['string-object', '{"nested":1}'],
  ['string-quoted', '"quoted"'],
  ['string-empty', ''],
  ['number', 123],
  ['boolean', true],
  ['null', null],
  ['array', [1, 'two', null]],
  ['object', { nested: { ok: true } }],
];

function options(entities: Options<YdbDriver>['entities']): Partial<Options<YdbDriver>> {
  return {
    driver: YdbDriver,
    entities,
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    driverOptions: { connectTimeoutMs: 60_000, queryTimeoutMs: 30_000 },
  };
}

function sample(id: string, rank = 1) {
  return {
    id,
    label: `label-${rank}`,
    rank,
    active: rank % 2 === 1,
    optional: rank % 2 === 1 ? null : `note-${rank}`,
    ratio: 1.25,
    total: 9_007_199_254_740_993n,
    createdAt: new Date('2026-01-02T03:04:05.123Z'),
    payload: { nested: { ok: true }, values: [1, 'two', null] },
    bytes: Buffer.from([0, 127, 255]),
  };
}

describe('YDB metadata boundaries', () => {
  test.each([
    {
      name: 'autoincrement',
      schema: new EntitySchema({
        name: 'AutoIncrementBoundary',
        properties: { id: { type: 'integer', primary: true, autoincrement: true } },
      }),
      message: /autoincrement/i,
    },
    {
      name: 'secondary indexes',
      schema: new EntitySchema({
        name: 'IndexBoundary',
        properties: { id: { type: 'string', primary: true }, label: { type: 'string', index: true } },
      }),
      message: /index/i,
    },
    {
      name: 'version properties',
      schema: new EntitySchema({
        name: 'VersionBoundary',
        properties: { id: { type: 'string', primary: true }, version: { type: 'integer', version: true } },
      }),
      message: /version/i,
    },
    {
      name: 'SQL default expressions',
      schema: new EntitySchema({
        name: 'SqlDefaultBoundary',
        properties: { id: { type: 'string', primary: true }, created: { type: 'Date', defaultRaw: 'now()' } },
      }),
      message: /expression|default|unsupported/i,
    },
  ])('rejects $name during metadata discovery', async ({ schema, message }) => {
    await expect(MikroORM.init<YdbDriver>(options([schema]))).rejects.toThrow(message);
  });
});

describe.skipIf(!enabled)('native YDB integration', () => {
  let orm: MikroORM<YdbDriver>;

  beforeAll(async () => {
    orm = await MikroORM.init<YdbDriver>(
      options([authorSchema, bookSchema, sampleSchema, compositeSchema, jsonSchema]),
    );
    await orm.schema.create();
  });

  beforeEach(async () => {
    await orm.schema.clear();
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

  test('creates real tables and introspects an unchanged schema without drift', async () => {
    expect(await orm.schema.getCreateSchemaSQL()).toContain(`${prefix}_sample`);
    expect(await orm.schema.getUpdateSchemaSQL()).toBe('');
    expect(await orm.schema.getUpdateSchemaMigrationSQL()).toEqual({ up: '', down: '' });
    expect(await orm.em.count(Sample)).toBe(0);
  });

  test('persists, hydrates, tracks changes and preserves identity', async () => {
    const original = orm.em.create(Sample, sample('roundtrip'));
    await orm.em.persist(original).flush();
    expect(await orm.em.findOneOrFail(Sample, original.id)).toBe(original);
    orm.em.clear();

    const loaded = await orm.em.findOneOrFail(Sample, 'roundtrip');
    expect(loaded).toMatchObject(sample('roundtrip'));
    expect(loaded.createdAt).toBeInstanceOf(Date);
    expect(typeof loaded.total).toBe('bigint');
    expect(Buffer.isBuffer(loaded.bytes)).toBe(true);
    expect(await orm.em.findOneOrFail(Sample, 'roundtrip')).toBe(loaded);
    loaded.label = 'changed';
    loaded.payload.nested = { ok: false };
    await orm.em.flush();
    orm.em.clear();

    const changed = await orm.em.findOneOrFail(Sample, 'roundtrip');
    expect(changed.label).toBe('changed');
    expect(changed.payload).toEqual({ nested: { ok: false }, values: [1, 'two', null] });
    await orm.em.remove(changed).flush();
    expect(await orm.em.findOne(Sample, 'roundtrip')).toBeNull();
  });

  test('inserts several entities and reports actual native update/delete counts', async () => {
    orm.em.create(Sample, sample('one', 1));
    orm.em.create(Sample, sample('two', 2));
    orm.em.create(Sample, sample('three', 3));
    await orm.em.flush();
    expect(await orm.em.nativeUpdate(Sample, { rank: { $gte: 2 } }, { label: 'updated' })).toBe(2);
    expect(await orm.em.nativeUpdate(Sample, { id: 'missing' }, { label: 'absent' })).toBe(0);
    expect(await orm.em.nativeDelete(Sample, { rank: { $gt: 1 } })).toBe(2);
    expect(await orm.em.nativeDelete(Sample, { id: 'missing' })).toBe(0);
    expect(await orm.em.count(Sample)).toBe(1);
  });

  test('returns every native insertMany primary key, including ordered composite keys', async () => {
    const simpleIds = await orm.em.insertMany(Sample, [sample('native-one'), sample('native-two')]);
    expect(simpleIds).toEqual(['native-one', 'native-two']);
    const compositeIds = await orm.em.insertMany(Composite, [
      { tenant: 'native', code: 10, value: 'one' },
      { tenant: 'native', code: 20, value: 'two' },
    ]);
    expect(compositeIds).toEqual([
      ['native', 10],
      ['native', 20],
    ]);
    expect(await orm.em.count(Sample)).toBe(2);
    expect(await orm.em.count(Composite)).toBe(2);
    expect(await orm.em.insertMany(Sample, [])).toEqual([]);
  });

  test('preserves JSON primitives and JSON-looking strings through native inserts', async () => {
    for (const [id, value] of jsonValues) {
      await orm.em.insert(JsonValue, { id, value });
    }
    orm.em.clear();
    for (const [id, value] of jsonValues) {
      const loaded = await orm.em.findOneOrFail(JsonValue, id);
      expect(loaded.value).toEqual(value);
      expect(typeof loaded.value).toBe(typeof value);
    }
  });

  test('preserves JSON primitives and JSON-looking strings through Unit of Work persistence', async () => {
    for (const [id, value] of jsonValues) {
      orm.em.create(JsonValue, { id, value });
    }
    await orm.em.flush();
    orm.em.clear();
    for (const [id, value] of jsonValues) {
      const loaded = await orm.em.findOneOrFail(JsonValue, id);
      expect(loaded.value).toEqual(value);
      expect(typeof loaded.value).toBe(typeof value);
    }
  });

  test('loads selected fields with primary keys and hydrates the same entity on a later full read', async () => {
    await orm.em.insert(Sample, sample('projection'));
    const selected = await orm.em.findOneOrFail(Sample, 'projection', { fields: ['label'] });
    expect(selected.id).toBe('projection');
    expect(selected.label).toBe('label-1');
    expect((selected as Sample).rank).toBeUndefined();
    const full = await orm.em.findOneOrFail(Sample, 'projection');
    expect(full).toBe(selected);
    expect(full.rank).toBe(1);
  });

  test('binds values instead of interpolating SQL text', async () => {
    const injection = "quote'`; DELETE FROM anything; -- \\ \n";
    await orm.em.persist(orm.em.create(Sample, { ...sample(injection), label: injection })).flush();
    orm.em.clear();
    expect((await orm.em.findOneOrFail(Sample, { label: injection })).id).toBe(injection);
    expect(await orm.em.count(Sample)).toBe(1);
  });

  test('supports scalar and logical filters, deterministic ordering and pagination', async () => {
    for (let rank = 1; rank <= 5; rank++) {
      orm.em.create(Sample, sample(`row-${rank}`, rank));
    }
    await orm.em.flush();
    orm.em.clear();

    const ranks = async (where: FilterQuery<Sample>) =>
      (await orm.em.find(Sample, where, { orderBy: { rank: 'asc' } })).map(entity => entity.rank);
    expect(await ranks({ rank: { $eq: 3 } })).toEqual([3]);
    expect(await ranks({ rank: { $ne: 3 } })).toEqual([1, 2, 4, 5]);
    expect(await ranks({ rank: { $gt: 3 } })).toEqual([4, 5]);
    expect(await ranks({ rank: { $gte: 3 } })).toEqual([3, 4, 5]);
    expect(await ranks({ rank: { $lt: 3 } })).toEqual([1, 2]);
    expect(await ranks({ rank: { $lte: 3 } })).toEqual([1, 2, 3]);
    expect(await ranks({ rank: { $in: [1, 4] } })).toEqual([1, 4]);
    expect(await ranks({ rank: { $nin: [1, 4] } })).toEqual([2, 3, 5]);
    expect(await ranks({ rank: { $in: [] } })).toEqual([]);
    expect(await ranks({ rank: { $nin: [] } })).toEqual([1, 2, 3, 4, 5]);
    expect(await ranks({ $and: [{ rank: { $gte: 2 } }, { rank: { $lte: 4 } }] })).toEqual([2, 3, 4]);
    expect(await ranks({ $or: [{ rank: 1 }, { rank: 5 }] })).toEqual([1, 5]);
    expect(await ranks({ $not: { rank: { $lte: 3 } } })).toEqual([4, 5]);
    expect(await ranks({ label: { $like: 'label-%' } })).toEqual([1, 2, 3, 4, 5]);
    expect(await ranks({ optional: null })).toEqual([1, 3, 5]);
    expect(await ranks({ optional: { $ne: null } })).toEqual([2, 4]);
    expect(await ranks({ active: true })).toEqual([1, 3, 5]);
    expect(
      (await orm.em.find(Sample, {}, { orderBy: { rank: 'desc' }, offset: 1, limit: 2 })).map(row => row.rank),
    ).toEqual([4, 3]);
  });

  test('loads both sides of select-in relations using the same identity map', async () => {
    const author = orm.em.create(Author, { id: 'author', name: 'Ada' });
    const first = orm.em.create(Book, {
      id: 'first',
      title: 'First',
      author,
      rating: 1,
      published: true,
    });
    const second = orm.em.create(Book, {
      id: 'second',
      title: 'Second',
      author,
      rating: 2,
      published: false,
    });
    await orm.em.persist([author, first, second]).flush();
    orm.em.clear();

    const loadedAuthor = await orm.em.findOneOrFail(Author, 'author', { populate: ['books'] });
    expect(loadedAuthor.books.isInitialized()).toBe(true);
    expect(
      loadedAuthor.books
        .getItems()
        .map(book => book.id)
        .sort(),
    ).toEqual(['first', 'second']);
    const loadedBook = await orm.em.findOneOrFail(Book, 'first', { populate: ['author'] });
    expect(loadedBook.author).toBe(loadedAuthor);
    expect(loadedAuthor.books.getItems().find(book => book.id === 'first')).toBe(loadedBook);
    loadedBook.author.name = 'Grace';
    await orm.em.flush();
    orm.em.clear();
    expect((await orm.em.findOneOrFail(Book, 'second', { populate: ['author'] })).author.name).toBe('Grace');
  });

  test('propagates inverse collection additions to owning references for new and managed owners', async () => {
    const author = orm.em.create(Author, { id: 'collection-owner', name: 'Owner' });
    const first = orm.em.create(
      Book,
      {
        id: 'collection-first',
        title: 'First',
        rating: 1,
        published: true,
      },
      { partial: true },
    );
    author.books.add(first);
    expect(first.author).toBe(author);
    await orm.em.flush();
    orm.em.clear();

    const loaded = await orm.em.findOneOrFail(Author, 'collection-owner', { populate: ['books'] });
    expect(loaded.books.getItems().map(book => book.id)).toEqual(['collection-first']);
    const second = orm.em.create(
      Book,
      {
        id: 'collection-second',
        title: 'Second',
        rating: 2,
        published: true,
      },
      { partial: true },
    );
    loaded.books.add(second);
    expect(second.author).toBe(loaded);
    await orm.em.flush();
    orm.em.clear();

    const reloaded = await orm.em.findOneOrFail(Author, 'collection-owner', { populate: ['books'] });
    expect(
      reloaded.books
        .getItems()
        .map(book => book.id)
        .sort(),
    ).toEqual(['collection-first', 'collection-second']);
    expect((await orm.em.findOneOrFail(Book, 'collection-second', { populate: ['author'] })).author).toBe(reloaded);
  });

  test('supports composite keys through insert, find, change tracking and batched UoW deletion', async () => {
    const rows = [
      orm.em.create(Composite, { tenant: 'a', code: 1, value: 'a-one' }),
      orm.em.create(Composite, { tenant: 'a', code: 2, value: 'a-two' }),
      orm.em.create(Composite, { tenant: 'b', code: 1, value: 'b-one' }),
    ];
    await orm.em.persist(rows).flush();
    orm.em.clear();
    const loaded = await orm.em.findOneOrFail(Composite, { tenant: 'a', code: 1 });
    loaded.value = 'changed';
    await orm.em.flush();
    orm.em.clear();
    expect((await orm.em.findOneOrFail(Composite, ['a', 1])).value).toBe('changed');
    const deleted = await orm.em.find(Composite, { tenant: 'a' });
    await orm.em.remove(deleted).flush();
    expect(await orm.em.find(Composite, {})).toMatchObject([{ tenant: 'b', code: 1, value: 'b-one' }]);
  });

  test('rolls back failed transactions without replaying the application callback', async () => {
    let calls = 0;
    await expect(
      orm.em.transactional(async em => {
        calls++;
        em.create(Sample, sample('rolled-back'));
        await em.flush();
        expect(await em.count(Sample)).toBe(1);
        throw new Error('abort application transaction');
      }),
    ).rejects.toThrow('abort application transaction');
    expect(calls).toBe(1);
    orm.em.clear();
    expect(await orm.em.count(Sample)).toBe(0);

    await orm.em.transactional(
      async em => {
        em.create(Sample, sample('committed'));
      },
      { isolationLevel: IsolationLevel.SERIALIZABLE },
    );
    expect(await orm.em.count(Sample)).toBe(1);
  });

  test('supports imperative transactions and their lifecycle events', async () => {
    const events: string[] = [];
    const subscriber: EventSubscriber = {
      beforeTransactionStart: () => {
        events.push('beforeStart');
      },
      afterTransactionStart: () => {
        events.push('afterStart');
      },
      beforeTransactionCommit: () => {
        events.push('beforeCommit');
      },
      afterTransactionCommit: () => {
        events.push('afterCommit');
      },
      beforeTransactionRollback: () => {
        events.push('beforeRollback');
      },
      afterTransactionRollback: () => {
        events.push('afterRollback');
      },
    };
    const em = orm.em.fork({ cloneEventManager: true });
    em.getEventManager().registerSubscriber(subscriber);
    await em.begin();
    em.create(Sample, sample('explicit-commit'));
    await em.flush();
    await em.commit();
    expect(events).toEqual(['beforeStart', 'afterStart', 'beforeCommit', 'afterCommit']);
    events.length = 0;
    await em.begin();
    em.create(Sample, sample('explicit-rollback'));
    await em.flush();
    await em.rollback();
    expect(events).toEqual(['beforeStart', 'afterStart', 'beforeRollback', 'afterRollback']);
    expect(await orm.em.findOne(Sample, 'explicit-commit')).not.toBeNull();
    expect(await orm.em.findOne(Sample, 'explicit-rollback')).toBeNull();
  });

  test('surfaces a real serializable conflict and permits an explicit retry in a fresh transaction', async () => {
    await orm.em.insert(Sample, sample('conflict', 1));
    let bodies = 0;
    let readers = 0;
    let releaseReaders!: () => void;
    const bothRead = new Promise<void>(resolve => {
      releaseReaders = resolve;
    });
    const attempt = () =>
      orm.em.fork().transactional(async em => {
        bodies++;
        const row = await em.findOneOrFail(Sample, 'conflict');
        readers++;
        if (readers === 2) {
          releaseReaders();
        }
        await bothRead;
        row.rank++;
        await em.flush();
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(bodies).toBe(2);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : undefined).toBeInstanceOf(DeadlockException);
    orm.em.clear();
    expect((await orm.em.findOneOrFail(Sample, 'conflict')).rank).toBe(2);

    await orm.em.fork().transactional(async em => {
      const row = await em.findOneOrFail(Sample, 'conflict');
      row.rank++;
    });
    orm.em.clear();
    expect((await orm.em.findOneOrFail(Sample, 'conflict')).rank).toBe(3);
  });

  test('rejects nested transactions and unsupported isolation levels explicitly', async () => {
    await expect(
      orm.em.transactional(async em => {
        await em.transactional(async () => undefined);
      }),
    ).rejects.toThrow(/nested|savepoint|unsupported/i);
    await expect(
      orm.em.transactional(async () => undefined, {
        isolationLevel: IsolationLevel.READ_UNCOMMITTED,
      }),
    ).rejects.toThrow(/isolation|serializable|unsupported/i);
  });

  test('reuses an existing transaction under REQUIRED propagation without creating a savepoint', async () => {
    await orm.em.transactional(async em => {
      await expect(em.begin({ ctx: em.getTransactionContext() })).rejects.toThrow(/nested|savepoint|unsupported/i);
      await em.transactional(
        async inner => {
          inner.create(Sample, sample('required-propagation'));
        },
        { propagation: TransactionPropagation.REQUIRED },
      );
    });
    expect(await orm.em.count(Sample)).toBe(1);
  });

  test('converts duplicate-key errors and keeps the connection usable', async () => {
    await orm.em.insert(Sample, sample('duplicate'));
    await expect(orm.em.insert(Sample, sample('duplicate'))).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    expect(await orm.em.count(Sample)).toBe(1);
    await orm.em.insert(Sample, sample('after-duplicate'));
    expect(await orm.em.count(Sample)).toBe(2);
  });

  test('reuses one native client and reconnects after a clean shutdown', async () => {
    const connection = orm.em.getConnection();
    const [first, second] = await Promise.all([connection.getNativeClient(), connection.getNativeClient()]);
    expect(first).toBe(second);
    expect(await connection.checkConnection()).toEqual({ ok: true });
    await orm.close(true);
    expect(await connection.isConnected()).toBe(false);
    await orm.connect();
    expect(await orm.em.count(Sample)).toBe(0);
    expect(await connection.isConnected()).toBe(true);
  });

  test('initializes lazily and shares concurrent connection startup', async () => {
    const lazy = new MikroORM<YdbDriver>(options([sampleSchema]));
    try {
      const connection = lazy.em.getConnection();
      expect(await connection.isConnected()).toBe(false);
      const counts = await Promise.all(Array.from({ length: 8 }, () => lazy.em.fork().count(Sample)));
      expect(counts).toEqual(Array(8).fill(0));
      expect(await connection.isConnected()).toBe(true);
    } finally {
      await lazy.close(true);
    }
  });
});

describe.skipIf(!enabled)('YDB schema evolution', () => {
  const table = `${prefix}_evolution`;
  const schema = (extra?: 'string' | 'integer') =>
    new EntitySchema({
      name: 'Evolution',
      tableName: table,
      properties: {
        id: { type: 'string', primary: true },
        ...(extra ? { extra: { type: extra, nullable: true } } : {}),
      },
    });

  test('plans reversible nullable-column changes and rejects incompatible changes before applying them', async () => {
    const initial = await MikroORM.init<YdbDriver>(options([schema()]));
    let expanded: MikroORM<YdbDriver> | undefined;
    let incompatible: MikroORM<YdbDriver> | undefined;
    try {
      await initial.schema.create();
      expanded = await MikroORM.init<YdbDriver>(options([schema('string')]));
      const migration = await expanded.schema.getUpdateSchemaMigrationSQL();
      expect(migration.up).toMatch(/ADD COLUMN.*extra/is);
      expect(migration.down).toMatch(/DROP COLUMN.*extra/is);
      await expanded.schema.update();
      expect(await expanded.schema.getUpdateSchemaSQL()).toBe('');

      incompatible = await MikroORM.init<YdbDriver>(options([schema('integer')]));
      await expect(incompatible.schema.getUpdateSchemaSQL()).rejects.toThrow(/type|incompatible|unsupported/i);
      await expect(incompatible.schema.update()).rejects.toThrow(/type|incompatible|unsupported/i);
      expect(await expanded.schema.getUpdateSchemaSQL()).toBe('');

      const removed = await initial.schema.getUpdateSchemaMigrationSQL({ safe: false });
      expect(removed.up).toMatch(/DROP COLUMN.*extra/is);
      expect(removed.down).toMatch(/ADD COLUMN.*extra/is);
      await initial.schema.update({ safe: false });
      expect(await initial.schema.getUpdateSchemaSQL()).toBe('');
    } finally {
      await initial.schema.drop();
      await Promise.all([initial.close(true), expanded?.close(true), incompatible?.close(true)]);
    }
  });
});
