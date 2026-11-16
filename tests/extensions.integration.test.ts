import { create } from '@bufbuild/protobuf';
import { type Configuration, EntitySchema, type EntityProperty, MikroORM, Type } from '@mikro-orm/core';
import {
  DecimalTypeSchema,
  type Type as WireType,
  TypeSchema,
  type Value as WireValue,
  ValueSchema,
} from '@ydbjs/api/value';
import { type Type as SdkType, TypeKind, type Value } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import { YdbConnection, YdbNativeQueryBuilder, YdbSqlConnection, YdbSqlDriver, YdbSqlPlatform } from '../src/index.js';

const enabled = process.env.YDB_INTEGRATION === '1';
const prefix = `mikro_ydb_ext_${process.pid}_${Date.now().toString(36)}`;
const tableName = `${prefix}_amount`;

function decimalParameters(declaration: string): { precision: number; scale: number } {
  const match = /^Decimal\((\d+),\s*(\d+)\)$/i.exec(declaration);
  const precision = Number(match?.[1]);
  const scale = Number(match?.[2]);
  if (!match || precision < 1 || precision > 35 || scale < 0 || scale > precision) {
    throw new Error(`The Decimal extension requires precision 1..35 and scale 0..precision: ${declaration}`);
  }
  return { precision, scale };
}

/** The pinned SDK exposes the public Value/Type protocol, but has no Decimal implementation. */
class DecimalWireType implements SdkType {
  readonly kind = TypeKind.DECIMAL;

  constructor(
    readonly precision: number,
    readonly scale: number,
  ) {
    decimalParameters(`Decimal(${precision},${scale})`);
  }

  encode(): WireType {
    return create(TypeSchema, {
      type: {
        case: 'decimalType',
        value: create(DecimalTypeSchema, { precision: this.precision, scale: this.scale }),
      },
    });
  }
}

/** Finite exact Decimal: signed scaled Int128, following the official YDB Python SDK wire codec.
 * https://github.com/ydb-platform/ydb-python-sdk/blob/main/ydb/convert.py
 * This consumer codec deliberately rejects rounding, exponents, Infinity, NaN, and JS numbers.
 */
class ExactDecimalValue implements Value<DecimalWireType> {
  readonly type: DecimalWireType;
  readonly scaled: bigint;

  constructor(value: string, precision = 35, scale = 9) {
    this.type = new DecimalWireType(precision, scale);
    const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) : null;
    if (!match || (match[3]?.length ?? 0) > scale) {
      throw new Error('Exact Decimal requires a finite decimal string without rounding.');
    }
    const digits = `${match[2]}${(match[3] ?? '').padEnd(scale, '0')}`;
    this.scaled = BigInt(`${match[1]}${digits}`);
    if (this.scaled <= -(10n ** BigInt(precision)) || this.scaled >= 10n ** BigInt(precision)) {
      throw new Error(`Exact Decimal exceeds precision ${precision}.`);
    }
  }

  encode(): WireValue {
    return create(ValueSchema, {
      value: { case: 'low128', value: BigInt.asUintN(64, this.scaled) },
      high128: BigInt.asUintN(64, this.scaled >> 64n),
    });
  }

  toString(): string {
    const negative = this.scaled < 0n;
    const digits = (negative ? -this.scaled : this.scaled).toString().padStart(this.type.scale + 1, '0');
    const text = this.type.scale ? `${digits.slice(0, -this.type.scale)}.${digits.slice(-this.type.scale)}` : digits;
    return `${negative ? '-' : ''}${text}`;
  }

  static decode(value: WireValue, precision: number, scale: number): ExactDecimalValue {
    if (value.value.case !== 'low128') throw new Error('Expected the YDB Decimal Int128 wire representation.');
    const scaled = (BigInt.asIntN(64, value.high128) << 64n) + value.value.value;
    const negative = scaled < 0n;
    const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
    const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    return new ExactDecimalValue(`${negative ? '-' : ''}${text}`, precision, scale);
  }
}

type DecimalInput = ExactDecimalValue | string | null | undefined;

class ExactDecimalType extends Type<string | null | undefined, DecimalInput> {
  constructor(
    readonly precision = 35,
    readonly scale = 9,
  ) {
    super();
    decimalParameters(`Decimal(${precision},${scale})`);
  }

