# Extending the YDB SQL driver

The public extension API described here requires **0.3.0 or a source build containing these changes**. It is not part of the immutable 0.2.0 release. The baseline is MikroORM 7.2.9, `@mikro-orm/sql` 7.2.9, and their shared Kysely runtime. See [SQL.md](SQL.md) for ordinary driver configuration and engine boundaries.

Extensions can supply a SQL platform and connection class, validate an additional column type, bind its values, and decode its wire representation while reusing the standard YQL compiler, schema helper, pooling, and transaction lifecycle. The default driver remains strict: Decimal columns, check constraints, partial indexes, and non-primary sequences are not enabled by adding these hooks.

## Compose a driver from public components

MikroORM constructs a configured driver with one `Configuration` argument. A small driver subclass supplies the optional second argument to `YdbSqlDriver`:

```ts
import { type Configuration, MikroORM, type Options } from '@mikro-orm/core';
import type { Type as WireType, Value as WireValue } from '@ydbjs/api/value';
import type { Value } from '@ydbjs/value';
import {
  createYdbValue,
  YdbConnection,
  YdbSqlConnection,
  YdbSqlDriver,
  type YdbSqlDriverComponents,
  YdbSqlPlatform,
} from '@rozenshtein94/mikro-orm-ydb';

class ApplicationPlatform extends YdbSqlPlatform {
  override createParameterValue(value: unknown, declaration: string): Value {
    return createYdbValue(value, declaration);
  }
}

class ApplicationNativeConnection extends YdbConnection {
  protected override getParameterTypeDeclaration(value: Value): string {
    return super.getParameterTypeDeclaration(value);
  }

  protected override decodeResultValue(value: WireValue, type: WireType): unknown {
    return super.decodeResultValue(value, type);
  }
}

class ApplicationSqlConnection extends YdbSqlConnection {
  protected override createNativeConnection(): ApplicationNativeConnection {
    return new ApplicationNativeConnection(this.config, this.options, this.type);
  }
}

class ApplicationDriver extends YdbSqlDriver {
  constructor(config: Configuration) {
    const components: YdbSqlDriverComponents = {
      platform: new ApplicationPlatform(),
      connection: ApplicationSqlConnection,
    };
    super(config, components);
  }
}

export function createApplicationOrm(entities: Options<ApplicationDriver>['entities']) {
  return MikroORM.init<ApplicationDriver>({
    driver: ApplicationDriver,
    entities,
    clientUrl: 'grpc://localhost:2136',
    dbName: '/local',
  });
}
```

This example preserves the built-in behavior; replace the pass-through hooks only for the additional behavior you implement. `platform` is an instance created for one ORM. `connection` is a constructor compatible with `YdbSqlConnection`, not a preconnected instance. Either component may be omitted to retain its built-in implementation.

Keep component selection in this constructor argument. `driverOptions` continues to carry native SDK settings such as `driverConfig`, timeouts, and an optional externally owned SDK Driver. It is not a platform/connection dependency-injection container. Use one Kysely runtime matching `@mikro-orm/sql`; the component API does not permit substituting an external Kysely instance or dialect with different ownership.

Declare SDK packages imported by an extension as direct dependencies of that application or extension package. The codec example uses `@ydbjs/api@6.0.7`, `@ydbjs/value@6.0.8`, and `@bufbuild/protobuf@2.12.0`, matching the driver baseline. Keep those versions aligned when extending the SDK's public wire/value interfaces.

`YdbSqlConnection` caches the native connection returned by `createNativeConnection()`. It attaches the current SQL platform and discovered metadata, closes the owned transport through its normal lifecycle, and creates a fresh transport after close when needed. The replacement receives the current metadata and platform as well. Override the factory to select a native subclass; preserve the inherited `getYdbConnection()`, `connect()`, and `close()` behavior.

## Metadata lookup is independent of validation

The SQL driver attaches MikroORM's live `MetadataStorage` through `YdbSqlPlatform.setMetadata()`. Consumers normally do not call that method themselves. The platform exposes:

