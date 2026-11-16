import {
  type ClearDatabaseOptions,
  type CreateSchemaOptions,
  type DropSchemaOptions,
  type EnsureDatabaseOptions,
  type EntityManager,
  type EntityMetadata,
  type EntityProperty,
  type MikroORM,
  type RefreshDatabaseOptions,
  type UpdateSchemaOptions,
} from '@mikro-orm/core';
import { AbstractSchemaGenerator } from '@mikro-orm/core/schema';
import type { ColumnMeta, DescribeTableResult } from '@ydbjs/api/table';
import { type Type, Type_PrimitiveTypeId } from '@ydbjs/api/value';
import type { YdbDriver } from './YdbDriver.js';

interface SchemaPlan {
  up: string[];
  down: string[];
}

const primitiveNames = new Map<Type_PrimitiveTypeId, string>([
  [Type_PrimitiveTypeId.UTF8, 'Utf8'],
  [Type_PrimitiveTypeId.INT32, 'Int32'],
  [Type_PrimitiveTypeId.INT64, 'Int64'],
  [Type_PrimitiveTypeId.DOUBLE, 'Double'],
  [Type_PrimitiveTypeId.BOOL, 'Bool'],
  [Type_PrimitiveTypeId.TIMESTAMP, 'Timestamp'],
  [Type_PrimitiveTypeId.STRING, 'String'],
  [Type_PrimitiveTypeId.JSON_DOCUMENT, 'JsonDocument'],
]);

/**
 * YDB table DDL and conservative schema diffing. DDL is not transactional in YDB.
 * Down scripts restore table definitions only: dropping a column or table loses its data.
 */
export class YdbSchemaGenerator extends AbstractSchemaGenerator<YdbDriver> {
  static register(orm: MikroORM): void {
    orm.config.registerExtension(
      '@mikro-orm/schema-generator',
      () => new YdbSchemaGenerator(orm.em as EntityManager<YdbDriver>),
    );
  }

  override async create(options: CreateSchemaOptions = {}): Promise<void> {
    const sql = await this.getCreateSchemaSQL(options);
    await this.execute(sql);
  }

  override async getCreateSchemaSQL(options: CreateSchemaOptions = {}): Promise<string> {
    this.validateOptions(options);
    return this.join(this.getOrderedMetadata().map(meta => this.createTable(meta)));
  }

  override async drop(options: DropSchemaOptions = {}): Promise<void> {
    if (options.dropDb) {
      throw new Error('YDB database provisioning is not supported; drop tables with schema.drop() instead.');
    }
    if (options.dropMigrationsTable) {
      throw new Error('The YDB driver does not manage a SQL migrator table.');
    }
    this.validateOptions(options);
    const metadata = this.getOrderedMetadata().reverse();
    const descriptions = await Promise.all(metadata.map(meta => this.connection.describeTable(meta.tableName)));
    const statements = metadata.filter((_, index) => descriptions[index]).map(meta => this.dropTable(meta.tableName));
    await this.execute(this.join(statements));
  }

  override async getDropSchemaSQL(options: Omit<DropSchemaOptions, 'dropDb'> = {}): Promise<string> {
    this.validateOptions(options);
    if (options.dropMigrationsTable) {
      throw new Error('The YDB driver does not manage a SQL migrator table.');
    }
    return this.join(
      this.getOrderedMetadata()
        .reverse()
        .map(meta => this.dropTable(meta.tableName)),
    );
  }

  override async refresh(options: RefreshDatabaseOptions = {}): Promise<void> {
    this.validateOptions(options);
    if (options.dropDb) {
      throw new Error('YDB database provisioning is not supported; omit dropDb to recreate mapped tables.');
    }
    // Generate both halves first so invalid metadata cannot cause a partial destructive refresh.
    const create = await this.getCreateSchemaSQL(options);
    await this.ensureDatabase();
    await this.drop(options);
    if (options.createSchema !== false) {
      await this.execute(create);
    }
    this.clearIdentityMap();
  }

  override async clear(options: ClearDatabaseOptions = {}): Promise<void> {
    this.validateOptions(options);
    if (options.truncate) {
      throw new Error('The YDB driver does not support TRUNCATE; omit truncate to clear mapped tables with DELETE.');
    }
    await super.clear(options);
  }

