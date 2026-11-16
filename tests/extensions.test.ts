import {
  type Configuration,
  EntitySchema,
  type EntityMetadata,
  type EntityProperty,
  MikroORM,
  type MetadataStorage,
  PrimaryKeyProp,
  ReferenceKind,
} from '@mikro-orm/core';
import type { SqlEntityManager } from '@mikro-orm/sql';
import type { Type as ProtocolType, Value as ProtocolValue } from '@ydbjs/api/value';
import { toJs, type Value } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import { Utf8, Utf8Type } from '@ydbjs/value/primitive';
import {
  createYdbValue,
  YdbConnection,
  YdbNativeQueryBuilder,
  YdbSchemaHelper,
  YdbSqlConnection,
  YdbSqlDriver,
  type YdbSqlDriverComponents,
  YdbSqlPlatform,
} from '../src/index.js';

/** A deliberately complete consumer validation override, independent of the built-in implementation. */
class StrictDecimalPlatform extends YdbSqlPlatform {
  readonly validated = new Set<string>();
  readonly parameterDeclarations: string[] = [];

  override createParameterValue(value: unknown, declaration: string) {
    this.parameterDeclarations.push(declaration);
    // Decimal is transported as exact text and converted by the existing metadata-driven CAST.
    if (/^Decimal\(22,\s*9\)\??$/.test(declaration)) {
      if (value == null) {
        if (!declaration.endsWith('?')) throw new Error('The extension rejects null for required Decimal columns.');
        return new Optional(null, new Utf8Type());
      }
      if (typeof value === 'string') {
        if (!/^-?\d{1,13}(?:\.\d{1,9})?$/.test(value)) throw new Error('Invalid extension Decimal(22,9) text.');
        return new Utf8(value);
      }
    }
    return super.createParameterValue(value, declaration);
  }

  override validateMetadata(meta: EntityMetadata): void {
    if (meta.schema || meta.virtual || meta.view || meta.inheritanceType === 'tpt' || !meta.primaryKeys.length) {
      throw new Error('The extension permits ordinary tables and single-table inheritance only.');
    }
    if (meta.checks.length || meta.triggers?.length || meta.policies.length) {
      throw new Error('The extension rejects checks, triggers, and policies.');
    }
    if (meta.indexes.some(index => index.where || index.expression || index.type)) {
      throw new Error('The extension rejects partial, expression, and specialized indexes.');
    }
    for (const prop of meta.props) {
      if (prop.kind !== ReferenceKind.SCALAR || prop.formula || prop.generated || prop.defaultRaw != null) {
        throw new Error('The extension permits scalar persisted values only.');
      }
      if (prop.autoincrement && !prop.primary) {
        throw new Error('The extension rejects non-primary sequences.');
      }
      if (prop.primary && prop.nullable) throw new Error('The extension rejects nullable primary keys.');
      this.validateColumnType(prop);
    }
    // There is intentionally no call to super.validateMetadata(): registration belongs to the driver lifecycle.
    this.validated.add(meta.className);
  }

  protected override validateColumnType(prop: EntityProperty): void {
    for (const columnType of prop.columnTypes ?? []) {
      if (/^Decimal\(22,\s*9\)$/.test(columnType)) continue;
      super.validateColumnType({ ...prop, columnTypes: [columnType] });
    }
  }
}

class ExtensionNativeConnection extends YdbConnection {
  readonly declaredValues: Value[] = [];
  readonly decodedTypes: ProtocolType[] = [];

  get attachedMetadata(): MetadataStorage {
    return this.metadata;
  }

  get attachedPlatform(): YdbSqlPlatform {
    return this.platform as YdbSqlPlatform;
  }

  declaration(value: Value): string {
    return this.getParameterTypeDeclaration(value);
  }

  decode(value: ProtocolValue, type: ProtocolType): unknown {
    return this.decodeResultValue(value, type);
  }

  protected override getParameterTypeDeclaration(value: Value): string {
    this.declaredValues.push(value);
    return super.getParameterTypeDeclaration(value);
  }

  protected override decodeResultValue(value: ProtocolValue, type: ProtocolType): unknown {
    this.decodedTypes.push(type);
    return super.decodeResultValue(value, type);
  }
}

class ExtensionConnection extends YdbSqlConnection {
  protected override createNativeConnection(): YdbConnection {
    return new ExtensionNativeConnection(this.config, this.options, this.type);
  }
}

