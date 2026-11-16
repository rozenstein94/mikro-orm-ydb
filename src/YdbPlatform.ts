import {
  BigIntType,
  BlobType,
  BooleanType,
  DateTimeType,
  DoubleType,
  IntegerType,
  JsonType,
  Platform,
  ReferenceKind,
  StringType,
  Uint8ArrayType,
  UuidType,
  Type,
  type Configuration,
  type EntityManager,
  type EntityMetadata,
  type EntityProperty,
  type IDatabaseDriver,
  type MikroORM,
} from '@mikro-orm/core';
import { YdbExceptionConverter } from './YdbExceptionConverter.js';
import { YdbSchemaGenerator } from './YdbSchemaGenerator.js';
import type { YdbDriver } from './YdbDriver.js';

const ydbTypes: Record<string, string> = {
  string: 'Utf8',
  text: 'Utf8',
  varchar: 'Utf8',
  char: 'Utf8',
  character: 'Utf8',
  utf8: 'Utf8',
  uuid: 'Utf8',
  number: 'Int32',
  int: 'Int32',
  integer: 'Int32',
  smallint: 'Int32',
  tinyint: 'Int32',
  int32: 'Int32',
  bigint: 'Int64',
  int64: 'Int64',
  double: 'Double',
  float: 'Double',
  real: 'Double',
  boolean: 'Bool',
  bool: 'Bool',
  datetime: 'Timestamp',
  timestamp: 'Timestamp',
  date: 'Timestamp',
  buffer: 'String',
  blob: 'String',
  uint8array: 'String',
  json: 'JsonDocument',
  object: 'JsonDocument',
  jsondocument: 'JsonDocument',
};

/** Native YQL platform. SQL QueryBuilder and SQL migrations are deliberately separate APIs. */
export class YdbPlatform extends Platform {
  protected override readonly exceptionConverter = new YdbExceptionConverter();

  override setConfig(config: Configuration): void {
    config.set('autoJoinOneToOneOwner', false);
    config.set('loadStrategy', 'select-in');
    config.get('discovery').inferDefaultValues = false;
    super.setConfig(config);
  }

  override usesBatchUpdates(): boolean {
    return false;
  }
  override usesDefaultKeyword(): boolean {
    return false;
  }
  override supportsNullsOrdering(): boolean {
    return false;
  }
  override sortsNullsLowest(): boolean {
    return true;
  }
  override convertsJsonAutomatically(): boolean {
    return true;
  }
  override getIntegerTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getSmallIntTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getTinyIntTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getBigIntTypeDeclarationSQL(): string {
    return 'Int64';
  }
  override getDoubleDeclarationSQL(): string {
    return 'Double';
  }
  override getFloatDeclarationSQL(): string {
    return 'Double';
  }
  override getBooleanTypeDeclarationSQL(): string {
    return 'Bool';
  }
  override getDateTimeTypeDeclarationSQL(): string {
    return 'Timestamp';
  }
  override getDateTypeDeclarationSQL(): string {
    return 'Timestamp';
  }
  override getVarcharTypeDeclarationSQL(): string {
    return 'Utf8';
  }
  override getTextTypeDeclarationSQL(): string {
    return 'Utf8';
  }
  override getUuidTypeDeclarationSQL(): string {
    return 'Utf8';
  }
  override getBlobDeclarationSQL(): string {
    return 'String';
  }
  override getJsonDeclarationSQL(): string {
    return 'JsonDocument';
  }

  override getDefaultMappedType(type: string): Type<unknown> {
    switch (type.toLowerCase()) {
      case 'utf8':
        return Type.getType(StringType);
      case 'int32':
        return Type.getType(IntegerType);
      case 'int64':
        return Type.getType(BigIntType);
      case 'bool':
        return Type.getType(BooleanType);
      case 'timestamp':
        return Type.getType(DateTimeType);
      case 'double':
        return Type.getType(DoubleType);
      case 'jsondocument':
        return Type.getType(JsonType);
      // YQL String is binary, whereas MikroORM's lowercase string is text.
      default:
        return type === 'String' ? Type.getType(BlobType) : super.getDefaultMappedType(type);
    }
  }