  override convertToDatabaseValue(value: DecimalInput): ExactDecimalValue | null | undefined {
    if (value == null || value instanceof ExactDecimalValue) return value;
    return new ExactDecimalValue(value, this.precision, this.scale);
  }

  override convertToJSValue(value: DecimalInput): string | null | undefined {
    if (value == null) return value;
    return (
      value instanceof ExactDecimalValue ? value : new ExactDecimalValue(value, this.precision, this.scale)
    ).toString();
  }

  override compareValues(a: DecimalInput, b: DecimalInput): boolean {
    return this.convertToJSValue(a) === this.convertToJSValue(b);
  }

  override getColumnType(): string {
    return `Decimal(${this.precision},${this.scale})`;
  }
}

class StrictDecimalPlatform extends YdbSqlPlatform {
  protected override validateColumnType(prop: EntityProperty): void {
    for (const declaration of prop.columnTypes ?? []) {
      if (/^Decimal/i.test(declaration)) decimalParameters(declaration);
      else super.validateColumnType({ ...prop, columnTypes: [declaration] });
    }
  }

  override getDefaultMappedType(type: string) {
    if (!/^Decimal/i.test(type)) return super.getDefaultMappedType(type);
    const { precision, scale } = decimalParameters(type);
    return new ExactDecimalType(precision, scale);
  }

  override createParameterValue(value: unknown, declaration: string): Value {
    const nullable = declaration.endsWith('?');
    const plain = declaration.replace(/\?$/, '');
    if (!/^Decimal/i.test(plain)) return super.createParameterValue(value, declaration);
    const { precision, scale } = decimalParameters(plain);
    const type = new DecimalWireType(precision, scale);
    if (value == null) {
      if (!nullable) throw new Error('A required exact Decimal cannot receive null.');
      return new Optional(null, type);
    }
    const decimal =
      value instanceof ExactDecimalValue ? value : new ExactDecimalValue(value as string, precision, scale);
    if (decimal.type.precision !== precision || decimal.type.scale !== scale) {
      throw new Error('The exact Decimal parameter type must match its column declaration.');
    }
    return nullable ? new Optional(decimal) : decimal;
  }
}

class DecimalNativeConnection extends YdbConnection {
  readonly decimalDeclarations: string[] = [];
  decodedDecimals = 0;

  protected override getParameterTypeDeclaration(value: Value): string {
    const declaration = this.decimalDeclaration(value.type.encode());
    if (!declaration) return super.getParameterTypeDeclaration(value);
    this.decimalDeclarations.push(declaration);
    return declaration;
  }

  private decimalDeclaration(type: WireType): string | undefined {
    if (type.type.case === 'decimalType') {
      const { precision, scale } = type.type.value;
      decimalParameters(`Decimal(${precision},${scale})`);
      return `Decimal(${precision},${scale})`;
    }
    if (type.type.case === 'optionalType' && type.type.value.item) {
      const inner = this.decimalDeclaration(type.type.value.item);
      return inner ? `Optional<${inner}>` : undefined;
    }
    return undefined;
  }

  protected override decodeResultValue(value: WireValue, type: WireType): unknown {
    if (type.type.case === 'optionalType' && type.type.value.item && this.decimalDeclaration(type)) {
      if (value.value.case === 'nullFlagValue') return null;
      return this.decodeResultValue(
        value.value.case === 'nestedValue' ? value.value.value : value,
        type.type.value.item,
      );
    }
    if (type.type.case === 'decimalType') {
      this.decodedDecimals++;
      return ExactDecimalValue.decode(value, type.type.value.precision, type.type.value.scale).toString();
    }
    return super.decodeResultValue(value, type);
  }
}

class DecimalSqlConnection extends YdbSqlConnection {
  protected override createNativeConnection(): DecimalNativeConnection {
    return new DecimalNativeConnection(this.config, this.options, this.type);
  }
}

class DecimalDriver extends YdbSqlDriver {
  constructor(config: Configuration) {
    super(config, { platform: new StrictDecimalPlatform(), connection: DecimalSqlConnection });
  }
}

class DecimalRecord {
  id!: string;
  amount!: string;
  adjustment?: string | null;
  rebate?: string | null;
}

function schema(withRebate = false) {
  return new EntitySchema<DecimalRecord>({
    class: DecimalRecord,
    tableName,
    properties: {
      id: { type: 'string', primary: true, fieldName: 'record_key' },
      amount: { type: new ExactDecimalType(), fieldName: 'total_amount' },
      adjustment: { type: new ExactDecimalType(), nullable: true, fieldName: 'optional_adjustment' },
      rebate: { type: new ExactDecimalType(22, 9), nullable: true, fieldName: 'rebate_amount', persist: withRebate },
    },
  });
}