class ExtensionDriver extends YdbSqlDriver {
  constructor(config: Configuration) {
    const components: YdbSqlDriverComponents = {
      platform: new StrictDecimalPlatform(),
      connection: ExtensionConnection,
    };
    super(config, components);
  }
}

class ExtendedRecord {
  id!: string;
  total?: string | null;
}

class CompositeRecord {
  tenant!: string;
  code!: number;
  label!: string;
  [PrimaryKeyProp]?: ['tenant', 'code'];
}

abstract class ExtensionDocument {
  id!: string;
  title!: string;
}

class AmountDocument extends ExtensionDocument {
  total!: string;
}

class ImageDocument extends ExtensionDocument {
  height!: number;
}

function extendedSchemas() {
  return [
    new EntitySchema<ExtendedRecord>({
      class: ExtendedRecord,
      tableName: 'extension_record',
      properties: {
        id: { type: 'string', primary: true, fieldName: 'record_key' },
        total: { type: 'string', columnType: 'Decimal(22,9)', nullable: true, fieldName: 'total_amount' },
      },
    }),
    new EntitySchema<CompositeRecord>({
      class: CompositeRecord,
      tableName: 'extension_composite',
      properties: {
        tenant: { type: 'string', primary: true, fieldName: 'tenant_key' },
        code: { type: 'integer', primary: true, autoincrement: false, fieldName: 'entry_code' },
        label: { type: 'string', fieldName: 'display_label' },
      },
    }),
    new EntitySchema<ExtensionDocument>({
      class: ExtensionDocument,
      abstract: true,
      tableName: 'extension_document',
      discriminatorColumn: 'kind',
      discriminatorMap: { amount: AmountDocument, image: ImageDocument },
      properties: { id: { type: 'string', primary: true }, title: { type: 'string' } },
    }),
    new EntitySchema<AmountDocument, ExtensionDocument>({
      class: AmountDocument,
      extends: ExtensionDocument,
      discriminatorValue: 'amount',
      properties: { total: { type: 'string', columnType: 'Decimal(22,9)', fieldName: 'document_total' } },
    }),
    new EntitySchema<ImageDocument, ExtensionDocument>({
      class: ImageDocument,
      extends: ExtensionDocument,
      discriminatorValue: 'image',
      properties: { height: { type: 'integer', fieldName: 'image_height' } },
    }),
  ];
}

async function initialize<D extends YdbSqlDriver>(driver: new (config: Configuration) => D, entities: EntitySchema[]) {
  return MikroORM.init<D, SqlEntityManager<D>>({
    driver,
    entities,
    clientUrl: 'grpc://localhost:2136',
    dbName: '/local',
  });
}

