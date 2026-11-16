import assert from 'node:assert/strict';
import { Collection, EntitySchema, LoadStrategy, MikroORM } from '@mikro-orm/core';
import { YdbSqlDriver } from '@rozenshtein94/mikro-orm-ydb';

const prefix = `ydb_sql_package_${process.pid}_${Date.now().toString(36)}`;
class Writer {
  books = new Collection(this);
}
class Book {
  tags = new Collection(this);
}
class Tag {
  books = new Collection(this);
}
const WriterSchema = new EntitySchema({
  class: Writer,
  tableName: `${prefix}_writer`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string' },
    books: { kind: '1:m', entity: () => Book, mappedBy: 'writer' },
  },
});
const BookSchema = new EntitySchema({
  class: Book,
  tableName: `${prefix}_book`,
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    payload: { type: 'json' },
    time: { type: 'Date' },
    total: { type: 'bigint' },
    writer: { kind: 'm:1', entity: () => Writer, inversedBy: 'books' },
    tags: { kind: 'm:n', entity: () => Tag, owner: true, inversedBy: 'books', pivotTable: `${prefix}_book_tag` },
  },
});
const TagSchema = new EntitySchema({
  class: Tag,
  tableName: `${prefix}_tag`,
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string' },
    books: { kind: 'm:n', entity: () => Book, mappedBy: 'tags' },
  },
});
const orm = await MikroORM.init({
  driver: YdbSqlDriver,
  entities: [WriterSchema, BookSchema, TagSchema],
  clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
  dbName: process.env.YDB_DATABASE ?? '/local',
  allowGlobalContext: true,
  driverOptions: { connectTimeoutMs: 60_000 },
  schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).*`)] },
});
try {
  await orm.schema.create();
  const time = new Date('2026-01-02T03:04:05.678Z');
  const writer = orm.em.create(Writer, { id: 'writer', name: 'Ada' });
  const tag = orm.em.create(Tag, { id: 'tag', name: 'YQL' });
  const book = orm.em.create(Book, {
    id: 'book',
    title: 'Notes',
    payload: '123',
    time,
    total: 9007199254740991n,
    writer,
  });
  book.tags.add(tag);
  await orm.em.flush();
  orm.em.clear();
  const loaded = await orm.em.findOneOrFail(Book, 'book', {
    populate: ['writer', 'writer.books', 'tags'],
    strategy: LoadStrategy.JOINED,
  });
  assert.equal(loaded.writer.books.getItems()[0], loaded);
  assert.equal(loaded.tags.getItems()[0].name, 'YQL');
  assert.equal(loaded.payload, '123');
  assert.deepEqual(loaded.time, time);
  assert.equal(loaded.total, 9007199254740991n);
  const [rows, count] = await orm.em
    .createQueryBuilder(Book, 'b')
    .select('*')
    .join('b.writer', 'w')
    .where({ 'w.name': 'Ada' })
    .orderBy({ 'b.id': 'asc' })
    .getResultAndCount();
  assert.equal(rows[0], loaded);
  assert.equal(count, 1);
  await assert.rejects(
    orm.em.transactional(async em => {
      const managed = await em.findOneOrFail(Book, 'book');
      managed.title = 'Rollback';
      await em.flush();
      throw new Error('Rollback smoke');
    }),
    /Rollback smoke/,
  );
  assert.equal((await orm.em.fork().findOneOrFail(Book, 'book')).title, 'Notes');
  assert.equal(await orm.schema.getUpdateSchemaSQL({ wrap: false, dropTables: false }), '');
  await orm.schema.clear();
  assert.equal(await orm.em.count(Book), 0);
  console.log('Packaged SQL driver smoke passed');
} finally {
  try {
    await orm.schema.drop();
  } finally {
    await orm.close(true);
  }
}