| API | Result |
| --- | --- |
| `getTableMetadata(table)` | Discovered metadata for a physical table, or `undefined` |
| `getColumnType(table, column)` | Stored declaration for a physical column, including a trailing `?` for nullable columns |
| `getPrimaryKeyColumns(table)` | Ordered physical primary-key column names |

Lookup respects renamed fields, composite keys, and the root physical table for single-table inheritance. The returned metadata belongs to MikroORM; use it for inspection and do not mutate it after discovery.

Registration does not depend on an extension calling `super.validateMetadata()`. A complete `validateMetadata()` override can therefore implement its own strict policy while the standard query builder still sees registered table and column metadata. Such an override assumes responsibility for every omitted base check, including schemas, unsupported entity/table features, primary keys, generated/default expressions, and supported property types. It should deliberately reject features the extension does not implement.

For an additional stored type, extending the narrow protected validator usually preserves more built-in checks:

```ts
import type { EntityProperty } from '@mikro-orm/core';
import { YdbSqlPlatform } from '@rozenshtein94/mikro-orm-ydb';

class DecimalValidationPlatform extends YdbSqlPlatform {
  protected override validateColumnType(prop: EntityProperty): void {
    for (const declaration of prop.columnTypes ?? []) {
      const match = /^Decimal\((\d+),\s*(\d+)\)$/.exec(declaration);
      if (match) {
        const precision = Number(match[1]);
        const scale = Number(match[2]);
        if (precision < 1 || precision > 35 || scale < 0 || scale > precision) {
          throw new Error('Decimal precision must be 1..35 and scale must be 0..precision.');
        }
        continue;
      }
      super.validateColumnType({ ...prop, columnTypes: [declaration] });
    }
  }
}
```

This opts into metadata validation only. It still needs a matching application type, parameter encoder, declaration formatter, and result decoder before the extra type can be used. Do not treat a successful schema declaration as proof of a complete value round trip.

### Dynamic discovery needs an explicit validation step

In the supported MikroORM 7.2.9 baseline, `orm.discoverEntity()` updates the live metadata storage but does not invoke this platform's validation policy for the newly discovered entity. The live lookup makes new fields visible; it does not promise automatic revalidation.

Validate before performing dynamic schema operations or writes:

```ts
import { EntitySchema } from '@mikro-orm/core';

class AddedRecord {
  id!: string;
  label!: string;
}

const AddedSchema = new EntitySchema<AddedRecord>({
  class: AddedRecord,
  tableName: 'added_record',
  properties: {
    id: { type: 'string', primary: true, fieldName: 'record_key' },
    label: { type: 'string', fieldName: 'display_label' },
  },
});

orm.discoverEntity(AddedSchema);
const platform = orm.driver.getPlatform();
platform.validateMetadata(orm.getMetadata(AddedRecord));

// The accepted metadata is now available to the ordinary compiler and schema helper.
await orm.schema.update({ wrap: false, dropTables: false, safe: true });
```

Apply the validation step to every newly discovered entity, including its related or inherited entities, according to the extension's policy. Coordinate dynamic schema changes through the application's deployment process rather than concurrent request handlers.

## Extend the value path without copying the compiler

`YdbSqlPlatform.createParameterValue(value, declaration)` returns an official SDK `Value`. The declaration is metadata derived, for example `Int64` or `Decimal(35,9)?`. The standard `YdbNativeQueryBuilder` calls this hook for metadata-backed mutation values and retains its existing typed casts and parameter ordering. `createYdbValue(value, declaration)` exposes the built-in value factory for delegation; already constructed SDK values can pass through it.

Keep all values bound. A custom encoder should validate range, nullability, and exact representation, return a compatible SDK `Value`, and leave unrelated declarations to the built-in factory. A MikroORM custom `Type` should supply the stored declaration and convert values consistently for Unit of Work, direct driver operations, filters, hydration, and comparisons. Override `getDefaultMappedType()` when schema introspection needs the extension's mapped type as well.

The root package also exports `YdbNativeQueryBuilder`, `YdbSchemaHelper`, and the `YdbQueryPlatform` interface. These let an extension reuse the standard components through supported imports. Adding a value codec does not require copying the query compiler, replacing the schema helper, importing files from `dist/` internals, or replacing the connection lifecycle.

