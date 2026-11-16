import { type Connection, type Transaction } from '@mikro-orm/core';
import {
  SchemaHelper,
  type AbstractSqlConnection,
  type CheckDef,
  type Column,
  type DatabaseSchema,
  type DatabaseTable,
  type ForeignKey,
  type IndexDef,
  type SqlRoutineDef,
  type Table,
  type TableDifference,
} from '@mikro-orm/sql';
import { type ColumnMeta, type DescribeTableResult, type TableIndexDescription } from '@ydbjs/api/table';
import { type Type as YdbType, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import { fromYdb, toJs } from '@ydbjs/value';
import type { YdbConnection } from './YdbConnection.js';

const primitiveTypes = new Map<Type_PrimitiveTypeId, string>([
  [Type_PrimitiveTypeId.BOOL, 'Bool'],
  [Type_PrimitiveTypeId.INT8, 'Int8'],
  [Type_PrimitiveTypeId.UINT8, 'Uint8'],
  [Type_PrimitiveTypeId.INT16, 'Int16'],
  [Type_PrimitiveTypeId.UINT16, 'Uint16'],
  [Type_PrimitiveTypeId.INT32, 'Int32'],
  [Type_PrimitiveTypeId.UINT32, 'Uint32'],
  [Type_PrimitiveTypeId.INT64, 'Int64'],
  [Type_PrimitiveTypeId.UINT64, 'Uint64'],
  [Type_PrimitiveTypeId.FLOAT, 'Float'],
  [Type_PrimitiveTypeId.DOUBLE, 'Double'],
  [Type_PrimitiveTypeId.DATE, 'Date'],
  [Type_PrimitiveTypeId.DATETIME, 'Datetime'],
  [Type_PrimitiveTypeId.TIMESTAMP, 'Timestamp'],
  [Type_PrimitiveTypeId.INTERVAL, 'Interval'],
  [Type_PrimitiveTypeId.DATE32, 'Date32'],
  [Type_PrimitiveTypeId.DATETIME64, 'Datetime64'],
  [Type_PrimitiveTypeId.TIMESTAMP64, 'Timestamp64'],
  [Type_PrimitiveTypeId.INTERVAL64, 'Interval64'],
  [Type_PrimitiveTypeId.STRING, 'String'],
  [Type_PrimitiveTypeId.UTF8, 'Utf8'],
  [Type_PrimitiveTypeId.YSON, 'Yson'],
  [Type_PrimitiveTypeId.JSON, 'Json'],
  [Type_PrimitiveTypeId.UUID, 'Uuid'],
  [Type_PrimitiveTypeId.JSON_DOCUMENT, 'JsonDocument'],
  [Type_PrimitiveTypeId.DYNUMBER, 'DyNumber'],
]);

interface SchemaConnection extends AbstractSqlConnection {
  getYdbConnection(): YdbConnection & { listTables(): Promise<string[]> };
}

/** Native YDB introspection and YQL DDL used by MikroORM's SQL schema generator. */
export class YdbSchemaHelper extends SchemaHelper {
  override supportsSchemaConstraints(): boolean {
    return false;
  }

  override async databaseExists(connection: Connection, _name: string): Promise<boolean> {
    await connection.ensureConnection();
    const result = await connection.checkConnection();
    if (!result.ok) {
      throw new Error(`Cannot access the configured YDB database: ${result.reason}`, { cause: result.error });
    }
    return true;
  }

  override getCreateDatabaseSQL(_name: string): string {
    throw new Error('YDB database provisioning requires its control plane; connect to an existing database.');
  }

  override getDropDatabaseSQL(_name: string): string {
    throw new Error('YDB database deletion requires its control plane; schema.drop() drops mapped tables only.');
  }

  override getManagementDbName(): string {
    throw new Error('YDB has no SQL management database; configure an existing database endpoint and path.');
  }

  override getCreateNamespaceSQL(_name: string): string {
    throw new Error('SQL schemas are not supported by the YDB driver.');
  }

  override getDropNamespaceSQL(_name: string): string {
    throw new Error('SQL schemas are not supported by the YDB driver.');
  }

  override async getAllTables(
    connection: AbstractSqlConnection,
    schemas?: string[],
    ctx?: Transaction,
  ): Promise<Table[]> {
    this.assertIntrospectionOptions(schemas, ctx);
    const names = await this.native(connection).listTables();
    return names.map(name => ({ table_name: name }));
  }

  override async tableExists(
    connection: AbstractSqlConnection,
    tableName: string,
    schemaName?: string,
    ctx?: Transaction,
  ): Promise<boolean> {
    this.assertIntrospectionOptions(schemaName ? [schemaName] : undefined, ctx);
    return (await this.native(connection).describeTable(tableName)) !== undefined;
  }

  override async loadInformationSchema(
    schema: DatabaseSchema,
    connection: AbstractSqlConnection,
    tables: Table[],
    schemas?: string[],
    ctx?: Transaction,
  ): Promise<void> {
    this.assertIntrospectionOptions(schemas, ctx);
    const descriptions = await Promise.all(
      tables.map(table => this.native(connection).describeTable(table.table_name)),
    );
    for (let index = 0; index < tables.length; index++) {
      const name = tables[index].table_name;
      const description = descriptions[index];
      if (!description) {
        throw new Error(`YDB table ${name} disappeared during schema introspection; retry the schema operation.`);
      }
      const table = schema.addTable(name, undefined);
      table.init(this.columns(name, description), this.indexes(name, description), [], description.primaryKey, {});
    }
  }

  override async loadViews(
    _schema: DatabaseSchema,
    _connection: AbstractSqlConnection,
    schemaName?: string,
    ctx?: Transaction,
  ): Promise<void> {
    this.assertIntrospectionOptions(schemaName ? [schemaName] : undefined, ctx);
    // Views are not part of this driver's schema model; metadata declaring a view is rejected by the platform.
  }

  override async getAllRoutines(_connection: AbstractSqlConnection, schemas?: string[]): Promise<SqlRoutineDef[]> {
    this.assertIntrospectionOptions(schemas);
    return [];
  }

  override createTable(table: DatabaseTable, _alter?: boolean): string[] {
    this.assertTable(table);
    const primary = table.getPrimaryKey();
    if (!primary?.columnNames.length) {
      throw new Error(`YDB table ${table.name} requires a primary key.`);
    }
    const columns = table.getColumns().map(column => this.createTableColumn(column, table));
    columns.push(`primary key (${primary.columnNames.map(name => this.quote(name)).join(', ')})`);
    for (const index of table.getIndexes().filter(index => !index.primary)) {
      columns.push(this.indexDefinition(index));
    }
    return [`create table ${table.getQuotedName()} (${columns.join(', ')})`];
  }

  override createTableColumn(column: Column, table: DatabaseTable, _changedProperties?: Set<string>): string {
    this.assertColumn(column, table.name);
    const type = this.columnType(column);
    const definition = `${this.quote(column.name)} ${type}${column.nullable ? '' : ' not null'}`;
    return column.default != null && column.default !== 'null' && !column.autoincrement
      ? `${definition} default ${this.literalDefault(column.default, table.name, column.name)}`
      : definition;
  }

  override getAddColumnsSQL(table: DatabaseTable, columns: Column[]): string[] {
    return columns.map(column => {
      if (column.primary || !column.nullable || column.autoincrement) {
        throw new Error(
          `Cannot automatically add required or primary YDB column ${table.name}.${column.name}; add a nullable column and backfill explicitly.`,
        );
      }
      return `alter table ${table.getQuotedName()} add column ${this.createTableColumn(column, table)}`;
    });
  }

  override getDropColumnsSQL(tableName: string, columns: Column[], schemaName?: string): string {
    this.assertIntrospectionOptions(schemaName ? [schemaName] : undefined);
    for (const column of columns) {
      if (column.primary || !column.nullable) {
        throw new Error(
          `Cannot automatically drop required or primary YDB column ${tableName}.${column.name}; use an explicit migration.`,
        );
      }
    }
    return `alter table ${this.quote(tableName)} ${columns.map(column => `drop column ${this.quote(column.name)}`).join(', ')}`;
  }

  override alterTable(diff: TableDifference, safe?: boolean): string[] {
    this.assertTable(diff.toTable);
    this.assertPrimaryKeyUnchanged(diff);
    if (Object.keys(diff.changedColumns).length) {
      const changes = Object.entries(diff.changedColumns).map(
        ([name, change]) => `${name} (${[...change.changedProperties].join(', ')})`,
      );
      throw new Error(
        `Cannot automatically change YDB columns on ${diff.name}: ${changes.join('; ')}. Use an explicit migration.`,
      );
    }
    if (Object.keys(diff.renamedColumns).length) {
      throw new Error(`Cannot automatically rename YDB columns on ${diff.name}; use an explicit migration.`);
    }
    this.assertNoUnsupportedDiff(diff);
    const statements: string[] = [];
    // Generate the complete table plan before returning any SQL to the generator.
    const additions = this.getAddColumnsSQL(diff.toTable, Object.values(diff.addedColumns));
    const removals =
      !safe && Object.keys(diff.removedColumns).length
        ? [this.getDropColumnsSQL(diff.name, Object.values(diff.removedColumns))]
        : [];
    for (const index of [...Object.values(diff.removedIndexes), ...Object.values(diff.changedIndexes)]) {
      statements.push(this.dropIndex(diff.name, index));
    }
    statements.push(...removals, ...additions);
    for (const index of [...Object.values(diff.addedIndexes), ...Object.values(diff.changedIndexes)]) {
      statements.push(this.getCreateIndexSQL(diff.name, index));
    }
    for (const [oldName, index] of Object.entries(diff.renamedIndexes)) {
      statements.push(...this.getRenameIndexSQL(diff.name, index, oldName));
    }
    return statements;
  }

  override alterTableColumn(column: Column, table: DatabaseTable, changedProperties: Set<string>): string[] {
    throw new Error(
      `Cannot automatically change YDB column ${table.name}.${column.name} (${[...changedProperties].join(', ')}); use an explicit migration.`,
    );
  }

  override getRenameColumnSQL(tableName: string, oldColumnName: string, _to: Column, _schemaName?: string): string {
    throw new Error(`Cannot automatically rename YDB column ${tableName}.${oldColumnName}; use an explicit migration.`);
  }

  override getCreateIndexSQL(tableName: string, index: IndexDef): string {
    if (index.primary) {
      throw new Error(`Cannot change the YDB primary key of ${tableName}; rebuild the table explicitly.`);
    }
    return `alter table ${this.quote(tableName)} add ${this.indexDefinition(index)}`;
  }

  override createIndex(index: IndexDef, table: DatabaseTable, createPrimary = false): string {
    if (index.primary && !createPrimary) {
      return '';
    }
    return this.getCreateIndexSQL(table.getShortestName(), index);
  }

  override dropIndex(table: string, index: IndexDef, oldIndexName = index.keyName): string {
    if (index.primary) {
      throw new Error(`Cannot change the YDB primary key of ${table}; rebuild the table explicitly.`);
    }
    return `alter table ${this.quote(table)} drop index ${this.quote(oldIndexName)}`;
  }

  override getDropIndexSQL(tableName: string, index: IndexDef): string {
    return this.dropIndex(tableName, index);
  }

  override getRenameIndexSQL(tableName: string, index: IndexDef, oldIndexName: string): string[] {
    this.validateIndex(index);
    return [
      `alter table ${this.quote(tableName)} rename index ${this.quote(oldIndexName)} to ${this.quote(index.keyName)}`,
    ];
  }

  override dropTableIfExists(name: string, schema?: string): string {
    this.assertIntrospectionOptions(schema ? [schema] : undefined);
    // The connection implements IF EXISTS by ignoring only the native table-not-found error.
    return `drop table if exists ${this.quote(name)}`;
  }

  override createForeignKey(_table: DatabaseTable, _foreignKey: ForeignKey): string {
    throw new Error('YDB does not support foreign-key DDL in this driver; use application-managed relations.');
  }

  override dropForeignKey(_tableName: string, _constraintName: string): string {
    throw new Error('YDB does not support foreign-key DDL in this driver.');
  }

  override createCheck(_table: DatabaseTable, _check: CheckDef): string {
    throw new Error('YDB check constraints are not supported by this driver.');
  }

  override alterTableComment(_table: DatabaseTable, _comment?: string): string {
    throw new Error('YDB table comments are not supported by this driver.');
  }

  private native(connection: AbstractSqlConnection): ReturnType<SchemaConnection['getYdbConnection']> {
    const candidate = connection as SchemaConnection;
    if (typeof candidate.getYdbConnection !== 'function') {
      throw new Error('YDB schema introspection requires a YdbSqlConnection.');
    }
    return candidate.getYdbConnection();
  }

  private columns(tableName: string, description: DescribeTableResult): Column[] {
    return description.columns.map(column => {
      const optional = column.type?.type.case === 'optionalType';
      const type = optional && column.type?.type.case === 'optionalType' ? column.type.type.value.item : column.type;
      const typeName = this.typeName(type, `${tableName}.${column.name}`);
      const generated = column.defaultValue.case === 'fromSequence';
      return {
        name: column.name,
        type: typeName,
        mappedType: this.platform.getMappedType(typeName),
        nullable: column.notNull !== undefined ? !column.notNull : optional,
        primary: description.primaryKey.includes(column.name),
        autoincrement: generated,
        default: this.columnDefault(column, tableName),
      };
    });
  }

  private indexes(tableName: string, description: DescribeTableResult): IndexDef[] {
    const primary: IndexDef = {
      keyName: this.platform.getDefaultPrimaryName(tableName, description.primaryKey),
      columnNames: description.primaryKey,
      composite: description.primaryKey.length > 1,
      primary: true,
      unique: true,
      constraint: true,
    };
    return [primary, ...description.indexes.map(index => this.describeIndex(tableName, index))];
  }

  private describeIndex(tableName: string, index: TableIndexDescription): IndexDef {
    if (index.type.case !== 'globalIndex' && index.type.case !== 'globalUniqueIndex') {
      throw new Error(
        `Cannot introspect YDB index ${tableName}.${index.name}: only synchronous secondary indexes are supported.`,
      );
    }
    return {
      keyName: index.name,
      columnNames: index.indexColumns,
      composite: index.indexColumns.length > 1,
      unique: index.type.case === 'globalUniqueIndex',
      constraint: index.type.case === 'globalUniqueIndex',
      primary: false,
      ...(index.dataColumns.length ? { include: index.dataColumns } : {}),
    };
  }

  private typeName(type: YdbType | undefined, column: string): string {
    if (type?.type.case === 'typeId') {
      const primitive = primitiveTypes.get(type.type.value);
      if (primitive) {
        return primitive;
      }
    }
    if (type?.type.case === 'decimalType') {
      return `Decimal(${type.type.value.precision},${type.type.value.scale})`;
    }
    throw new Error(`Cannot introspect YDB column ${column}: unsupported database type.`);
  }

  private columnDefault(column: ColumnMeta, tableName: string): string | null {
    if (column.defaultValue.case === 'fromSequence' || column.defaultValue.case === undefined) {
      return null;
    }
    const value = column.defaultValue.value;
    if (!value.type || !value.value) {
      throw new Error(
        `Cannot introspect the default for YDB column ${tableName}.${column.name}: missing typed literal.`,
      );
    }
    const native = toJs(fromYdb(value.value, value.type));
    return this.literalDefault(this.platform.quoteValue(native), tableName, column.name);
  }

  private columnType(column: Column): string {
    if (column.autoincrement) {
      if (!column.primary) {
        throw new Error(`YDB automatic sequences are supported only on primary key columns (${column.name}).`);
      }
      const type = column.type.toLowerCase();
      if (type === 'serial' || type === 'int32') {
        return 'Serial';
      }
      if (type === 'serial8' || type === 'int64') {
        return 'Serial8';
      }
      throw new Error(`YDB automatic sequences support Int32/Serial and Int64/Serial8 columns only (${column.name}).`);
    }
    const primitive = [...primitiveTypes.values()].find(type => type.toLowerCase() === column.type.toLowerCase());
    if (primitive) {
      return primitive;
    }
    if (/^Decimal\(\d+,\s*\d+\)$/i.test(column.type)) {
      return column.type;
    }
    throw new Error(`Unsupported YDB column type ${column.type} on ${column.name}.`);
  }

  private literalDefault(value: string, tableName: string, columnName: string): string {
    const literal = String(value).trim();
    if (
      !/^(?:null|true|false|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?:u|l|ul|f)?|'(?:[^'\\]|\\.|'')*'u?|"(?:[^"\\]|\\.)*"u?)$/i.test(
        literal,
      )
    ) {
      throw new Error(
        `YDB default for ${tableName}.${columnName} must be a literal; SQL default expressions are not supported.`,
      );
    }
    return literal;
  }

  private indexDefinition(index: IndexDef): string {
    this.validateIndex(index);
    const columns = index.columnNames.map(name => this.quote(name)).join(', ');
    const cover = index.include?.length ? ` cover (${index.include.map(name => this.quote(name)).join(', ')})` : '';
    return `index ${this.quote(index.keyName)} global ${index.unique ? 'unique ' : ''}sync on (${columns})${cover}`;
  }

  private validateIndex(index: IndexDef): void {
    if (index.primary || !index.columnNames.length) {
      throw new Error(
        `YDB secondary index ${index.keyName} requires non-empty columnNames and cannot be a primary key.`,
      );
    }
    const advancedColumns = index.columns?.some(
      column =>
        (column.sort != null && column.sort.toLowerCase() !== 'asc') ||
        column.nulls != null ||
        column.length != null ||
        column.collation != null,
    );
    if (
      index.expression ||
      index.where ||
      index.deferMode ||
      index.type ||
      index.fillFactor != null ||
      index.invisible ||
      index.disabled ||
      index.clustered ||
      advancedColumns ||
      Object.keys(index.options ?? {}).length
    ) {
      throw new Error(
        `YDB index ${index.keyName} supports synchronous secondary keys and COVER columns only; expressions, partial, specialized, and advanced indexes require explicit native DDL.`,
      );
    }
  }

  private assertColumn(column: Column, tableName: string): void {
    if (column.generated || column.comment || column.collation || column.extra) {
      throw new Error(
        `YDB column ${tableName}.${column.name} has unsupported generated, comment, collation, or extra options.`,
      );
    }
  }

  private assertTable(table: DatabaseTable): void {
    this.assertIntrospectionOptions(table.schema ? [table.schema] : undefined);
    if (
      table.comment ||
      table.getChecks().length ||
      table.getTriggers().length ||
      table.getPolicies().length ||
      table.partitioning
    ) {
      throw new Error(
        `YDB table ${table.name} has unsupported comments, checks, triggers, policies, or declarative partitions.`,
      );
    }
    if (this.options.createForeignKeyConstraints && Object.keys(table.getForeignKeys()).length) {
      throw new Error(
        `YDB foreign-key constraints are not supported on ${table.name}; disable createForeignKeyConstraints.`,
      );
    }
  }

  private assertPrimaryKeyUnchanged(diff: TableDifference): void {
    const before = diff.fromTable.getPrimaryKey()?.columnNames ?? [];
    const after = diff.toTable.getPrimaryKey()?.columnNames ?? [];
    if (before.length !== after.length || before.some((name, index) => name !== after[index])) {
      throw new Error(`Cannot change the YDB primary key of ${diff.name}; rebuild the table explicitly.`);
    }
  }

  private assertNoUnsupportedDiff(diff: TableDifference): void {
    const unsupported = {
      checks: [
        ...Object.keys(diff.addedChecks),
        ...Object.keys(diff.removedChecks),
        ...Object.keys(diff.changedChecks),
      ],
      triggers: [
        ...Object.keys(diff.addedTriggers),
        ...Object.keys(diff.removedTriggers),
        ...Object.keys(diff.changedTriggers),
      ],
      policies: [...Object.keys(diff.addedPolicies), ...Object.keys(diff.removedPolicies)],
    };
    const changed = Object.entries(unsupported)
      .filter(([, names]) => names.length)
      .map(([name]) => name);
    if (
      changed.length ||
      diff.changedPartitioning ||
      'changedComment' in diff ||
      'changedRlsEnabled' in diff ||
      'changedRlsForced' in diff
    ) {
      throw new Error(
        `Cannot automatically change unsupported YDB table features on ${diff.name}: ${changed.join(', ') || 'table options'}.`,
      );
    }
    if (
      this.options.createForeignKeyConstraints &&
      [diff.addedForeignKeys, diff.changedForeignKeys, diff.removedForeignKeys].some(keys => Object.keys(keys).length)
    ) {
      throw new Error(
        `Cannot automatically change YDB foreign keys on ${diff.name}; relations require application validation.`,
      );
    }
  }

  private assertIntrospectionOptions(schemas?: string[], ctx?: Transaction): void {
    if (schemas?.length) {
      throw new Error('SQL schemas are not supported by the YDB driver; connect to the target database path.');
    }
    if (ctx != null) {
      throw new Error('YDB schema introspection and DDL cannot run inside a data transaction.');
    }
  }
}