async function initialize(withRebate = false) {
  return MikroORM.init<DecimalDriver>({
    driver: DecimalDriver,
    entities: [schema(withRebate)],
    clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
    dbName: process.env.YDB_DATABASE ?? '/local',
    allowGlobalContext: true,
    schemaGenerator: { skipTables: [new RegExp(`^(?!${prefix}_).+`)] },
    driverOptions: { connectTimeoutMs: 60_000, queryTimeoutMs: 30_000 },
  });
}

const exact = '90071992547409931234567890.123456789';
const adjacent = '90071992547409931234567890.123456790';

describe('consumer-owned exact Decimal codec', () => {
  test.each([exact, adjacent, `-${exact}`, '0.000000001', '-0.000000001', '0.000000000'])(
    'round trips signed Int128 without JS number conversion: %s',
    value => {
      const decimal = new ExactDecimalValue(value);
      expect(decimal.type.encode().type).toMatchObject({ case: 'decimalType', value: { precision: 35, scale: 9 } });
      expect(ExactDecimalValue.decode(decimal.encode(), 35, 9).toString()).toBe(value);
    },
  );

  test('rejects unsupported bounds and inexact inputs instead of rounding', () => {
    for (const declaration of ['Decimal(0,0)', 'Decimal(36,9)', 'Decimal(9,10)', 'Decimal(35,-1)', 'Decimal']) {
      expect(() => decimalParameters(declaration)).toThrow(/precision 1\.\.35/);
    }
    for (const value of ['NaN', 'Infinity', '1e3', '1.1234567890', '100000000000000000000000000.000000000']) {
      expect(() => new ExactDecimalValue(value)).toThrow(/Decimal/);
    }
    expect(() => new ExactDecimalValue(0.1 as unknown as string)).toThrow(/decimal string/);
  });
});