describe('supported SQL driver extension API', () => {
  test('exports the reusable schema, compiler, and binding interfaces from the package root', () => {
    expect(YdbNativeQueryBuilder).toBeTypeOf('function');
    expect(YdbSchemaHelper).toBeTypeOf('function');
    expect(toJs(createYdbValue('value', 'Utf8'))).toBe('value');
    const explicit = new Utf8('12.340000000');
    expect(createYdbValue(explicit, 'Decimal(22,9)')).toBe(explicit);
    expect(() => createYdbValue(null, 'Int32')).toThrow(/cannot receive null/);
    expect(() => createYdbValue(2 ** 31, 'Int32')).toThrow(/out of range/);
  });

  test('uses the built-in platform and connection when no components are supplied', async () => {
    const schema = new EntitySchema({
      name: 'DefaultExtensionRecord',
      properties: { id: { type: 'string', primary: true } },
    });
    const orm = await initialize(YdbSqlDriver, [schema]);
    try {
      expect(orm.driver.getPlatform().constructor).toBe(YdbSqlPlatform);
      expect(orm.driver.getConnection().constructor).toBe(YdbSqlConnection);
    } finally {
      await orm.close(true);
    }
  });

  test('injects custom components through a driver subclass without connecting', async () => {
    const connect = vi.spyOn(ExtensionConnection.prototype, 'connect');
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      expect(orm.driver.getPlatform()).toBeInstanceOf(StrictDecimalPlatform);
      expect(orm.driver.getConnection()).toBeInstanceOf(ExtensionConnection);
      const native = orm.driver.getConnection().getYdbConnection();
      expect(native).toBeInstanceOf(ExtensionNativeConnection);
      expect(orm.driver.getConnection().getYdbConnection()).toBe(native);
      expect(orm.driver.getPlatform().createNativeQueryBuilder()).toBeInstanceOf(YdbNativeQueryBuilder);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await orm.close(true);
      connect.mockRestore();
    }
  });

  test('keeps the default connection when only a platform is supplied', async () => {
    class PlatformOnlyDriver extends YdbSqlDriver {
      constructor(config: Configuration) {
        super(config, { platform: new StrictDecimalPlatform() });
      }
    }
    const orm = await initialize(PlatformOnlyDriver, extendedSchemas());
    try {
      expect(orm.driver.getPlatform()).toBeInstanceOf(StrictDecimalPlatform);
      expect(orm.driver.getConnection().constructor).toBe(YdbSqlConnection);
    } finally {
      await orm.close(true);
    }
  });

  test('keeps strict default validation when only a connection is supplied', async () => {
    class ConnectionOnlyDriver extends YdbSqlDriver {
      constructor(config: Configuration) {
        super(config, { connection: ExtensionConnection });
      }
    }
    const schema = new EntitySchema({
      name: 'ConnectionOnlyRecord',
      properties: { id: { type: 'string', primary: true } },
    });
    const orm = await initialize(ConnectionOnlyDriver, [schema]);
    try {
      expect(orm.driver.getPlatform().constructor).toBe(YdbSqlPlatform);
      expect(orm.driver.getConnection()).toBeInstanceOf(ExtensionConnection);
    } finally {
      await orm.close(true);
    }
    await expect(initialize(ConnectionOnlyDriver, [extendedSchemas()[0]])).rejects.toThrow(
      /does not support column type Decimal/,
    );
  });

  test('registers renamed fields and composite key metadata independently of a complete validation override', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      const platform = orm.driver.getPlatform();
      const custom = platform as StrictDecimalPlatform;
      expect(custom.validated.has('ExtendedRecord')).toBe(true);
      expect(custom.validated.has('CompositeRecord')).toBe(true);
      expect(platform.getTableMetadata('extension_record')).toBe(orm.getMetadata(ExtendedRecord));
      expect(platform.getColumnType('extension_record', 'record_key')).toBe('Utf8');
      expect(platform.getColumnType('extension_record', 'total_amount')).toBe('Decimal(22,9)?');
      expect(platform.getColumnType('extension_record', 'total')).toBeUndefined();
      expect(platform.getPrimaryKeyColumns('extension_composite')).toEqual(['tenant_key', 'entry_code']);
      expect(platform.getColumnType('extension_composite', 'entry_code')).toBe('Int32');
      expect(platform.getTableMetadata('unregistered_table')).toBeUndefined();
      expect(platform.getColumnType('unregistered_table', 'id')).toBeUndefined();
    } finally {
      await orm.close(true);
    }
  });

  test('supports native value codec hooks through the injected connection without replacing its lifecycle', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      const native = orm.driver.getConnection().getYdbConnection() as ExtensionNativeConnection;
      const value = new Utf8('codec value');
      expect(native.declaration(value)).toBe('Utf8');
      expect(native.declaredValues).toEqual([value]);
      expect(native.decode(value.encode(), value.type.encode())).toBe('codec value');
      expect(native.decodedTypes).toEqual([value.type.encode()]);
      const close = vi.spyOn(native, 'close');
      await orm.close(true);
      expect(close).toHaveBeenCalled();
      close.mockRestore();
    } finally {
      await orm.close(true);
    }
  });

  test('reattaches current metadata and platform to a newly created native transport after close', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      const connection = orm.driver.getConnection();
      const initial = connection.getYdbConnection() as ExtensionNativeConnection;
      expect(initial.attachedPlatform).toBe(orm.driver.getPlatform());
      expect(initial.attachedMetadata).toBe(orm.getMetadata());
      await connection.close(true);
      const replacement = connection.getYdbConnection() as ExtensionNativeConnection;
      expect(replacement).toBeInstanceOf(ExtensionNativeConnection);
      expect(replacement).not.toBe(initial);
      expect(replacement.attachedPlatform).toBe(orm.driver.getPlatform());
      expect(replacement.attachedMetadata).toBe(orm.getMetadata());
    } finally {
      await orm.close(true);
    }
  });

  test('registers one physical STI table with every subtype column', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      const platform = orm.driver.getPlatform();
      expect(platform.getTableMetadata('extension_document')).toBe(orm.getMetadata(ExtensionDocument));
      expect(platform.getPrimaryKeyColumns('extension_document')).toEqual(['id']);
      expect(platform.getColumnType('extension_document', 'document_total')).toBe('Decimal(22,9)?');
      expect(platform.getColumnType('extension_document', 'image_height')).toBe('Int32?');
      expect(platform.getTableMetadata('extension_document')?.properties.total.fieldNames).toEqual(['document_total']);
      expect(platform.getTableMetadata('extension_document')?.properties.height.fieldNames).toEqual(['image_height']);
    } finally {
      await orm.close(true);
    }
  });

  test('resolves newly discovered entities from the live metadata storage', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    class DiscoveredRecord {
      id!: string;
      total!: string;
    }
    try {
      const platform = orm.driver.getPlatform();
      expect(platform.getTableMetadata('extension_discovered')).toBeUndefined();
      orm.discoverEntity(
        new EntitySchema<DiscoveredRecord>({
          class: DiscoveredRecord,
          tableName: 'extension_discovered',
          properties: {
            id: { type: 'string', primary: true, fieldName: 'discovered_key' },
            total: { type: 'string', columnType: 'Decimal(22,9)', fieldName: 'discovered_total' },
          },
        }),
      );
      expect(platform.getTableMetadata('extension_discovered')).toBe(orm.getMetadata(DiscoveredRecord));
      expect(platform.getColumnType('extension_discovered', 'discovered_total')).toBe('Decimal(22,9)');
      expect(platform.getPrimaryKeyColumns('extension_discovered')).toEqual(['discovered_key']);
    } finally {
      await orm.close(true);
    }
  });

  test('reuses the standard native compiler and physical Decimal DDL after an explicit type opt-in', async () => {
    const orm = await initialize(ExtensionDriver, extendedSchemas());
    try {
      const textValue = new Utf8('12.340000000');
      const query = orm.em
        .createQueryBuilder(ExtendedRecord)
        .insert({ id: 'a', total: textValue as unknown as string });
      expect(query.getQuery()).toContain('CAST(? AS Optional<Decimal(22,9)>)');
      expect(query.getParams()).toContain(textValue);
      const nullQuery = orm.em.createQueryBuilder(ExtendedRecord).insert({ id: 'b', total: null });
      expect(nullQuery.getQuery()).toContain('CAST(? AS Optional<Decimal(22,9)>)');
      expect(toJs(nullQuery.getParams()[1] as Value)).toBeNull();
      expect((orm.driver.getPlatform() as StrictDecimalPlatform).parameterDeclarations).toContain('Decimal(22,9)?');
      const ddl = await orm.schema.getCreateSchemaSQL();
      expect(ddl).toContain('`total_amount` Decimal(22,9)');
      expect(ddl).toContain('primary key (`tenant_key`, `entry_code`)');
    } finally {
      await orm.close(true);
    }
  });

  test('keeps Decimal outside the default platform allowlist', async () => {
    await expect(initialize(YdbSqlDriver, [extendedSchemas()[0]])).rejects.toThrow(
      /does not support column type Decimal/,
    );
  });

  test('keeps checks outside the default platform allowlist', async () => {
    const schema = new EntitySchema({
      name: 'CheckExtensionRecord',
      checks: [{ name: 'positive_amount', expression: 'amount > 0' }],
      properties: { id: { type: 'string', primary: true }, amount: { type: 'integer' } },
    });
    await expect(initialize(YdbSqlDriver, [schema])).rejects.toThrow(/triggers or check constraints/);
  });

  test('keeps partial indexes outside the default schema allowlist', async () => {
    const schema = new EntitySchema<{ id: string; label: string }>({
      name: 'PartialExtensionRecord',
      properties: { id: { type: 'string', primary: true }, label: { type: 'string' } },
      indexes: [{ name: 'partial_label', properties: ['label'], where: 'label IS NOT NULL' }],
    });
    const orm = await initialize(YdbSqlDriver, [schema]);
    try {
      await expect(orm.schema.getCreateSchemaSQL()).rejects.toThrow(/partial/);
    } finally {
      await orm.close(true);
    }
  });

  test('keeps non-primary sequences outside the default platform allowlist', async () => {
    const schema = new EntitySchema({
      name: 'SequenceExtensionRecord',
      properties: {
        id: { type: 'string', primary: true },
        sequence: { type: 'integer', autoincrement: true },
      },
    });
    await expect(initialize(YdbSqlDriver, [schema])).rejects.toThrow(/non-primary generated sequence/);
  });
});
