import {
  type Configuration,
  type EntityMetadata,
  type EntityProperty,
  ReferenceKind,
  RawQueryFragment,
} from '@mikro-orm/core';
import { AbstractSqlPlatform } from '@mikro-orm/sql';
import { YdbExceptionConverter } from './YdbExceptionConverter.js';
import { YdbPlatform } from './YdbPlatform.js';
import { YdbNativeQueryBuilder } from './YdbNativeQueryBuilder.js';
import { YdbSchemaHelper } from './YdbSchemaHelper.js';

/** SQL ORM contracts with native YQL syntax and YDB schema semantics. */
export class YdbSqlPlatform extends AbstractSqlPlatform {
  protected override readonly exceptionConverter = new YdbExceptionConverter();
  protected override readonly schemaHelper = new YdbSchemaHelper(this);
  readonly #types = new YdbPlatform();
  readonly #tables = new Map<string, EntityMetadata>();

  override setConfig(config: Configuration): void {
    // YDB has no foreign key constraints; the ORM still owns relation metadata and pivot tables.
    config.get('schemaGenerator').createForeignKeyConstraints = false;
    config.get('discovery').inferDefaultValues = false;
    super.setConfig(config);
  }
  override createNativeQueryBuilder(): YdbNativeQueryBuilder {
    return new YdbNativeQueryBuilder(this);
  }
  override usesReturningStatement(): boolean {
    return true;
  }
  override usesBatchUpdates(): boolean {
    return false;
  }
  override usesDefaultKeyword(): boolean {
    return false;
  }
  override indexForeignKeys(): boolean {
    return false;
  }
  override supportsComments(): boolean {
    return false;
  }
  override supportsNullsOrdering(): boolean {
    return false;
  }
  override sortsNullsLowest(): boolean {
    return true;
  }
  override supportsCustomPrimaryKeyNames(): boolean {
    return false;
  }
  override convertsJsonAutomatically(): boolean {
    return true;
  }
  override processDateProperty(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string);
  }
  override normalizeColumnType(type: string): string {
    return (/^serial$/i.test(type) ? 'Int32' : /^serial8$/i.test(type) ? 'Int64' : type).toLowerCase();
  }
  override getDefaultMappedType(type: string) {
    return this.#types.getDefaultMappedType(
      /^serial$/i.test(type) ? 'Int32' : /^serial8$/i.test(type) ? 'Int64' : type,
    );
  }
  override getIntegerTypeDeclarationSQL(column?: { autoincrement?: boolean }): string {
    return column?.autoincrement ? 'Serial' : 'Int32';
  }
  override getSmallIntTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getTinyIntTypeDeclarationSQL(): string {
    return 'Int32';
  }
  override getBigIntTypeDeclarationSQL(column?: { autoincrement?: boolean }): string {
    return column?.autoincrement ? 'Serial8' : 'Int64';
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
  override getEnumTypeDeclarationSQL(column: { items?: unknown[]; fieldNames: string[] }): string {
    return column.items?.every(item => typeof item === 'string') ? 'Utf8' : 'Int32';
  }
  override getCurrentTimestampSQL(): string {
    return 'CurrentUtcTimestamp()';
  }
  override quoteIdentifier(id: string | { toString(): string }): string {
    const fragment = RawQueryFragment.getKnownFragment(id);
    if (fragment) return this.formatQuery(fragment.sql, fragment.params);
    return id
      .toString()
      .split('.')
      .map(part => (part === '*' ? '*' : `\`${part.replaceAll('`', '``')}\``))
      .join('.');
  }
  override escape(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'bigint') return `${value}l`;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('YDB cannot escape non-finite numbers.');
      return String(value);
    }
    if (value instanceof Date) return `Timestamp('${value.toISOString()}')`;
    if (typeof value === 'string') return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'u`;
    throw new Error('Use bound parameters for YDB binary, JSON or structured values.');
  }
  override quoteDefaultValue(value: string): string {
    return this.escape(value);
  }
  getColumnType(table: string, column: string): string | undefined {
    const meta = this.#tables.get(table);
    const prop = meta?.props.find(p => p.fieldNames?.includes(column));
    const type = prop?.columnTypes?.[prop.fieldNames.indexOf(column)];
    const canonical = type && (/^serial$/i.test(type) ? 'Int32' : /^serial8$/i.test(type) ? 'Int64' : type);
    return canonical && prop?.nullable ? `${canonical}?` : canonical;
  }
  getPrimaryKeyColumns(table: string): string[] {
    return (
      this.#tables
        .get(table)
        ?.getPrimaryProps()
        .flatMap(p => p.fieldNames) ?? []
    );
  }
  override validateMetadata(meta: EntityMetadata): void {
    super.validateMetadata(meta);
    const unsupported = (feature: string): never => {
      throw new Error(`YDB SQL driver does not support ${feature} on ${meta.className}.`);
    };
    if (meta.schema || this.config.get('schema')) unsupported('SQL schemas');
    if (meta.virtual || meta.view || meta.inheritanceType === 'tpt') unsupported('views or table-per-type inheritance');
    if (meta.triggers?.length || meta.checks.length) unsupported('triggers or check constraints');
    if (!meta.primaryKeys.length) unsupported('tables without primary keys');
    for (const prop of meta.props) {
      if (prop.targetMeta) prop.createForeignKeyConstraint = false;
      if (prop.generated) unsupported(`generated expression ${prop.name}`);
      if (prop.autoincrement && !prop.primary) unsupported(`non-primary generated sequence ${prop.name}`);
      if (prop.defaultRaw && !/^(?:null|true|false|[-+]?\d+(?:\.\d+)?|'.*'(?:u)?)$/i.test(String(prop.defaultRaw)))
        unsupported(`non-literal database default ${prop.name}`);
      if (prop.primary && prop.nullable) unsupported(`nullable primary key ${prop.name}`);
      if (prop.kind === ReferenceKind.SCALAR && !prop.formula && prop.persist !== false) this.validateColumnType(prop);
    }
    this.#tables.set(meta.tableName, meta.root.discriminatorColumn ? meta.root : meta);
  }
  private validateColumnType(prop: EntityProperty): void {
    for (const type of prop.columnTypes ?? []) {
      if (!/^(?:Utf8|String|Int32|Int64|Double|Bool|Timestamp|JsonDocument|Serial|Serial8)$/i.test(type)) {
        throw new Error(`YDB SQL driver does not support column type ${type} on ${prop.name}.`);
      }
    }
  }
}