describe.skipIf(!enabled)('public SQL extensions with physical YDB Decimal', () => {
  let orm: MikroORM<DecimalDriver>;

  beforeAll(async () => {
    orm = await initialize();
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

  test('injects both connections, retains standard compiler and discovers exact physical schema without drift', async () => {
    const platform = orm.driver.getPlatform();
    expect(platform).toBeInstanceOf(StrictDecimalPlatform);
    expect(orm.driver.getConnection()).toBeInstanceOf(DecimalSqlConnection);
    expect(orm.driver.getConnection().getYdbConnection()).toBeInstanceOf(DecimalNativeConnection);
    expect(platform.createNativeQueryBuilder().constructor).toBe(YdbNativeQueryBuilder);
    expect(platform.getTableMetadata(tableName)).toBe(orm.getMetadata(DecimalRecord));
    expect(platform.getColumnType(tableName, 'total_amount')).toBe('Decimal(35,9)');
    expect(platform.getColumnType(tableName, 'optional_adjustment')).toBe('Decimal(35,9)?');
    const description = await orm.driver.getConnection().getYdbConnection().describeTable(tableName);
    expect(description?.columns.find(column => column.name === 'total_amount')?.type?.type).toMatchObject({
      case: 'decimalType',
      value: { precision: 35, scale: 9 },
    });
    expect(await orm.schema.getUpdateSchemaSQL()).toBe('');
  });

  test('preserves exact Unit of Work values and Identity Map through persist, reload and adjacent updates', async () => {
    const entity = orm.em.create(DecimalRecord, { id: 'managed', amount: exact, adjustment: `-${exact}` });
    await orm.em.flush();
    orm.em.clear();
    const loaded = await orm.em.findOneOrFail(DecimalRecord, 'managed');
    expect(loaded.amount).toBe(exact);
    expect(loaded.adjustment).toBe(`-${exact}`);
    expect(await orm.em.findOneOrFail(DecimalRecord, 'managed')).toBe(loaded);
    const native = orm.driver.getConnection().getYdbConnection() as DecimalNativeConnection;
    const before = native.decimalDeclarations.length;
    await orm.em.flush();
    expect(native.decimalDeclarations).toHaveLength(before);
    loaded.amount = adjacent;
    loaded.adjustment = null;
    await orm.em.flush();
    orm.em.clear();
    expect(await orm.em.findOneOrFail(DecimalRecord, 'managed')).toMatchObject({ amount: adjacent, adjustment: null });
    expect(entity.amount).toBe(exact);
    expect(native.decodedDecimals).toBeGreaterThan(0);
    expect(native.decimalDeclarations).toContain('Decimal(35,9)');
    expect(native.decimalDeclarations).toContain('Optional<Decimal(35,9)>');
  });

  test('supports native inserts, batch inserts and batch updates using the same exact codec', async () => {
    await orm.driver.nativeInsert(DecimalRecord, { id: 'native', amount: exact, adjustment: null });
    await orm.driver.nativeInsertMany(DecimalRecord, [
      { id: 'batch-a', amount: adjacent, adjustment: '-0.000000001' },
      { id: 'batch-b', amount: `-${exact}`, adjustment: null },
    ]);
    expect(await orm.em.findOneOrFail(DecimalRecord, 'native')).toMatchObject({ amount: exact, adjustment: null });
    await orm.driver.nativeUpdateMany(
      DecimalRecord,
      [{ id: 'batch-a' }, { id: 'batch-b' }],
      [{ amount: exact }, { amount: adjacent }],
    );
    orm.em.clear();
    const rows = await orm.em.find(DecimalRecord, {}, { orderBy: { id: 'asc' } });
    expect(rows.map(row => [row.id, row.amount])).toEqual([
      ['batch-a', exact],
      ['batch-b', adjacent],
      ['native', exact],
    ]);
    await orm.em.nativeUpdate(DecimalRecord, { amount: adjacent }, { amount: `-${exact}` });
    orm.em.clear();
    expect((await orm.em.findOneOrFail(DecimalRecord, 'batch-b')).amount).toBe(`-${exact}`);
  });

  test('compares and orders Decimal numerically, including differences below Double precision', async () => {
    await orm.em.insertMany(DecimalRecord, [
      { id: 'huge', amount: exact },
      { id: 'adjacent', amount: adjacent },
      { id: 'ten', amount: '10.000000000' },
      { id: 'two', amount: '2.000000000' },
      { id: 'negative', amount: `-${exact}` },
    ]);
    const greater = await orm.em.find(DecimalRecord, { amount: { $gt: exact } });
    expect(greater.map(row => row.id)).toEqual(['adjacent']);
    const equal = await orm.em.find(DecimalRecord, { amount: exact });
    expect(equal.map(row => row.id)).toEqual(['huge']);
    const ordered = await orm.em.find(DecimalRecord, {}, { orderBy: { amount: 'asc' }, limit: 3, offset: 1 });
    expect(ordered.map(row => row.id)).toEqual(['two', 'ten', 'huge']);
  });

  test('rolls back exact writes with the inherited connection and transaction lifecycle', async () => {
    await orm.driver.nativeInsert(DecimalRecord, { id: 'rollback', amount: exact });
    await expect(
      orm.em.transactional(async em => {
        const entity = await em.findOneOrFail(DecimalRecord, 'rollback');
        entity.amount = adjacent;
        await em.flush();
        expect((await em.findOneOrFail(DecimalRecord, 'rollback', { refresh: true })).amount).toBe(adjacent);
        await em.insert(DecimalRecord, { id: 'rolled-back-insert', amount: `-${exact}` });
        throw new Error('rollback exact Decimal transaction');
      }),
    ).rejects.toThrow('rollback exact Decimal transaction');
    orm.em.clear();
    expect((await orm.em.findOneOrFail(DecimalRecord, 'rollback')).amount).toBe(exact);
    expect(await orm.em.findOne(DecimalRecord, 'rolled-back-insert')).toBeNull();
  });

  test('diffs and applies an additional Decimal column without replacing the schema helper', async () => {
    const extended = await initialize(true);
    try {
      const sql = await extended.schema.getUpdateSchemaSQL();
      expect(sql).toMatch(/add column `rebate_amount` Decimal\(22,9\)/i);
      await extended.schema.update();
      expect(await extended.schema.getUpdateSchemaSQL()).toBe('');
      const rebate = '1234567890123.123456789';
      await extended.em.insert(DecimalRecord, { id: 'added-column', amount: exact, rebate });
      expect(await extended.em.findOneOrFail(DecimalRecord, 'added-column')).toMatchObject({ amount: exact, rebate });
    } finally {
      await extended.close(true);
    }
  });
});
