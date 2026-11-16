import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { YdbSqlDriver, YdbSqlPlatform } from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const tableName = `mikro_ydb_nullable_date_${process.pid}_${Date.now().toString(36)}`;

class NullableDateRecord {
  id!: string;
  label!: string;
  removedAt?: Date | null;
}

const schema = new EntitySchema<NullableDateRecord>({
  class: NullableDateRecord,
  tableName,
  properties: {
    id: { type: 'string', primary: true },
    label: { type: 'string' },
    removedAt: { type: Date, nullable: true },
  },
});

function options() {
  return {
    driver: YdbSqlDriver,
    entities: [schema],
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://127.0.0.1:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    schemaGenerator: { skipTables: [new RegExp(`^(?!${tableName}$).*`)] },
  };
}

describe('nullable SQL Date snapshots', () => {
  test('preserves nullish values and retains ordinary Date conversion', () => {
    const platform = new YdbSqlPlatform();
    expect(platform.processDateProperty(null)).toBeNull();
    expect(platform.processDateProperty(undefined)).toBeUndefined();
    const date = new Date('2026-11-16T01:02:03.456Z');
    expect(platform.processDateProperty(date)).toBe(date);
    expect(platform.processDateProperty(date.toISOString())).toEqual(date);
  });

  test('keeps null and omitted dates distinct in the core EntityComparator', async () => {
    const orm = await MikroORM.init<YdbSqlDriver>(options());
    try {
      expect(orm.getMetadata(NullableDateRecord).properties.removedAt.runtimeType).toBe('Date');
      const entity = orm.em.create(NullableDateRecord, { id: 'snapshot', label: 'Snapshot', removedAt: null });
      const comparator = orm.em.getComparator();
      expect(comparator.prepareEntity(entity).removedAt).toBeNull();
      entity.removedAt = undefined;
      expect(comparator.prepareEntity(entity)).not.toHaveProperty('removedAt');
      const date = new Date('2026-11-16T01:02:03.456Z');
      entity.removedAt = date;
      const snapshot = comparator.prepareEntity(entity);
      expect(snapshot.removedAt).toEqual(date);
      expect(snapshot.removedAt).not.toBe(date);
    } finally {
      await orm.close(true);
    }
  });
});

describe.skipIf(!enabled)('nullable SQL Date Unit of Work on real YDB', () => {
  let orm: MikroORM<YdbSqlDriver>;
  const flushPayloads: Record<string, unknown>[][] = [];

  beforeAll(async () => {
    orm = await MikroORM.init<YdbSqlDriver>(options());
    orm.em.getEventManager().registerSubscriber({
      onFlush: ({ uow }) => {
        flushPayloads.push(uow.getChangeSets().map(changeSet => ({ ...changeSet.payload })));
      },
    });
    await orm.schema.create();
  });

  beforeEach(async () => {
    await orm.schema.clear({ truncate: false });
    orm.em.clear();
    flushPayloads.length = 0;
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

  async function storedDate(id: string) {
    const rows = await orm.em.getConnection().execute(`SELECT removed_at FROM \`${tableName}\` WHERE id = ?`, [id]);
    return rows[0].removed_at;
  }

  test('persists NULL, preserves identity and avoids phantom updates after hydration', async () => {
    orm.em.create(NullableDateRecord, { id: 'null', label: 'Original', removedAt: null });
    await orm.em.flush();
    expect(await storedDate('null')).toBeNull();
    orm.em.clear();
    const loaded = await orm.em.findOneOrFail(NullableDateRecord, 'null');
    expect(loaded.removedAt).toBeNull();
    expect(await orm.em.findOneOrFail(NullableDateRecord, 'null')).toBe(loaded);
    expect(orm.em.getComparator().prepareEntity(loaded).removedAt).toBeNull();

    flushPayloads.length = 0;
    await orm.em.flush();
    expect(flushPayloads.flat()).toEqual([]);
    loaded.label = 'Updated';
    await orm.em.flush();
    expect(flushPayloads.flat()).toEqual([{ label: 'Updated' }]);
    expect(await storedDate('null')).toBeNull();
    orm.em.clear();
    expect((await orm.em.findOneOrFail(NullableDateRecord, 'null')).removedAt).toBeNull();
  });

  test('round-trips Date to NULL and back while leaving omitted nullable dates absent', async () => {
    const date = new Date('2026-11-16T01:02:03.456Z');
    const entity = orm.em.create(NullableDateRecord, { id: 'transition', label: 'Dated', removedAt: date });
    orm.em.create(NullableDateRecord, { id: 'omitted', label: 'Omitted' });
    await orm.em.flush();
    expect(await storedDate('transition')).toEqual(date);
    expect(await storedDate('omitted')).toBeNull();

    entity.removedAt = null;
    await orm.em.flush();
    expect(await storedDate('transition')).toBeNull();
    orm.em.clear();
    const loaded = await orm.em.findOneOrFail(NullableDateRecord, 'transition');
    expect(loaded.removedAt).toBeNull();
    const replacement = new Date('2026-11-16T04:05:06.789Z');
    loaded.removedAt = replacement;
    await orm.em.flush();
    orm.em.clear();
    const reloaded = await orm.em.findOneOrFail(NullableDateRecord, 'transition');
    expect(reloaded.removedAt).toEqual(replacement);
    expect(await storedDate('transition')).toEqual(replacement);
    flushPayloads.length = 0;
    await orm.em.flush();
    expect(flushPayloads.flat()).toEqual([]);
  });
});