  override async ensureDatabase(options: EnsureDatabaseOptions = {}): Promise<boolean> {
    this.validateOptions(options);
    await this.connection.ensureConnection();
    const status = await this.connection.checkConnection();
    if (!status.ok) {
      throw new Error(`Cannot access the existing YDB database: ${status.reason}`, { cause: status.error });
    }
    if (options.create) {
      await this.create(options);
    }
    if (options.clear) {
      await this.clear(options);
    }
    return false;
  }

  override async createDatabase(_name?: string): Promise<void> {
    throw new Error('YDB database provisioning is not supported. Create the database before connecting.');
  }

  override async dropDatabase(_name?: string): Promise<void> {
    throw new Error('YDB database provisioning is not supported. Delete the database through its control plane.');
  }

  override async update(options: UpdateSchemaOptions = {}): Promise<void> {
    // Complete every introspection and validation before the first DDL statement.
    const plan = await this.planUpdate(options);
    await this.execute(this.join(plan.up));
  }

  override async getUpdateSchemaSQL(options: UpdateSchemaOptions = {}): Promise<string> {
    return this.join((await this.planUpdate(options)).up);
  }

  override async getUpdateSchemaMigrationSQL(options: UpdateSchemaOptions = {}): Promise<{ up: string; down: string }> {
    const plan = await this.planUpdate(options);
    return { up: this.join(plan.up), down: this.join(plan.down) };
  }

  override async ensureIndexes(): Promise<void> {
    throw new Error('YDB index management is not supported by this driver.');
  }

