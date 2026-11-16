import { create } from '@bufbuild/protobuf';
import { Configuration, IntegerType, MetadataStorage, StringType, Type } from '@mikro-orm/core';
import {
  AbstractSqlPlatform,
  DatabaseSchema,
  DatabaseTable,
  SchemaComparator,
  SqlSchemaGenerator,
  type AbstractSqlConnection,
  type AbstractSqlDriver,
  type Column,
  type IndexDef,
  type TableDifference,
} from '@mikro-orm/sql';
import {
  ColumnMetaSchema,
  DescribeTableResultSchema,
  TableIndexDescriptionSchema,
  type DescribeTableResult,
} from '@ydbjs/api/table';
import { TypeSchema, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { YdbDriver } from '../src/YdbDriver.js';
import { YdbSchemaHelper } from '../src/YdbSchemaHelper.js';
import { YdbSqlPlatform } from '../src/YdbSqlPlatform.js';

class FixturePlatform extends AbstractSqlPlatform {
  protected override readonly schemaHelper = new YdbSchemaHelper(this);
  override quoteIdentifier(value: string): string {
    return `\`${value}\``;
  }
  override supportsSchemas(): boolean {
    return false;
  }
  override supportsComments(): boolean {
    return false;
  }
  override getVarcharTypeDeclarationSQL(): string {
    return 'Utf8';
  }
  override getIntegerTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getDefaultMappedType(type: string): Type<unknown> {
    if (type.toLowerCase() === 'utf8') return Type.getType(StringType);
    if (type.toLowerCase() === 'int32') return Type.getType(IntegerType);
    return super.getDefaultMappedType(type);
  }
}

function fixture(descriptions: Record<string, DescribeTableResult | undefined> = {}) {
  const config = new Configuration(
    {
      driver: YdbDriver,
      clientUrl: 'grpc://localhost:2136',
      dbName: '/local',
      entities: [],
      schemaGenerator: { createForeignKeyConstraints: false },
    },
    false,
  );
  const platform = new FixturePlatform();
  platform.setConfig(config);
  const helper = platform.getSchemaHelper() as YdbSchemaHelper;
  const native = {
    listTables: vi.fn(async () => Object.keys(descriptions)),
    describeTable: vi.fn(async (name: string) => descriptions[name]),
  };
  const connection = {
    getYdbConnection: () => native,
    ensureConnection: vi.fn(async () => {}),
    checkConnection: vi.fn(async () => ({ ok: true })),
    execute: vi.fn(async () => []),
  };
  return { platform, helper, config, native, connection: connection as unknown as AbstractSqlConnection };
}

function makeSchema(platform: AbstractSqlPlatform): DatabaseSchema {
  return new DatabaseSchema(platform, platform.getDefaultSchemaName()!);
}

function column(name: string, nullable = false, primary = false, type = 'Utf8'): Column {
  return { name, type, nullable, primary, mappedType: Type.getType(StringType) };
}

function index(name: string, columns: string[], unique = false, include?: string[]): IndexDef {
  return { keyName: name, columnNames: columns, unique, primary: false, constraint: unique, include };
}

function table(
  platform: AbstractSqlPlatform,
  name = 'author',
  columns = [column('id', false, true), column('name', true)],
  indexes: IndexDef[] = [],
): DatabaseTable {
  const result = new DatabaseTable(platform, name);
  const keys = columns.filter(column => column.primary).map(column => column.name);
  result.init(
    columns,
    [
      {
        keyName: 'primary',
        columnNames: keys,
        unique: true,
        primary: true,
        constraint: true,
        composite: keys.length > 1,
      },
      ...indexes,
    ],
    [],
    keys,
    {},
  );
  return result;
}

function description(): DescribeTableResult {
  return create(DescribeTableResultSchema, {
    primaryKey: ['id'],
    columns: [
      create(ColumnMetaSchema, {
        name: 'id',
        type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } },
        notNull: true,
      }),
      create(ColumnMetaSchema, {
        name: 'name',
        type: {
          type: {
            case: 'optionalType',
            value: { item: { type: { case: 'typeId', value: Type_PrimitiveTypeId.UTF8 } } },
          },
        },
      }),
    ],
  });
}

