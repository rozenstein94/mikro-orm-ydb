# MikroORM SQL driver for YDB

`YdbSqlDriver` integrates native YQL with MikroORM's **v7 SQL driver contracts**. It extends `AbstractSqlDriver` from `@mikro-orm/sql`, with a YDB Kysely dialect, YQL query compiler, native SQL builder, schema helper, and SQL migrator integration. Non-recursive CTEs are compiled to YQL named subqueries. EntityManager, SQL QueryBuilder, relation loading, repositories, Unit of Work, and Identity Map use MikroORM's SQL implementation.

This document describes the SQL driver in **0.3.0**, including the public extension API documented in [EXTENDING.md](EXTENDING.md). The immutable 0.2.0 release supplies the SQL driver without those extension hooks; 0.1.1 is the earlier core-only driver. See [VERIFICATION.md](VERIFICATION.md) for the exact tested versions, commands and evidence boundaries.

The implementation targets MikroORM **7.2.9** and Kysely **0.29.8**. Keep the MikroORM packages in an application on matching versions. The package's `^7.2.9` peer ranges allow matching later v7 versions; the pinned versions in this checkout are the concrete validation baseline. The driver uses native YQL over YDB's gRPC Table API. It does not use PostgreSQL wire compatibility or Document API and makes no AWS DynamoDB compatibility claim.

## Install the SQL driver

```sh
npm install @mikro-orm/core@7.2.9 @mikro-orm/sql@7.2.9 @mikro-orm/migrations@7.2.9 \
  kysely@0.29.8 @rozenshtein94/mikro-orm-ydb@0.3.0
npm ls @mikro-orm/core @mikro-orm/sql @mikro-orm/migrations kysely --all
```

Use a single shared Kysely runtime matching the installed SQL package. An unpinned automatic peer installation can produce mismatched Kysely copies even when all individual ranges appear satisfied. The versions above match the tested MikroORM/Kysely baseline; release-artifact and registry checks are recorded separately in [VERIFICATION.md](VERIFICATION.md).

## Build from source

```sh
git clone --branch main https://github.com/rozenstein94/mikro-orm-ydb.git
cd mikro-orm-ydb
npx --yes corepack yarn install --immutable
npx --yes corepack yarn build
npx --yes corepack yarn pack --out mikro-orm-ydb-0.3.0.tgz
```

Install that artifact into the consuming application:

```sh
npm install @mikro-orm/core@7.2.9 @mikro-orm/sql@7.2.9 @mikro-orm/migrations@7.2.9 kysely@0.29.8 \
  /absolute/path/to/mikro-orm-ydb/mikro-orm-ydb-0.3.0.tgz
```

Kysely is a peer dependency. Use the exact Kysely version required by the installed `@mikro-orm/sql` package and deduplicate the tree: MikroORM 7.2.9 uses 0.29.8. The driver rejects a second, different Kysely runtime, which would break nominal TypeScript contracts and transaction-abort handling. Check the application's actual dependency graph with `npm ls @mikro-orm/core @mikro-orm/sql @mikro-orm/migrations kysely`; do not combine a newer SQL package with an older root Kysely copy.

Use Node.js 22.17 or newer and ESM. Record the source commit alongside a source-built artifact, pin the deployed package version, and commit the application lockfile. Building or packing the source does not publish it to npm.

## Configure entities and the SQL driver

Use the exported `YdbSqlDriver`. `YdbDriver` remains the separate core driver described in [README.md](README.md).

