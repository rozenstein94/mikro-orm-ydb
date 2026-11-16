import { randomUUID } from 'node:crypto';
import { type Configuration, type Dictionary, EntitySchema, type EntityProperty, MikroORM } from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type as WireType, Value as WireValue } from '@ydbjs/api/value';
import {
  createYdbValue,
  YdbConnection,
  YdbNativeQueryBuilder,
  YdbSqlConnection,
  YdbSqlDriver,
  YdbSqlPlatform,
} from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `mikro_order_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const textTable = `${prefix}_text`;
const decimalTable = `${prefix}_decimal`;

class OrderRecord {
  id!: string;
  title!: string;
}

class DecimalOrderRecord {
  id!: string;
  amount!: string;
}

class OrderPlatform extends YdbSqlPlatform {
  protected override validateColumnType(prop: EntityProperty): void {
    for (const declaration of prop.columnTypes ?? []) {
      if (declaration === 'Decimal(35,9)') continue;
      super.validateColumnType({ ...prop, columnTypes: [declaration] });
    }
  }
}

/** Decode the physical Decimal only for a full-projection baseline; writes use native CAST from exact text. */
class OrderNativeConnection extends YdbConnection {
  decodedDecimals = 0;

  protected override decodeResultValue(value: WireValue, type: WireType): unknown {
    if (type.type.case === 'decimalType') {
      if (value.value.case !== 'low128') throw new Error('Expected a finite Decimal Int128 value.');
      this.decodedDecimals++;
      return BigInt.asIntN(128, (value.high128 << 64n) | value.value.value);
    }
    return super.decodeResultValue(value, type);
  }
}

class OrderSqlConnection extends YdbSqlConnection {
  protected override createNativeConnection(): OrderNativeConnection {
    return new OrderNativeConnection(this.config, this.options, this.type);
  }
}

class OrderDriver extends YdbSqlDriver {
  constructor(config: Configuration) {
    super(config, { platform: new OrderPlatform(), connection: OrderSqlConnection });
  }
}

const textRows = [
  { id: 'a', title: 'kilo' },
  { id: 'b', title: 'alpha' },
  { id: 'c', title: 'hotel' },
  { id: 'd', title: 'delta' },
  { id: 'e', title: 'alpha' },
  { id: 'f', title: 'echo' },
  { id: 'g', title: 'bravo' },
  { id: 'h', title: 'juliet' },
  { id: 'i', title: 'golf' },
  { id: 'j', title: 'charlie' },
  { id: 'k', title: 'foxtrot' },
  { id: 'l', title: 'india' },
];
const ascending = [...textRows]
  .sort((left, right) =>
    left.title === right.title ? (left.id < right.id ? 1 : -1) : left.title < right.title ? -1 : 1,
  )
  .map(row => row.id);
const decimals = [
  { id: 'a', amount: '90071992547409931234567890.123456790' },
  { id: 'b', amount: '-90071992547409931234567890.123456789' },
  { id: 'c', amount: '90071992547409931234567890.123456789' },
  { id: 'd', amount: '0.000000001' },
  { id: 'e', amount: '90071992547409931234567890.123456788' },
  { id: 'f', amount: '-0.000000001' },
];
const scaled = (text: string) => BigInt(text.replace('.', ''));
const decimalAscending = [...decimals]
  .sort((left, right) => (scaled(left.amount) < scaled(right.amount) ? -1 : 1))
  .map(row => row.id);

function assertOnlyIds(rows: Dictionary[], expected: string[]): void {
  expect(rows.map(row => row.id)).toEqual(expected);
  for (const row of rows) expect(Object.keys(row)).toEqual(['id']);
}

describe.skipIf(!enabled)('ordering by unselected columns against YDB', () => {
  let orm: MikroORM<OrderDriver, SqlEntityManager<OrderDriver>>;
  const builder = (table = textTable) => new YdbNativeQueryBuilder(orm.driver.getPlatform()).from(table);
  const execute = async (query: YdbNativeQueryBuilder): Promise<Dictionary[]> => {
    const compiled = query.compile();
    return orm.driver.getConnection().execute<Dictionary[]>(compiled.sql, compiled.params, 'all');
  };

  beforeAll(async () => {
    orm = await MikroORM.init<OrderDriver, SqlEntityManager<OrderDriver>>({
      driver: OrderDriver,
      entities: [
        new EntitySchema<OrderRecord>({
          class: OrderRecord,
          tableName: textTable,
          properties: { id: { type: 'string', primary: true }, title: { type: 'string' } },
        }),
        new EntitySchema<DecimalOrderRecord>({
          class: DecimalOrderRecord,
          tableName: decimalTable,
          properties: {
            id: { type: 'string', primary: true },
            amount: { type: 'string', columnType: 'Decimal(35,9)' },
          },
        }),
      ],
      clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
      dbName: process.env.YDB_DATABASE ?? '/local',
      schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
      driverOptions: { connectTimeoutMs: 60_000, queryTimeoutMs: 30_000 },
    });
    await orm.schema.create();
    const shuffled = [7, 2, 10, 0, 11, 4, 8, 1, 9, 5, 3, 6].map(index => textRows[index]);
    await orm.em.fork().insertMany(OrderRecord, shuffled);
    const native = orm.driver.getConnection().getYdbConnection();
    for (const row of decimals) {
      await native.query(
        `INSERT INTO \`${decimalTable}\` (id, amount) VALUES ($id, Unwrap(CAST($amount AS Decimal(35,9))))`,
        { $id: createYdbValue(row.id, 'Utf8'), $amount: createYdbValue(row.amount, 'Utf8') },
      );
    }
  });

  afterAll(async () => {
    if (!orm) return;
    try {
      await orm.schema.drop();
    } finally {
      await orm.close(true);
    }
  });

  test('accepts an explicit outer ORDER BY on qualified hidden source columns after WITHOUT', async () => {
    const sql = `SELECT * WITHOUT \`__ydb_order_0\` FROM (
      SELECT id, title AS \`__ydb_order_0\` FROM \`${textTable}\`
    ) AS \`__ydb_ordered\`
    ORDER BY \`__ydb_ordered\`.\`__ydb_order_0\` ASC, \`__ydb_ordered\`.id DESC`;
    const rows = await orm.driver.getConnection().getYdbConnection().query(sql);
    assertOnlyIds(rows, ascending);
  });

  test('returns the same real order for id-only and id-plus-title projections repeatedly', async () => {
    for (let repetition = 0; repetition < 6; repetition++) {
      const full = await execute(builder().select(['id', 'title']).orderBy('`title` asc, `id` desc'));
      expect(full.map(row => row.id)).toEqual(ascending);
      const partial = await execute(builder().select(['id']).orderBy('`title` asc, `id` desc'));
      assertOnlyIds(partial, ascending);
    }
  });

  test('preserves requested ascending and descending page order across projection removal', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const expected =
        direction === 'asc'
          ? ascending
          : [...textRows]
              .sort((left, right) =>
                left.title === right.title ? (left.id < right.id ? 1 : -1) : left.title > right.title ? -1 : 1,
              )
              .map(row => row.id);
      for (const offset of [0, 2, 5, 8]) {
        const full = await execute(
          builder().select(['id', 'title']).orderBy(`\`title\` ${direction}, \`id\` desc`).limit(3).offset(offset),
        );
        const partial = await execute(
          builder().select(['id']).orderBy(`\`title\` ${direction}, \`id\` desc`).limit(3).offset(offset),
        );
        expect(full.map(row => row.id)).toEqual(expected.slice(offset, offset + 3));
        assertOnlyIds(partial, expected.slice(offset, offset + 3));
      }
    }
  });

  test('keeps one output column inside an ordered and paged IN subquery', async () => {
    const page = () => builder().select(['id']).orderBy('`title` asc, `id` desc').limit(4).offset(2);
    assertOnlyIds(await execute(page()), ascending.slice(2, 6));
    const compiledPage = page().compile();
    const outer = builder()
      .select(['id'])
      .where(`\`id\` IN (${compiledPage.sql})`, compiledPage.params)
      .orderBy('`id` asc');
    assertOnlyIds(await execute(outer), ascending.slice(2, 6).sort());
  });

  test('orders unselected physical Decimal values exactly without Double coercion or leaked columns', async () => {
    for (let repetition = 0; repetition < 4; repetition++) {
      const full = await execute(builder(decimalTable).select(['id', 'amount']).orderBy('`amount` asc, `id` desc'));
      expect(full.map(row => row.id)).toEqual(decimalAscending);
      for (const row of full) {
        expect(typeof row.amount).toBe('bigint');
        expect(row.amount).toBe(scaled(decimals.find(item => item.id === row.id)!.amount));
      }
      assertOnlyIds(
        await execute(builder(decimalTable).select(['id']).orderBy('`amount` asc, `id` desc')),
        decimalAscending,
      );
      assertOnlyIds(
        await execute(builder(decimalTable).select(['id']).orderBy('`amount` asc, `id` desc').limit(3).offset(2)),
        decimalAscending.slice(2, 5),
      );
    }
    expect((orm.driver.getConnection().getYdbConnection() as OrderNativeConnection).decodedDecimals).toBeGreaterThan(0);
  });
});