function difference(platform: AbstractSqlPlatform, before: DatabaseTable, after: DatabaseTable): TableDifference {
  const diff = new SchemaComparator(platform).diffTable(before, after);
  if (!diff) throw new Error('Fixture expected a schema difference');
  return diff;
}

function generator(target: DatabaseSchema, setup: ReturnType<typeof fixture>): SqlSchemaGenerator {
  const driver = {
    config: setup.config,
    getMetadata: () => new MetadataStorage(),
    getPlatform: () => setup.platform,
    getConnection: () => setup.connection,
    execute: vi.fn(async () => []),
  };
  class FixtureGenerator extends SqlSchemaGenerator {
    override getTargetSchema(): DatabaseSchema {
      return target;
    }
  }
  return new FixtureGenerator(driver as unknown as AbstractSqlDriver);
}

describe('YDB SQL schema helper', () => {
  test('creates a native table with an ordered composite primary key for pivot collections', () => {
    const { platform, helper } = fixture();
    const pivot = table(platform, 'author_book', [column('author_id', false, true), column('book_id', false, true)]);
    expect(helper.createTable(pivot)).toEqual([
      'create table `author_book` (`author_id` Utf8 not null, `book_id` Utf8 not null, primary key (`author_id`, `book_id`))',
    ]);
  });

  test('creates secondary, unique, and covering indexes in native table definitions', () => {
    const { platform, helper } = fixture();
    const author = table(
      platform,
      'author',
      [column('id', false, true), column('name', true)],
      [index('name_idx', ['name'], false, ['id']), index('name_unique', ['name'], true)],
    );
    expect(helper.createTable(author)[0]).toContain('index `name_idx` global sync on (`name`) cover (`id`)');
    expect(helper.createTable(author)[0]).toContain('index `name_unique` global unique sync on (`name`)');
    expect(helper.getCreateIndexSQL('author', index('name_unique', ['name'], true))).toBe(
      'alter table `author` add index `name_unique` global unique sync on (`name`)',
    );
  });

  test('rejects partial, expression and specialized indexes before producing DDL', () => {
    const { helper } = fixture();
    for (const extra of [
      { where: '`name` IS NOT NULL' },
      { expression: 'CREATE INDEX x' },
      { type: 'fulltext' },
      { columns: [{ name: 'name', sort: 'desc' as const }] },
    ]) {
      expect(() => helper.getCreateIndexSQL('author', { ...index('name_idx', ['name']), ...extra })).toThrow(
        'synchronous secondary keys',
      );
    }
  });

  test('loads tables and columns through ListDirectory and DescribeTable instead of SQL catalogs', async () => {
    const { platform, helper, connection, native } = fixture({ author: description() });
    const schema = makeSchema(platform);
    const tables = await helper.getAllTables(connection);
    await helper.loadInformationSchema(schema, connection, tables);
    expect(native.listTables).toHaveBeenCalledOnce();
    expect(native.describeTable).toHaveBeenCalledWith('author');
    expect(schema.getTable('author')?.getColumn('id')).toMatchObject({ type: 'Utf8', primary: true, nullable: false });
    expect(schema.getTable('author')?.getColumn('name')).toMatchObject({ type: 'Utf8', nullable: true });
    expect(schema.getTable('author')?.getPrimaryKey()?.columnNames).toEqual(['id']);
  });

  test('round-trips synchronous and unique covering index definitions without schema churn', async () => {
    const current = description();
    current.indexes = [
      create(TableIndexDescriptionSchema, {
        name: 'name_idx',
        indexColumns: ['name'],
        type: { case: 'globalIndex', value: {} },
        dataColumns: ['id'],
      }),
      create(TableIndexDescriptionSchema, {
        name: 'name_unique',
        indexColumns: ['name'],
        type: { case: 'globalUniqueIndex', value: {} },
      }),
    ];
    const { platform, helper, connection } = fixture({ author: current });
    const schema = makeSchema(platform);
    await helper.loadInformationSchema(schema, connection, [{ table_name: 'author' }]);
    const desired = table(
      platform,
      'author',
      [column('id', false, true), column('name', true)],
      [index('name_idx', ['name'], false, ['id']), index('name_unique', ['name'], true)],
    );
    expect(new SchemaComparator(platform).diffTable(schema.getTable('author')!, desired)).toBe(false);
  });

  test('rejects asynchronous live indexes that cannot be represented by the schema contract', async () => {
    const current = description();
    current.indexes = [
      create(TableIndexDescriptionSchema, {
        name: 'name_async',
        indexColumns: ['name'],
        type: { case: 'globalAsyncIndex', value: {} },
      }),
    ];
    const { platform, helper, connection } = fixture({ author: current });
    await expect(
      helper.loadInformationSchema(makeSchema(platform), connection, [{ table_name: 'author' }]),
    ).rejects.toThrow('only synchronous secondary indexes');
  });

  test('detects a table disappearing during schema introspection', async () => {
    const { platform, helper, connection } = fixture({ author: undefined });
    await expect(
      helper.loadInformationSchema(makeSchema(platform), connection, [{ table_name: 'author' }]),
    ).rejects.toThrow('disappeared during schema introspection');
    expect(await helper.tableExists(connection, 'author')).toBe(false);
  });

  test('adds nullable columns and honors the SQL generator safe option when dropping them', () => {
    const { platform, helper } = fixture();
    const base = table(platform, 'author', [column('id', false, true)]);
    const expanded = table(platform);
    expect(helper.alterTable(difference(platform, base, expanded))).toEqual([
      'alter table `author` add column `name` Utf8',
    ]);
    const removal = difference(platform, expanded, base);
    expect(helper.alterTable(removal, true)).toEqual([]);
    expect(helper.alterTable(removal, false)).toEqual(['alter table `author` drop column `name`']);
  });

  test('rejects required additions and primary key, type, and nullability changes', () => {
    const { platform, helper } = fixture();
    const base = table(platform);
    const required = table(platform, 'author', [...base.getColumns(), column('required')]);
    expect(() => helper.alterTable(difference(platform, base, required))).toThrow('Cannot automatically add required');
    const primary = table(platform, 'author', [column('id', false, true), column('name', true, true)]);
    expect(() => helper.alterTable(difference(platform, base, primary))).toThrow('primary key');
    const changedType = table(platform, 'author', [column('id', false, true), column('name', true, false, 'Int32')]);
    expect(() => helper.alterTable(difference(platform, base, changedType))).toThrow(
      'Cannot automatically change YDB columns',
    );
    const changedNull = table(platform, 'author', [column('id', false, true), column('name', false)]);
    expect(() => helper.alterTable(difference(platform, base, changedNull))).toThrow('nullable');
  });

  test('generates reversible scripts using the actual SqlSchemaGenerator and SchemaComparator', async () => {
    const setup = fixture();
    const before = makeSchema(setup.platform);
    before.setTables([table(setup.platform, 'author', [column('id', false, true)])]);
    const target = makeSchema(setup.platform);
    target.setTables([table(setup.platform)]);
    const scripts = await generator(target, setup).getUpdateSchemaMigrationSQL({ fromSchema: before });
    expect(scripts.up).toContain('alter table `author` add column `name` Utf8;');
    expect(scripts.down).toContain('alter table `author` drop column `name`;');
  });

  test('generates no migration when native introspection matches desired metadata', async () => {
    const setup = fixture({ author: description() });
    const before = makeSchema(setup.platform);
    await setup.helper.loadInformationSchema(before, setup.connection, [{ table_name: 'author' }]);
    const target = makeSchema(setup.platform);
    target.setTables([table(setup.platform)]);
    expect(await generator(target, setup).getUpdateSchemaMigrationSQL({ fromSchema: before })).toEqual({
      up: '',
      down: '',
    });
  });

  test('honors dropTables and safe options in the standard SQL schema generator', async () => {
    const setup = fixture();
    const before = makeSchema(setup.platform);
    before.setTables([table(setup.platform)]);
    const target = makeSchema(setup.platform);
    const schemaGenerator = generator(target, setup);
    expect(await schemaGenerator.getUpdateSchemaSQL({ fromSchema: before, dropTables: false })).toBe('');
    expect(await schemaGenerator.getUpdateSchemaSQL({ fromSchema: before, safe: true })).toBe('');
    expect(await schemaGenerator.getUpdateSchemaSQL({ fromSchema: before, dropTables: true, safe: false })).toContain(
      'drop table if exists `author`;',
    );
  });

  test('does not execute a valid first table plan when a later table change is irreducible', async () => {
    const setup = fixture();
    const before = makeSchema(setup.platform);
    before.setTables([table(setup.platform)]);
    const target = makeSchema(setup.platform);
    target.setTables([
      table(setup.platform, 'new_table'),
      table(setup.platform, 'author', [column('id', false, true), column('name', false)]),
    ]);
    const schemaGenerator = generator(target, setup);
    const execute = vi.spyOn(schemaGenerator, 'execute');
    await expect(schemaGenerator.update({ fromSchema: before })).rejects.toThrow(
      'Cannot automatically change YDB columns',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  test('creates serial primary columns and recognizes DescribeTable sequence defaults', async () => {
    const { platform, helper } = fixture();
    const serial = table(platform, 'serial_key', [{ ...column('id', false, true, 'Int32'), autoincrement: true }]);
    expect(helper.createTable(serial)[0]).toContain('`id` Serial not null');
    const serial8 = table(platform, 'serial_key', [{ ...column('id', false, true, 'Int64'), autoincrement: true }]);
    expect(helper.createTable(serial8)[0]).toContain('`id` Serial8 not null');
    const current = description();
    current.columns[0].type = create(TypeSchema, { type: { case: 'typeId', value: Type_PrimitiveTypeId.INT32 } });
    current.columns[0].defaultValue = { case: 'fromSequence', value: { $typeName: 'Ydb.Table.SequenceDescription' } };
    const setup = fixture({ serial_key: current });
    const schema = makeSchema(setup.platform);
    await setup.helper.loadInformationSchema(schema, setup.connection, [{ table_name: 'serial_key' }]);
    expect(schema.getTable('serial_key')?.getColumn('id')).toMatchObject({
      type: 'Int32',
      autoincrement: true,
      primary: true,
    });
  });

  test('round-trips generated primary keys with the concrete SQL platform', async () => {
    const setup = fixture();
    const platform = new YdbSqlPlatform();
    platform.setConfig(setup.config);
    const helper = platform.getSchemaHelper() as YdbSchemaHelper;
    const current = description();
    current.columns = [
      create(ColumnMetaSchema, {
        name: 'id',
        type: { type: { case: 'typeId', value: Type_PrimitiveTypeId.INT32 } },
        notNull: true,
        defaultValue: { case: 'fromSequence', value: {} },
      }),
    ];
    const native = fixture({ serial_key: current });
    const before = makeSchema(platform);
    await helper.loadInformationSchema(before, native.connection, [{ table_name: 'serial_key' }]);
    const target = table(platform, 'serial_key', [{ ...column('id', false, true, 'Serial'), autoincrement: true }]);
    expect(new SchemaComparator(platform).diffTable(before.getTable('serial_key')!, target)).toBe(false);
  });

  test('permits literal defaults and rejects SQL default expressions', () => {
    const { platform, helper } = fixture();
    const literal = table(platform, 'author', [
      column('id', false, true),
      { ...column('name', true), default: "'unknown'u" },
    ]);
    expect(helper.createTable(literal)[0]).toContain("`name` Utf8 default 'unknown'u");
    const expression = table(platform, 'author', [{ ...column('id', false, true), default: 'current_timestamp' }]);
    expect(() => helper.createTable(expression)).toThrow('must be a literal');
  });

  test('can rename and drop ordinary indexes but cannot mutate primary keys', () => {
    const { helper } = fixture();
    const ordinary = index('name_idx', ['name']);
    expect(helper.getRenameIndexSQL('author', ordinary, 'old_name')).toEqual([
      'alter table `author` rename index `old_name` to `name_idx`',
    ]);
    expect(helper.dropIndex('author', ordinary)).toBe('alter table `author` drop index `name_idx`');
    expect(() => helper.dropIndex('author', { ...ordinary, primary: true })).toThrow('primary key');
  });

  test('rejects unsupported schema, provisioning, and transaction contexts', async () => {
    const { helper, connection } = fixture();
    await expect(helper.getAllTables(connection, ['public'])).rejects.toThrow('SQL schemas');
    await expect(helper.getAllTables(connection, undefined, {})).rejects.toThrow(
      'cannot run inside a data transaction',
    );
    expect(() => helper.getCreateDatabaseSQL('/other')).toThrow('control plane');
    expect(() => helper.getDropDatabaseSQL('/other')).toThrow('control plane');
    expect(await helper.databaseExists(connection, '/local')).toBe(true);
  });
});