```ts
import { randomUUID } from 'node:crypto';
import { Collection, EntitySchema, LoadStrategy, MikroORM } from '@mikro-orm/core';
import { YdbMigrator, YdbSqlDriver } from '@rozenshtein94/mikro-orm-ydb';

class Author {
  id!: string;
  name!: string;
  books = new Collection<Book>(this);
}

class Book {
  id!: string;
  title!: string;
  rating!: number;
  author!: Author;
}

const AuthorSchema = new EntitySchema<Author>({
  class: Author,
  tableName: 'author',
  properties: {
    id: { type: 'string', primary: true },
    name: { type: 'string', fieldName: 'display_name' },
    books: { kind: '1:m', entity: () => Book, mappedBy: 'author' },
  },
});

const BookSchema = new EntitySchema<Book>({
  class: Book,
  tableName: 'book',
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    rating: { type: 'integer' },
    author: { kind: 'm:1', entity: () => Author, inversedBy: 'books' },
  },
});

const orm = await MikroORM.init<YdbSqlDriver>({
  driver: YdbSqlDriver,
  entities: [AuthorSchema, BookSchema],
  clientUrl: process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136',
  dbName: process.env.YDB_DATABASE ?? '/local',
  extensions: [YdbMigrator],
  migrations: {
    path: './dist/migrations',
    pathTs: './src/migrations',
    transactional: false,
    allOrNothing: false,
    dropTables: false,
    safe: true,
  },
  pool: { max: 10 },
  driverOptions: {
    connectTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
  },
});

// Development-only setup for an empty disposable database.
await orm.schema.create();

const em = orm.em.fork();
const author = em.create(Author, { id: randomUUID(), name: 'Ada' });
em.create(Book, {
  id: randomUUID(),
  title: 'Notes',
  rating: 9,
  author,
});
await em.flush();
em.clear();

const loaded = await em.findOneOrFail(Author, author.id, {
  populate: ['books'],
  strategy: LoadStrategy.JOINED,
});
console.assert(loaded.books.getItems()[0].author === loaded);
```

`schema.create()` is appropriate for an empty development database. Apply reviewed migrations in deployment; do not recreate tables at application startup. The platform disables foreign-key constraint generation because YDB does not enforce foreign keys. ORM relation metadata and pivot tables still exist.

### QueryBuilder

The SQL EntityManager exposes MikroORM's QueryBuilder, including aliased joins and hydration:

```ts
const books = await em.createQueryBuilder(Book, 'b')
  .select('*')
  .leftJoinAndSelect('b.author', 'a')
  .where({ 'a.name': 'Ada', rating: { $gte: 8 } })
  .orderBy({ 'b.rating': 'desc', 'b.id': 'asc' })
  .limit(20)
  .getResultList();
```

The YQL builder handles joins, subqueries, grouped aggregates/HAVING, pagination, inserts, updates, deletes, and primary-key conflict handling through native YQL. Values remain parameters through the SQL connection and Kysely layers. Affected-row counts come from mutation `RETURNING` results, rather than an assumed successful row count. A truncated mutation result causes the driver's own transaction to fail before commit.

Raw SQL uses YQL semantics. `connection.execute(sql, params)` accepts positional value bindings and `??` identifier bindings; it does not translate arbitrary PostgreSQL or MySQL SQL. A raw `null` parameter needs an explicitly typed SDK `Optional` value. Entity metadata lets generated mutations bind nullable and scalar values with their declared YDB types. SQL raw fragments are trusted application code and must not be built by concatenating request data.

### Relations, keys, and types

The SQL implementation provides many-to-one, inverse one-to-many, owning/inverse one-to-one, and many-to-many pivot tables through MikroORM's SQL relation machinery. Both joined and select-in loading are exercised by the live suite. SQL entity scenarios also cover composite-key relations, custom type conversion, integer version properties/optimistic locking, and single-table inheritance.

Owning one-to-one mappings generate a unique secondary index, which YDB enforces. Their referenced-row existence remains application managed. ORM-managed many-to-many operations maintain pivot rows, including cleanup when removing entities through the driver; direct native database writes do not gain foreign-key cascades.

| MikroORM declaration | YDB storage |
| --- | --- |
| `string`, `text`, `uuid` | `Utf8`; UUIDs use text storage |
| `integer`, `number` | `Int32` |
| `bigint` | `Int64` |
| `double`, `float` | `Double` |
| `boolean` | `Bool` |
| `Date`, `datetime`, `timestamp` | `Timestamp` |
| `Buffer`, `blob`, `Uint8Array` | Binary `String` |
| `json`, `object` | `JsonDocument` |
| Numeric primary key with autoincrement | `Serial` for `Int32`, `Serial8` for `Int64` |

Nullable columns use `nullable: true`; other stored columns are required. `Int32`/`Int64` bounds, finite floating point values, and the driver's supported `Timestamp` range are checked. Custom MikroORM types can convert application values to one of the supported stored types. Broader database types recognized by introspection are not automatically supported entity property declarations.