  override quoteIdentifier(id: string | { toString(): string }): string {
    const value = id.toString();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw new Error(`YDB driver requires a simple table or column identifier: ${value}`);
    }
    return `\`${value}\``;
  }

  /** All stored columns, excluding inverse relations and computed application properties. */
  columnProperties(meta: EntityMetadata): EntityProperty[] {
    return meta.props.filter(
      p =>
        p.persist !== false &&
        (p.kind === ReferenceKind.SCALAR ||
          p.kind === ReferenceKind.MANY_TO_ONE ||
          (p.kind === ReferenceKind.ONE_TO_ONE && p.owner)),
    );
  }

  /** Bare primitive name; nullability is carried by the column and bound parameter type. */
  getYdbType(prop: EntityProperty): string {
    if (prop.targetMeta) {
      if (prop.targetMeta.primaryKeys.length !== 1) {
        throw new Error(`YDB driver does not support relations to composite keys: ${prop.name}`);
      }
      return this.getYdbType(prop.targetMeta.getPrimaryProps()[0]);
    }
    const type = prop.columnTypes?.[0] ?? prop.type;
    // String is the YQL binary type, string is MikroORM's text type.
    const mapped = type === 'String' ? 'String' : ydbTypes[type.toLowerCase()];
    if (!mapped) {
      throw new Error(`YDB driver does not support type ${type} on ${prop.name}`);
    }
    return mapped;
  }

  override validateMetadata(meta: EntityMetadata): void {
    super.validateMetadata(meta);
    const unsupported = (feature: string): never => {
      throw new Error(`YDB driver does not support ${feature} on ${meta.className}`);
    };
    this.quoteIdentifier(meta.collection);
    if (meta.schema || this.config.get('schema')) unsupported('SQL schemas');
    if (meta.virtual || meta.view || meta.discriminatorColumn || meta.inheritanceType === 'tpt')
      unsupported('entity inheritance or views');
    if (meta.indexes.length || meta.uniques.length || meta.checks.length)
      unsupported('secondary indexes, unique or check constraints');
    if (meta.triggers?.length) unsupported('triggers');
    if (meta.versionProperty) unsupported('version properties (use explicit serializable transactions)');
    if (meta.primaryKeys.length === 0) unsupported('tables without primary keys');
    for (const prop of meta.props) {
      if (prop.kind === ReferenceKind.MANY_TO_MANY || prop.kind === ReferenceKind.EMBEDDED)
        unsupported(`${prop.kind} properties`);
      if (prop.polymorphic || prop.through || prop.formula || prop.generated || prop.defaultRaw != null)
        unsupported(`generated/SQL expression property ${prop.name}`);
      if (prop.autoincrement)
        unsupported(`autoincrement property ${prop.name}; supply the key and set autoincrement: false`);
      if (prop.index || prop.unique) unsupported(`index/unique property ${prop.name}`);
      if (prop.kind === ReferenceKind.ONE_TO_ONE)
        unsupported('one-to-one uniqueness (use many-to-one plus application validation)');
      if (prop.kind === ReferenceKind.ONE_TO_MANY && prop.targetMeta?.compositePK)
        unsupported('collections of composite-key entities');
      if (prop.targetMeta && prop.kind === ReferenceKind.MANY_TO_ONE && prop.targetMeta.compositePK)
        unsupported('relations to composite keys');
      if (
        prop.targetMeta &&
        prop.kind === ReferenceKind.MANY_TO_ONE &&
        prop.referencedColumnNames?.join(',') !== prop.targetMeta.getPrimaryProps()[0].fieldNames.join(',')
      ) {
        unsupported(`relation ${prop.name} referencing a non-primary column`);
      }
      if (prop.primary && (prop.nullable || prop.targetMeta)) unsupported('nullable or relation primary keys');
    }
    for (const prop of this.columnProperties(meta)) {
      if (
        prop.customType &&
        ![
          BigIntType,
          BlobType,
          BooleanType,
          DateTimeType,
          DoubleType,
          IntegerType,
          JsonType,
          StringType,
          Uint8ArrayType,
          UuidType,
        ].some(type => prop.customType!.constructor === type)
      ) {
        unsupported(`custom mapped type ${prop.name}`);
      }
      if (prop.fieldNames.length !== 1) unsupported(`multi-column property ${prop.name}`);
      this.quoteIdentifier(prop.fieldNames[0]);
      this.getYdbType(prop);
    }
  }

  override lookupExtensions(orm: MikroORM): void {
    YdbSchemaGenerator.register(orm);
  }

  override getSchemaGenerator(driver: IDatabaseDriver, em?: EntityManager): YdbSchemaGenerator {
    return new YdbSchemaGenerator((em as EntityManager<YdbDriver> | undefined) ?? (driver as YdbDriver));
  }
}
