import { create } from '@bufbuild/protobuf';
import { EntityMetadata, ReferenceKind, type EntityProperty } from '@mikro-orm/core';
import { ColumnMetaSchema, DescribeTableResultSchema, type DescribeTableResult } from '@ydbjs/api/table';
import { TypeSchema, Type_PrimitiveTypeId, type Type } from '@ydbjs/api/value';
import { YdbSchemaGenerator } from '../src/YdbSchemaGenerator.js';
import type { YdbDriver } from '../src/YdbDriver.js';

function property(name: string, nullable = false, primary = false): EntityProperty {
  return {
    name,
    fieldNames: [name],
    columnTypes: ['Utf8'],
    type: 'string',
    kind: ReferenceKind.SCALAR,
    nullable,
    primary,
  } as EntityProperty;
}

function metadata(tableName: string, props = [property('id', false, true), property('name', true)]): EntityMetadata {
  const meta = new EntityMetadata({ collection: tableName, className: tableName });
  meta.props = props;
  meta.primaryKeys = props.filter(prop => prop.primary).map(prop => prop.name);
  meta.properties = Object.fromEntries(props.map(prop => [prop.name, prop]));
  return meta;
}

function type(optional: boolean, primitive = Type_PrimitiveTypeId.UTF8): Type {
  const item = create(TypeSchema, { type: { case: 'typeId', value: primitive } });
  return optional ? create(TypeSchema, { type: { case: 'optionalType', value: { item } } }) : item;
}

function table(columns = [property('id', false, true), property('name', true)]): DescribeTableResult {
  return create(DescribeTableResultSchema, {
    primaryKey: ['id'],
    columns: columns.map(prop => create(ColumnMetaSchema, { name: prop.fieldNames[0], type: type(!!prop.nullable) })),
  });
}

function fixture(metas: EntityMetadata[], descriptions: (DescribeTableResult | undefined)[]) {
  const connection = {
    executeScheme: vi.fn(async (_sql: string) => {}),
    describeTable: vi.fn(async (name: string) => descriptions[metas.findIndex(meta => meta.tableName === name)]),
    ensureConnection: vi.fn(async () => {}),
    checkConnection: vi.fn(async () => ({ ok: true })),
  };
  const driver = {
    config: { get: vi.fn(), set: vi.fn() },
    getMetadata: () => ({}),
    getPlatform: () => ({
      validateMetadata: vi.fn(),
      columnProperties: (meta: EntityMetadata) => meta.props,
      getYdbType: (prop: EntityProperty) => prop.columnTypes[0],
      quoteIdentifier: (name: string) => `\`${name}\``,
    }),
    getConnection: () => connection,
  };
  class FixtureGenerator extends YdbSchemaGenerator {
    protected override getOrderedMetadata(): EntityMetadata[] {
      return [...metas];
    }
  }
  return { schema: new FixtureGenerator(driver as unknown as YdbDriver), connection };
}