For a generated integer key:

```ts
class Item {
  id!: number;
  label!: string;
}

const ItemSchema = new EntitySchema<Item>({
  class: Item,
  properties: {
    id: { type: 'integer', primary: true, autoincrement: true },
    label: { type: 'string' },
  },
});
```

`Serial` and `Serial8` use YDB's native sequence mechanism, and generated keys are returned to the Unit of Work. Allocation can leave gaps after failed or rolled-back writes. Explicitly supplied values do not advance the sequence. [YDB's Serial documentation](https://ydb.tech/docs/en/yql/reference/types/serial) describes those semantics. For insert-heavy distributed workloads, choose keys with YDB's partitioning behavior in mind; monotonically increasing leading keys can produce hot partitions. See [YDB's primary-key guidance](https://ydb.tech/docs/en/dev/primary-key/row-oriented).

## Schema generation and indexes

`YdbSchemaHelper` connects MikroORM's standard `SqlSchemaGenerator` and `SchemaComparator` to native `ListDirectory`/`DescribeTable` introspection. It handles ordered primary keys, nullability, sequence-backed columns, literal defaults, and synchronous secondary indexes, including unique and covering indexes. YDB implements unique indexes as `GLOBAL UNIQUE SYNC`; see the [YDB index reference](https://ydb.tech/docs/en/yql/reference/syntax/create_table/secondary_index).

Inspect changes before applying them:

```ts
const change = await orm.schema.getUpdateSchemaMigrationSQL({
  wrap: false,
  dropTables: false,
  safe: true,
});
// Save and review change.up and change.down in the deployment workflow.
```

Supported automatic changes include creating tables, adding nullable columns, dropping nullable columns with `safe: false`, and creating/dropping/renaming supported indexes. Type/nullability/default changes to existing columns, primary-key changes, required-column additions/removals, and column renames require explicit migration design. Unsupported options fail instead of being represented as applied changes.

Use `dropTables: false` when inspecting a shared database so unrelated tables are preserved. SQL schemas, wildcard schema selection, database provisioning/deletion, table-per-type inheritance/views, check constraints, triggers, policies, declarative table partitioning, comments, and generated SQL expression columns are outside this schema model. Partial/expression/asynchronous/vector/full-text and other specialized indexes are not accepted by the helper; they require a separate native design rather than a misleading automatic diff.

DDL statements commit independently in YDB. Neither generated `up`/`down` scripts nor a migration run is a schema transaction. A failure can leave a prefix of a schema plan applied. Down migrations reconstruct definitions; they cannot recover rows lost by dropping a table or column. [YDB's transaction documentation](https://ydb.tech/docs/en/concepts/transactions?version=v25.3) explains the DDL/DML boundary.

`QueryBuilder.truncate()` and `orm.schema.clear()` delete table data through a transactional `DELETE ... RETURNING *`. They do not reset Serial sequence counters.

## Standard MikroORM migrations

Register **`YdbMigrator`** in `extensions`. It subclasses MikroORM's SQL `Migrator` and uses the normal `Migration` classes, file generation/discovery, pending/executed API, and up/down execution. Its storage adapts migration history to YDB; it is not the generic SQL migrator's default storage.

Both settings are required:

```ts
extensions: [YdbMigrator],
migrations: {
  transactional: false,
  allOrNothing: false,
  // Other normal options, such as path, pathTs and tableName.
},
```

The constructor rejects transactional migration configuration, caller-provided transactions, runtime SQL schemas, and wildcard schema fan-out. Do not import/register the generic `Migrator` alongside `YdbMigrator`.

For example, a normal migration class can contain native YQL DDL:

```ts
import { Migration } from '@mikro-orm/migrations';

export class MigrationCreateMessage extends Migration {
  override up(): void {
    this.addSql('create table `message` (`id` Utf8 not null, `body` Utf8 not null, primary key (`id`))');
  }

  override down(): void {
    this.addSql('drop table `message`');
  }
}
```

Generate migrations using the normal SQL generator and run the registered extension:

```ts
const migrator = orm.migrator as YdbMigrator;
const generated = await migrator.create('./src/migrations', false, false, 'create_catalog');
// Review generated.code and generated.diff before deployment.
const pending = await migrator.getPending();
await migrator.up();
const executed = await migrator.getExecuted();
// When a reviewed down migration is appropriate:
await migrator.down();
```

### History, locking, and interruption recovery

The default tracking table is `mikro_orm_migrations`, or the simple table name in `migrations.tableName`. Its schema is:

```sql
CREATE TABLE mikro_orm_migrations (
  id Int64 NOT NULL,
  name Utf8 NOT NULL,
  executed_at Timestamp NOT NULL,
  PRIMARY KEY (id)
);
```

The storage supplies positive ordered history IDs and timestamps from the application. It does not depend on a `Serial` column or database timestamp default. **`id = 0` is reserved for the run lock**: its `name` stores a random owner identifier and `executed_at` records acquisition time. Lock rows are excluded from the public executed-migration history.

A migration run atomically inserts the lock row before running migration bodies. A second runner fails while that row exists, preventing both runners from executing the same pending body. On normal completion or a caught error, the owner checks and removes its own lock. If the process is interrupted before cleanup, the durable row remains; there is no lease timeout that could allow a second process to overlap an active migration.

An interrupted process may have committed DDL without recording the corresponding migration, or recorded some migrations before interruption. The lock does not make DDL and history atomic, undo partial DDL, or prove that a pending migration has done no work. A caught migration error can also leave partial DDL after the lock is released. Inspect and reconcile the actual schema and migration history before retrying either case.

To recover a stale lock, the operator must first establish that no old migration runner is still active, inspect the lock owner and history, and reconcile any partial migration. Only then remove the matching lock row. For the default table, the inspection queries are:

```sql
SELECT id, name, executed_at FROM mikro_orm_migrations WHERE id = 0;
SELECT id, name, executed_at FROM mikro_orm_migrations WHERE id > 0 ORDER BY id;
```

Use an owner-checked delete through the native connection after that review:

```ts
import { Int64, Utf8 } from '@ydbjs/value/primitive';

const native = orm.driver.getConnection().getYdbConnection();
await native.query(
  'DELETE FROM `mikro_orm_migrations` WHERE id = $id AND name = $owner',
  {
    $id: new Int64(0n),
    $owner: new Utf8(inspectedOwner),
  },
);
```

Use the configured table name if it differs. Do not delete positive history rows or automatically clear a lock based only on its age. Removing the lock is an operator recovery action after checking the interrupted operation, not part of routine application startup.

## Transactions and engine boundaries

Normal data transactions use YDB serializable read/write transactions. `readOnly: true` selects snapshot-read-only mode. Unit of Work flushes and many-to-many mutations share the transaction context. Callbacks are not automatically replayed after conflicts; an application must decide whether retrying an entire operation, including its external effects, is safe.

The SQL API retains the database's boundaries:

- YDB has no database-enforced foreign keys or foreign-key cascades. Validate referenced rows and coordinate application deletion rules explicitly.
- Savepoints and nested database transactions are unavailable. Pessimistic row locks are rejected; use serializable transactions and handle conflicts.
- DDL cannot be combined with DML in one transaction; migration history and schema changes therefore have the interruption boundary described above.
- A bounded Table API result is not a streaming cursor. Truncated results raise errors; use bounded queries/keyset pages or the native streaming APIs for larger reads.
- Queries use YQL syntax and type rules. LATERAL/NATURAL joins, joined UPDATE/DELETE, `DISTINCT ON`, non-primary conflict targets, and unsupported isolation settings fail explicitly rather than being translated approximately.
- The schema model targets row-oriented tables and its documented index/type set. It does not imply support for every YDB analytical, vector, topic, or administration feature.

When using Kysely's own migrator directly, the dialect implements its migration-lock protocol with a native serializable transaction and a 30-second acquisition deadline. An interrupted owner can leave the lock flag set; inspect the Kysely migration state and confirm that no owner remains active before operator recovery. It does not provide automatic lock expiration.

## Serverless authentication and connection reuse

Connection settings and SDK ownership follow [README.md](README.md#ydb-serverless-connection-and-authentication). Configure the native `grpcs://` endpoint in `clientUrl` and the absolute database path in `dbName`. Split a console connection string at `/?database=`; the HTTPS Document API endpoint is a different API.

Pass an explicit provider for a runtime with an attached service account and metadata access:

```ts
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';

// In the YdbSqlDriver configuration:
driverOptions: {
  connectTimeoutMs: 30_000,
  queryTimeoutMs: 30_000,
  driverConfig: {
    credentialsProvider: new MetadataCredentialsProvider(),
  },
},
```

Install `@ydbjs/auth@6.3.1` when importing that package. `AccessTokenCredentialsProvider` is available for an externally supplied development token and does not refresh it; use a refreshing provider for a long-lived process. An omitted provider means anonymous authentication. `driverConfig.secureOptions` carries TLS settings when a custom CA is needed.

Cache one initialization promise per warm process, reset the cache if initialization fails, and fork an EntityManager per request. Do not run migrations or schema creation on each invocation. Close the ORM only when shutting down after in-flight work has completed. Supplying `driverOptions.driver` leaves the SDK Driver application-owned; the ORM releases its sessions without closing that external driver.

The [official Serverless connection documentation](https://yandex.cloud/en/docs/ydb/operations/connection) explains endpoint/database configuration. The pinned SDK's authentication API is documented in the [published `@ydbjs/auth@6.3.1` package](https://www.npmjs.com/package/@ydbjs/auth/v/6.3.1). Local YDB tests do not establish cloud IAM token refresh, TLS deployment, managed topology, cold-start latency, freeze/thaw behavior, or Serverless limits.

## Native core and SQL API differences

| Area | `YdbDriver` in 0.1.x | `YdbSqlDriver` SQL implementation |
| --- | --- | --- |
| Base | Core `DatabaseDriver` | `@mikro-orm/sql` `AbstractSqlDriver` |
| Query API | Core filters and select-in relations | SQL EntityManager and QueryBuilder with a YQL compiler |
| Loading | Select-in | Joined and select-in SQL loading |
| Relations | Supported scalar-target many-to-one/one-to-many subset | SQL relation machinery, one-to-one uniqueness and many-to-many pivots |
| Generated keys | Application assigned | Application assigned or native `Serial`/`Serial8` primary keys |
| Schema | Independent conservative schema generator | Standard SQL schema generator/comparator plus native helper and indexes |
| Migrations | Reviewed standalone schema scripts | Standard SQL `Migration` classes through `YdbMigrator` and native storage |

Changing the driver is a schema and application API decision. Review the generated schema and migrations, indexes, relation constraints, generated-key behavior, and existing data before changing an application's configuration.

MikroORM **6.6.14** requires a separate backport, package build, and real-YDB validation. The v6 SQL package was `@mikro-orm/knex`, while this implementation depends on v7's `@mikro-orm/sql` and Kysely contracts. Widening peer ranges cannot bridge that architecture change. This SQL driver also does not automatically port an application's PostgreSQL/Knex SQL, existing migrations, extensions, or service-layer assumptions.

## Validation

The checkout contains live suites for SQL QueryBuilder/joins, one-to-one and many-to-many relations, composite/custom/versioned entities, `Serial` keys, schema evolution, mutation conflicts/returning behavior, and generated/ordered/failed/interrupted migrations. Unit suites cover bindings, dialect lifecycle, native SQL compilation, schema helper behavior, migration storage, and error conversion. Their presence is not a claim that a particular release or environment has passed them.

Run against a dedicated local database:

```sh
docker compose up -d --wait
npx --yes corepack yarn build
npx --yes corepack yarn format:check
npx --yes corepack yarn lint
npx --yes corepack yarn test
YDB_INTEGRATION=1 YDB_ENDPOINT=grpc://localhost:2136 YDB_DATABASE=/local \
  npx --yes corepack yarn test
```

The compose file pins the real local YDB image and digest. On Apple Silicon, enable the x86-64 emulation required by the YDB image. Unit runs without `YDB_INTEGRATION=1` skip the real-database suites and cannot demonstrate engine compatibility. Record actual commands, image digest, package versions, source commit, and results for each released SQL build. Stop the local service with `docker compose down` when finished.