  /** Executes generated DDL scripts. Each statement commits independently in YDB. */
  override async execute(sql: string, options: { wrap?: boolean } = {}): Promise<void> {
    this.validateOptions(options);
    const statements = this.splitStatements(sql);
    // Validate the complete script before executing anything.
    for (const statement of statements) {
      if (!/^(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s/i.test(statement)) {
        throw new Error(
          'YdbSchemaGenerator.execute() accepts CREATE TABLE, ALTER TABLE, and DROP TABLE statements only.',
        );
      }
    }
    for (const statement of statements) {
      await this.connection.executeScheme(`${statement};`);
    }
  }

  private async planUpdate(options: UpdateSchemaOptions): Promise<SchemaPlan> {
    this.validateOptions(options);
    if (options.dropDb) {
      throw new Error('YDB schema updates cannot drop or provision databases.');
    }
    if (options.dropTables) {
      throw new Error(
        'YDB schema updates do not discover or drop unmapped tables; use an explicit reviewed migration.',
      );
    }
    if (options.fromSchema !== undefined) {
      throw new Error('YDB schema updates require live describeTable introspection; fromSchema is not supported.');
    }
    const metadata = this.getOrderedMetadata();
    // Validate metadata before any network call, and inspect all tables before applying DDL.
    for (const meta of metadata) {
      this.createTable(meta);
    }
    const tables = await Promise.all(metadata.map(meta => this.connection.describeTable(meta.tableName)));
    const plan: SchemaPlan = { up: [], down: [] };
    for (let i = 0; i < metadata.length; i++) {
      const meta = metadata[i];
      const table = tables[i];
      if (!table) {
        plan.up.push(this.createTable(meta));
        plan.down.unshift(this.dropTable(meta.tableName));
        continue;
      }
      const tablePlan = this.diffTable(meta, table, options.safe ?? true);
      plan.up.push(...tablePlan.up);
      plan.down.unshift(...tablePlan.down);
    }
    return plan;
  }

  private diffTable(meta: EntityMetadata, table: DescribeTableResult, safe: boolean): SchemaPlan {
    const plan: SchemaPlan = { up: [], down: [] };
    const tableName = meta.tableName;
    const expectedKey = meta.getPrimaryProps().flatMap(prop => prop.fieldNames);
    if (expectedKey.length !== table.primaryKey.length || expectedKey.some((name, i) => name !== table.primaryKey[i])) {
      throw new Error(`Cannot change the YDB primary key of ${tableName}; use an explicit table rebuild migration.`);
    }
    if (table.indexes.length > 0) {
      throw new Error(`Cannot diff YDB table ${tableName}: index management is not supported by this driver.`);
    }
    const properties = this.platform.columnProperties(meta);
    const current = new Map(table.columns.map(column => [column.name, column]));
    const expected = new Set(properties.map(prop => prop.fieldNames[0]));
    for (const prop of properties) {
      const name = prop.fieldNames[0];
      const column = current.get(name);
      if (!column) {
        if (!prop.nullable) {
          throw new Error(
            `Cannot add non-nullable YDB column ${tableName}.${name}; add a nullable column and backfill explicitly.`,
          );
        }
        plan.up.push(this.addColumn(tableName, name, this.platform.getYdbType(prop)));
        plan.down.unshift(this.dropColumn(tableName, name));
        continue;
      }
      const definition = this.describeColumn(tableName, column);
      const type = this.platform.getYdbType(prop);
      if (definition.type !== type) {
        throw new Error(
          `Cannot change the YDB type of ${tableName}.${name} from ${definition.type} to ${type}; use an explicit migration.`,
        );
      }
      if (definition.nullable !== !!prop.nullable) {
        throw new Error(`Cannot change YDB nullability of ${tableName}.${name}; use an explicit migration.`);
      }
    }
    for (const column of table.columns) {
      if (expected.has(column.name) || safe) {
        continue;
      }
      const definition = this.describeColumn(tableName, column);
      if (!definition.nullable) {
        throw new Error(
          `Cannot automatically drop non-nullable YDB column ${tableName}.${column.name}; use an explicit migration.`,
        );
      }
      plan.up.push(this.dropColumn(tableName, column.name));
      plan.down.unshift(this.addColumn(tableName, column.name, definition.type));
    }
    return plan;
  }

  private describeColumn(tableName: string, column: ColumnMeta): { type: string; nullable: boolean } {
    if (column.defaultValue.case !== undefined) {
      throw new Error(`Cannot diff YDB column ${tableName}.${column.name}: database defaults are not supported.`);
    }
    const optional = column.type?.type.case === 'optionalType';
    const type = column.type?.type.case === 'optionalType' ? column.type.type.value.item : column.type;
    const name = this.typeName(type);
    if (!name) {
      throw new Error(`Cannot diff YDB column ${tableName}.${column.name}: its database type is not supported.`);
    }
    return { type: name, nullable: column.notNull !== undefined ? !column.notNull : optional };
  }

  private typeName(type: Type | undefined): string | undefined {
    return type?.type.case === 'typeId' ? primitiveNames.get(type.type.value) : undefined;
  }

  private createTable(meta: EntityMetadata): string {
    this.platform.validateMetadata(meta);
    const columns = this.platform.columnProperties(meta).map(prop => this.columnDefinition(prop));
    const primaryKeys = meta.getPrimaryProps().flatMap(prop => prop.fieldNames);
    if (primaryKeys.length === 0) {
      throw new Error(`YDB table ${meta.tableName} requires an application-assigned primary key.`);
    }
    columns.push(`PRIMARY KEY (${primaryKeys.map(name => this.platform.quoteIdentifier(name)).join(', ')})`);
    return `CREATE TABLE ${this.platform.quoteIdentifier(meta.tableName)} (\n  ${columns.join(',\n  ')}\n);`;
  }

  private columnDefinition(prop: EntityProperty): string {
    return `${this.platform.quoteIdentifier(prop.fieldNames[0])} ${this.platform.getYdbType(prop)}${prop.nullable ? '' : ' NOT NULL'}`;
  }

  private dropTable(tableName: string): string {
    return `DROP TABLE ${this.platform.quoteIdentifier(tableName)};`;
  }

  private addColumn(tableName: string, columnName: string, type: string): string {
    return `ALTER TABLE ${this.platform.quoteIdentifier(tableName)} ADD COLUMN ${this.platform.quoteIdentifier(columnName)} ${type};`;
  }

  private dropColumn(tableName: string, columnName: string): string {
    return `ALTER TABLE ${this.platform.quoteIdentifier(tableName)} DROP COLUMN ${this.platform.quoteIdentifier(columnName)};`;
  }

  private validateOptions(options: { schema?: string; wrap?: boolean; includeWildcardSchema?: boolean }): void {
    if (options.schema !== undefined || options.includeWildcardSchema) {
      throw new Error(
        'YDB schemas and wildcard schema selection are not supported; configure the database connection instead.',
      );
    }
    if (options.wrap) {
      throw new Error('YDB DDL cannot be wrapped in a transaction; omit wrap.');
    }
  }

  private join(statements: string[]): string {
    return statements.length > 0 ? `${statements.join('\n')}\n` : '';
  }

  private splitStatements(sql: string): string[] {
    // Generated identifiers cannot contain semicolons. Do not accept arbitrary SQL literals here.
    if (/['"\\]|--|\/\*/.test(sql)) {
      throw new Error(
        'YDB schema scripts with literals, escapes, or comments are not supported; execute them through the native client.',
      );
    }
    return sql
      .split(';')
      .map(statement => statement.trim())
      .filter(Boolean);
  }
}