describe('YDB schema planning', () => {
  test('generates native DDL with required and optional columns and ordered composite keys', async () => {
    const meta = metadata('account', [
      property('tenant', false, true),
      property('id', false, true),
      property('name', true),
    ]);
    const { schema } = fixture([meta], []);
    expect(await schema.getCreateSchemaSQL()).toBe(
      'CREATE TABLE `account` (\n  `tenant` Utf8 NOT NULL,\n  `id` Utf8 NOT NULL,\n  `name` Utf8,\n  PRIMARY KEY (`tenant`, `id`)\n);\n',
    );
  });

  test('does not report a difference for the introspected table', async () => {
    const { schema, connection } = fixture([metadata('account')], [table()]);
    expect(await schema.getUpdateSchemaMigrationSQL()).toEqual({ up: '', down: '' });
    expect(connection.executeScheme).not.toHaveBeenCalled();
  });

  test('plans creation and definition rollback for a missing table', async () => {
    const { schema } = fixture([metadata('account')], [undefined]);
    const migration = await schema.getUpdateSchemaMigrationSQL();
    expect(migration.up).toContain('CREATE TABLE `account`');
    expect(migration.down).toBe('DROP TABLE `account`;\n');
  });

  test('adds nullable columns with a reverse schema operation', async () => {
    const { schema } = fixture([metadata('account')], [table([property('id', false, true)])]);
    expect(await schema.getUpdateSchemaMigrationSQL()).toEqual({
      up: 'ALTER TABLE `account` ADD COLUMN `name` Utf8;\n',
      down: 'ALTER TABLE `account` DROP COLUMN `name`;\n',
    });
  });

  test('keeps extra columns in safe mode and requires explicit unsafe mode to drop', async () => {
    const meta = metadata('account', [property('id', false, true)]);
    const { schema } = fixture([meta], [table()]);
    expect(await schema.getUpdateSchemaSQL()).toBe('');
    expect(await schema.getUpdateSchemaMigrationSQL({ safe: false })).toEqual({
      up: 'ALTER TABLE `account` DROP COLUMN `name`;\n',
      down: 'ALTER TABLE `account` ADD COLUMN `name` Utf8;\n',
    });
  });

  test('rejects a non-nullable addition before any DDL is executed', async () => {
    const first = metadata('first');
    const second = metadata('second', [property('id', false, true), property('required')]);
    const { schema, connection } = fixture([first, second], [undefined, table([property('id', false, true)])]);
    await expect(schema.update()).rejects.toThrow('Cannot add non-nullable YDB column second.required');
    expect(connection.executeScheme).not.toHaveBeenCalled();
  });

  test('rejects primary key, type and nullability changes', async () => {
    const primary = table();
    primary.primaryKey = ['name', 'id'];
    await expect(fixture([metadata('account')], [primary]).schema.getUpdateSchemaSQL()).rejects.toThrow('primary key');
    const changedType = table();
    changedType.columns[1].type = type(true, Type_PrimitiveTypeId.INT32);
    await expect(fixture([metadata('account')], [changedType]).schema.update()).rejects.toThrow('from Int32 to Utf8');
    const changedNullability = table();
    changedNullability.columns[1].type = type(false);
    await expect(fixture([metadata('account')], [changedNullability]).schema.update()).rejects.toThrow('nullability');
  });

  test('uses explicit notNull returned by introspection', async () => {
    const current = table();
    current.columns[0].notNull = true;
    current.columns[1].notNull = false;
    expect(await fixture([metadata('account')], [current]).schema.getUpdateSchemaSQL()).toBe('');
  });

  test('rejects unsupported live types, defaults, and indexes', async () => {
    const unsupportedType = table();
    unsupportedType.columns[1].type = type(true, Type_PrimitiveTypeId.YSON);
    await expect(fixture([metadata('account')], [unsupportedType]).schema.update()).rejects.toThrow(
      'database type is not supported',
    );
    const defaultValue = table();
    defaultValue.columns[1].defaultValue = { case: 'fromLiteral', value: { $typeName: 'Ydb.TypedValue' } };
    await expect(fixture([metadata('account')], [defaultValue]).schema.update()).rejects.toThrow('database defaults');
    const indexed = table();
    indexed.indexes.push({ $typeName: 'Ydb.Table.TableIndexDescription' } as DescribeTableResult['indexes'][number]);
    await expect(fixture([metadata('account')], [indexed]).schema.update()).rejects.toThrow('index management');
  });

  test('rejects dropping non-nullable extra columns', async () => {
    const current = table([property('id', false, true), property('legacy')]);
    await expect(
      fixture([metadata('account', [property('id', false, true)])], [current]).schema.update({ safe: false }),
    ).rejects.toThrow('Cannot automatically drop non-nullable');
  });

  test('does not discover or drop unrelated tables', async () => {
    const { schema, connection } = fixture([metadata('account')], [table()]);
    await expect(schema.update({ dropTables: true })).rejects.toThrow('do not discover or drop unmapped tables');
    expect(connection.describeTable).not.toHaveBeenCalled();
    expect(connection.executeScheme).not.toHaveBeenCalled();
  });

  test('drops only existing mapped tables', async () => {
    const { schema, connection } = fixture([metadata('account'), metadata('absent')], [table(), undefined]);
    await schema.drop();
    expect(connection.executeScheme.mock.calls).toEqual([['DROP TABLE `account`;']]);
  });

  test('validates the whole script before executing and rejects transaction wrapping', async () => {
    const { schema, connection } = fixture([], []);
    await expect(schema.execute('CREATE TABLE `account` (`id` Utf8, PRIMARY KEY (`id`)); SELECT 1;')).rejects.toThrow(
      'accepts CREATE TABLE',
    );
    expect(connection.executeScheme).not.toHaveBeenCalled();
    await expect(schema.execute('DROP TABLE `account`;', { wrap: true })).rejects.toThrow('cannot be wrapped');
  });

  test('checks an existing endpoint and rejects database provisioning', async () => {
    const { schema, connection } = fixture([], []);
    expect(await schema.ensureDatabase()).toBe(false);
    expect(connection.checkConnection).toHaveBeenCalledOnce();
    await expect(schema.createDatabase()).rejects.toThrow('database provisioning');
    await expect(schema.dropDatabase()).rejects.toThrow('database provisioning');
    await expect(schema.refresh({ dropDb: true })).rejects.toThrow('database provisioning');
  });
});