The native connection provides two codec hooks alongside the platform hook:

| Hook | Responsibility |
| --- | --- |
| `YdbSqlPlatform.createParameterValue(value, declaration)` | Convert the application/database value to an exact SDK value and type |
| `YdbConnection.getParameterTypeDeclaration(value)` | Produce the YQL declaration for that SDK type, preserving type parameters |
| `YdbConnection.decodeResultValue(wireValue, wireType)` | Decode one returned protocol value with its complete protocol type |

The last two methods are protected extension methods. Delegate unhandled types to `super`. The declaration formatter must agree with the type encoded by `value.type.encode()`, including precision/scale and optional wrappers. The result decoder must handle optional/null encodings for every additional result type it accepts. Do not convert a codec failure into a successful empty result.

### Exact Decimal is an executable extension example

The pinned `@ydbjs/value@6.0.8` package exposes the public `Value`/`Type` protocols but has no Decimal value class, its standard result conversion does not decode Decimal, and its type printer emits `Decimal` without precision/scale. An exact Decimal extension therefore implements **all three codec hooks** as well as a custom MikroORM type and a strict validation policy.

The complete runnable example is [tests/extensions.integration.test.ts](tests/extensions.integration.test.ts). It implements a finite Decimal codec using a scaled signed Int128 wire representation, emits `Decimal(precision,scale)` declarations, handles optional values, and decodes exact decimal strings for the application's representation. Its wire encoding follows the [official YDB Python SDK conversion implementation](https://github.com/ydb-platform/ydb-python-sdk/blob/main/ydb/convert.py). YDB's supported precision and scale are described in the [numeric types reference](https://ydb.tech/docs/en/yql/reference/types/primitive#numeric).

That fixture uses physical `Decimal(35,9)`, `Decimal(22,9)`, and `Decimal(35,18)` columns with the standard native SQL compiler and schema helper. It checks schema introspection/no-op diffing, managed persistence/change tracking/identity mapping, native and batch writes, equality/range filters, numeric ordering, pagination, rollback, and adding another Decimal column. Adjacent large values distinguish exact behavior beyond JavaScript `number` precision, including a one-unit change at the eighteenth fractional digit. The physical storage and bound protocol values are Decimal; decimal strings serve as the application's exact representation.

The fixture intentionally rejects excess precision/scale, JavaScript numbers, implicit rounding, exponent notation, Infinity, and NaN. Those are choices made by the example extension. They are not a declaration that the default driver now implements Decimal or every YDB Decimal special value. Build and validate the policy your application needs.

[tests/extensions.test.ts](tests/extensions.test.ts) separately demonstrates public component composition, a complete strict validation override, renamed/composite/STI metadata lookup, dynamic discovery lookup, native connection replacement, and preservation of the default rejection rules. Its lightweight parameter-hook examples exercise wiring; the physical Decimal suite supplies the end-to-end codec example.

## Keep engine and recovery guarantees explicit

An extension's validator defines what it accepts; the database and implementation must support the complete behavior behind each accepted feature. The unchanged default driver still rejects Decimal declarations, check constraints, partial indexes, and non-primary generated sequences. Broadening one validator does not add the corresponding compiler, schema, migration, or codec behavior.

These hooks also preserve the existing migration policy. `YdbMigrationStorage.withMigrationLock()` normally releases its lock after a caught migration error, and previously committed DDL can remain without a corresponding history entry. Process interruption or cleanup failure can leave a durable lock requiring operator inspection. A stronger policy that retains a lock after every failed DDL step, records recovery state, or requires reconciliation before the next attempt belongs to the application's migration/recovery design. Component injection does not make DDL transactional or change the built-in lock policy.

Maintain the [SQL driver's engine boundaries](SQL.md#transactions-and-engine-boundaries), including application-managed foreign-key integrity, lack of savepoints, independently committed DDL, bounded Table API results, and explicit transaction-conflict handling. Exercise additional types against a real YDB instance as well as unit fixtures, and document the exact package versions and supported precision/semantics for the resulting extension.
