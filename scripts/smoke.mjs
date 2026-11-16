// Run this file from a consumer after installing the built release archive.
import assert from 'node:assert/strict';
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { YdbDriver } from '@rozenstein/mikro-orm-ydb';

const Note = new EntitySchema({
  name: 'PackedNote',
  tableName: `packed_note_${process.pid}_${Date.now().toString(36)}`,
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    data: { type: 'json', nullable: true },
  },
});

const orm = await MikroORM.init({
  driver: YdbDriver,
  entities: [Note],
  clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
  dbName: process.env.YDB_DATABASE ?? '/local',
});

try {
  await orm.schema.create();
  const em = orm.em.fork();
  const note = em.create('PackedNote', { id: 'packed', title: 'Archive installed', data: '123' });
  await em.persist(note).flush();
  assert.equal(await em.findOneOrFail('PackedNote', note.id), note);
  em.clear();
  assert.equal((await em.findOneOrFail('PackedNote', note.id)).data, '123');
  await assert.rejects(
    em.transactional(async tx => {
      await tx.nativeUpdate('PackedNote', { id: note.id }, { title: 'Rolled back' });
      throw new Error('smoke rollback');
    }),
    /smoke rollback/,
  );
  em.clear();
  assert.equal((await em.findOneOrFail('PackedNote', note.id)).title, 'Archive installed');
  assert.equal(await orm.schema.getUpdateSchemaSQL(), '');
} finally {
  await orm.schema.drop();
  await orm.close(true);
}

console.log('Packed driver smoke passed');
