# MikroORM YDB driver

Native YQL drivers for MikroORM and YDB, using the official JavaScript SDK's Table API.

The **0.2.0 SQL implementation** adds `YdbSqlDriver` on `@mikro-orm/sql` and a YDB Kysely dialect. It provides SQL QueryBuilder, joined loading, 1:1 and M:N relations, the standard SQL schema generator with a YDB schema helper, and `YdbMigrator` integration. Read [the SQL driver guide](https://github.com/rozenstein94/mikro-orm-ydb/blob/v0.2.0/SQL.md) for setup, supported features, engine limitations and migration configuration. Version **0.1.1** is the earlier core-only driver; use **0.2.0** for the SQL implementation.

`YdbDriver` retains the core `DatabaseDriver` API described below. Its supported feature set is narrower than `YdbSqlDriver`. Both use MikroORM's EntityManager, Unit of Work and Identity Map. The package targets **MikroORM `^7.2.9`** and **Node.js 22.17 or newer**; all MikroORM packages in an application must use matching versions. Tests pin 7.2.9 as the floor, and the packaged consumer checks the newest stable version in range. This is an independent community package. It uses native YDB, with no Document API or AWS DynamoDB compatibility claim.

Source: [rozenstein94/mikro-orm-ydb](https://github.com/rozenstein94/mikro-orm-ydb). Related upstream discussions: [#5770](https://github.com/mikro-orm/mikro-orm/discussions/5770) and [#8736](https://github.com/mikro-orm/mikro-orm/discussions/8736).

## Core driver installation

Install the [public npm package](https://www.npmjs.com/package/@rozenshtein94/mikro-orm-ydb) and a compatible MikroORM core:

```sh
npm install '@mikro-orm/core@^7.2.9' @rozenshtein94/mikro-orm-ydb@0.1.1
```

Build the SQL implementation from its feature branch as described in [SQL.md](https://github.com/rozenstein94/mikro-orm-ydb/blob/v0.2.0/SQL.md). To build the current source package:

```sh
git clone --branch feat/sql-driver-v7 https://github.com/rozenstein94/mikro-orm-ydb.git
cd mikro-orm-ydb
npx --yes corepack yarn install --immutable
npx --yes corepack yarn build
npx --yes corepack yarn pack --out mikro-orm-ydb-0.2.0.tgz
```

From the consuming application's directory, install the packed artifact and a compatible MikroORM peer:

```sh
npm install @mikro-orm/core@7.2.9 @mikro-orm/sql@7.2.9 @mikro-orm/migrations@7.2.9 kysely@0.29.8 \
  /absolute/path/to/mikro-orm-ydb/mikro-orm-ydb-0.2.0.tgz
```

The package exports ESM and TypeScript declarations. Its `prepack` hook builds `dist/` before creating an archive. Commit the resulting application lockfile when building deployment artifacts.

## Core driver connection and entities

The local example needs no credentials. It connects to an existing database; it does not provision one.

```ts
import { randomUUID } from 'node:crypto';
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { YdbDriver } from '@rozenshtein94/mikro-orm-ydb';

class Note {
  id!: string;
  title!: string;
  complete!: boolean;
  createdAt!: Date;
  details?: string | null;
}

const NoteSchema = new EntitySchema<Note>({
  class: Note,
  tableName: 'note',
  properties: {
    id: { type: 'string', primary: true },
    title: { type: 'string' },
    complete: { type: 'boolean' },
    createdAt: { type: 'Date' },
    details: { type: 'string', nullable: true },
  },
});

const orm = await MikroORM.init<YdbDriver>({
  driver: YdbDriver,
  entities: [NoteSchema],
  clientUrl: 'grpc://localhost:2136',
  dbName: '/local',
  pool: { max: 10 },
  driverOptions: {
    connectTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
  },
});

// Development setup: run once against an empty, disposable database.
await orm.schema.create();

const em = orm.em.fork();
const note = em.create(Note, {
  id: randomUUID(),
  title: 'Try native YDB',
  complete: false,
  createdAt: new Date(),
  details: null,
});
await em.persist(note).flush();

const loaded = await em.findOneOrFail(Note, note.id);
console.assert(loaded === note); // The same EntityManager's Identity Map.
loaded.complete = true;
await em.flush();

const page = await em.find(Note, { complete: true }, {
  orderBy: { createdAt: 'desc', id: 'asc' },
  limit: 20,
  offset: 0,
});

await em.remove(loaded).flush();
await orm.close(); // At application shutdown, after in-flight work has settled.
```

Supply every non-nullable stored value on insert, either directly or through an application-side default/hook. Primary keys are application assigned. Numeric primary keys must set `autoincrement: false`. Database expressions, sequences, and generated defaults are outside this driver's support.

Table and column names must match `[A-Za-z_][A-Za-z0-9_]*`. Use `fieldName` to map an application property to a different simple column name. SQL schemas and qualified table names are rejected.

## YDB Serverless connection and authentication

Use the native YDB endpoint and database path from an **existing** database. In the Yandex Cloud console, an endpoint may be shown as `grpcs://HOST:2135/?database=/ru-central1/FOLDER/DATABASE`. Set `clientUrl` to the portion before `/?database=` and set `dbName` to the absolute database path after it. Do not use the HTTPS Document API endpoint. See [Yandex Cloud's connection instructions](https://yandex.cloud/en/docs/ydb/operations/connection).

For example, these environment variables contain configuration, not credentials:

```sh
YDB_ENDPOINT=grpcs://ydb.serverless.yandexcloud.net:2135
YDB_DATABASE=/ru-central1/your-folder-id/your-database-id
```

Install the official authentication package if the application imports a provider:

```sh
npm install @ydbjs/auth@6.3.1
```

On a Yandex Cloud runtime with a suitable service account attached and access to its metadata service, pass the provider explicitly:

```ts
import { MetadataCredentialsProvider } from '@ydbjs/auth/metadata';

const orm = await MikroORM.init<YdbDriver>({
  driver: YdbDriver,
  entities: [NoteSchema],
  clientUrl: process.env.YDB_ENDPOINT!,
  dbName: process.env.YDB_DATABASE!,
  pool: { max: 5 },
  driverOptions: {
    connectTimeoutMs: 30_000,
    queryTimeoutMs: 30_000,
    driverConfig: {
      credentialsProvider: new MetadataCredentialsProvider(),
    },
  },
});
```

The SDK provider obtains and caches the metadata token. Grant the service account the database permissions required by your application and perform DDL through a separately controlled setup or deployment step. The [Yandex Cloud Functions connection tutorial](https://yandex.cloud/en/docs/tutorials/serverless/connect-from-cf-nodejs) describes the runtime and service account setup; its older SDK example is not the API used by this package.

For a development process with an externally supplied short-lived IAM token, the pinned SDK supports:

```ts
import { AccessTokenCredentialsProvider } from '@ydbjs/auth/access-token';

const credentialsProvider = new AccessTokenCredentialsProvider({
  token: process.env.YDB_ACCESS_TOKEN_CREDENTIALS!,
});
// Pass as driverOptions.driverConfig.credentialsProvider.
```

This provider uses the supplied token as-is; it does not refresh it. Keep tokens out of source files, command-line arguments, query strings, and logs. Choose a refreshing provider for long-running processes.

`driverConfig` accepts the official SDK's `DriverOptions`, including `credentialsProvider`, TLS `secureOptions`, discovery settings, and channel options. `grpcs://` enables TLS. If a private certificate authority is required, supply its CA through `driverConfig.secureOptions.ca` without disabling certificate verification. Refer to the [published SDK authentication package](https://www.npmjs.com/package/@ydbjs/auth/v/6.3.1) for the exact APIs of the pinned SDK.

Authentication is explicit: an omitted provider uses anonymous authentication. The driver does not automatically interpret credential environment variables. If using `EnvironCredentialsProvider` from `@ydbjs/auth/environ`, instantiate and pass it yourself, together with its `secureOptions`. The published 6.3.1 provider supports anonymous, metadata, access-token, and static credentials; do not infer key-file behavior or fallback authentication from examples for other SDK versions.

### Reuse in serverless processes

Initialize one ORM per warm process and fork the EntityManager for each invocation. Cache the initialization promise so simultaneous first requests share initialization, and clear it if initialization fails:

```ts
let ormPromise: Promise<MikroORM<YdbDriver>> | undefined;

function getOrm() {
  return ormPromise ??= MikroORM.init<YdbDriver>({
    driver: YdbDriver,
    entities: [NoteSchema],
    clientUrl: process.env.YDB_ENDPOINT!,
    dbName: process.env.YDB_DATABASE!,
    pool: { max: 5 },
    driverOptions: {
      connectTimeoutMs: 30_000,
      queryTimeoutMs: 30_000,
      driverConfig: { credentialsProvider: new MetadataCredentialsProvider() },
    },
  }).catch(error => {
    ormPromise = undefined;
    throw error;
  });
}

export async function handler() {
  const orm = await getOrm();
  const em = orm.em.fork();
  return em.find(Note, { complete: false }, {
    orderBy: { id: 'asc' },
    limit: 20,
  });
}
```

Do not create/drop schemas or close the ORM after every invocation. Close it during a supported graceful shutdown after active requests finish. The SDK owns endpoint discovery and transport reuse; this driver pools Table API sessions with `pool.max` as the upper bound. An explicitly supplied `driverOptions.driver` remains application-owned: `orm.close()` closes the driver's sessions but does not close that supplied SDK driver.

These patterns avoid repeated initialization inside a warm process. Cloud cold-start latency, freeze/thaw behavior, IAM token rotation, TLS, and Serverless resource limits still need validation in your deployment; local integration tests do not prove them.

## Supported behavior

| Area | Driver support |
| --- | --- |
| Entities | Core EntityManager/repositories, identity mapping, Unit of Work insert/update/delete, application hooks/defaults |
| Keys | Required, application-assigned scalar keys; ordered composite scalar primary keys |
| CRUD | `persist(...).flush()`, `find`, `findOne`, `count`, `insert`/`insertMany`, `nativeUpdate`, `nativeDelete`, removal through Unit of Work |
| Filters | Scalar equality, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$like` on text, `$exists`, `$and`, `$or`, `$not`, explicit null checks |
| Sorting | Scalar `ASC`/`DESC`; explicit null placement is rejected |
| Pagination | Non-negative integer `limit`/`offset`; use a deterministic order and an application key filter for subsequent keyset pages |
| Projection | Stored `fields`/`exclude`, with primary keys retained for identity mapping |
| Relations | Many-to-one and inverse one-to-many through select-in loading; to-one targets require a single scalar key |
| Transactions | Serializable read/write, explicit begin/commit/rollback, automatic flush transactions, transaction lifecycle events; `readOnly: true` selects YDB snapshot-read-only mode |
| Schema | Table create/drop/refresh/clear, live introspection, conservative diffs and generated up/down DDL |
| Connection | Bounded session pool, shared lazy initialization, timeouts/cancellation, SDK access, owned/external lifecycle |

For a relation, store the owning many-to-one scalar key in YDB and use `populate` for related entities. YDB does not enforce foreign keys. Integrity and deletion rules therefore belong to the application; MikroORM's in-memory relation behavior does not create database foreign-key constraints. Collections of composite-key entities and relations targeting composite keys are rejected.

`$in`/`$nin` with an empty array are supported. A list containing `null` is rejected; express the intended null behavior with `$or` and an explicit null comparison. Nested relation predicates, nested JSON predicates, regex/full-text/array operators, joined loading, and MikroORM cursor options (`first`, `last`, `before`, `after`) are outside this support. Query data is bound as named typed parameters. Unknown properties and unsupported operators produce errors.

Large results remain subject to YDB Table API limits. A truncated result raises an error instead of returning a silently incomplete list. Prefer bounded queries. EntityManager streaming is rejected; use pages or the native SDK when streaming is necessary.

### Types

| MikroORM declaration | YDB storage | JavaScript value |
| --- | --- | --- |
| `string`, `text`, `uuid` | `Utf8` | `string`; UUID values are stored as text |
| `integer`, `number` | `Int32` | Integer `number`, −2³¹ through 2³¹−1 |
| `bigint` | `Int64` | `bigint`, signed 64-bit range |
| `double`, `float` | `Double` | Finite `number` |
| `boolean` | `Bool` | `boolean` |
| `Date`, `datetime`, `timestamp` | `Timestamp` | `Date`; millisecond precision from JavaScript |
| `Buffer`, `blob`, `Uint8Array` | `String` | Binary bytes; query results normalized to `Buffer` |
| `json`, `object` | `JsonDocument` | JSON-serializable values |

Set `nullable: true` for optional stored fields; otherwise the schema uses `NOT NULL`. JSON is persisted as a complete document. Date values are restricted to the supported YDB `Timestamp` range checked by the driver. Decimal, arrays, native YDB UUID storage, timezone-specific temporal types, and arbitrary custom SQL types are not implemented.

### Transactions, retries, and errors

```ts
import { IsolationLevel } from '@mikro-orm/core';

await orm.em.fork().transactional(async em => {
  const note = await em.findOneOrFail(Note, noteId);
  note.complete = true;
  // Flush/commit occur through MikroORM's transaction lifecycle.
}, { isolationLevel: IsolationLevel.SERIALIZABLE });
```

A transaction pins one Table API session. Statements inside it must run sequentially. Nested transactions/savepoints, SQL session context, and other isolation-level options are rejected. When native updates/deletes need an affected-row count, the driver counts and changes the matching rows within the same serializable transaction.

Transaction completion hooks may observe the transaction, but cannot execute another query on that same session while commit or rollback is in progress. Initialize an inverse one-to-many collection before replacing it; replacing an uninitialized inverse collection is rejected. Per-parent population limits and non-primary-key relation targets are not supported. Simple scalar projections and explicitly populated lazy scalar fields are supported; nested SQL-style projections are not.

Application transaction callbacks are executed once. An `ABORTED` conflict is surfaced as MikroORM's `DeadlockException`; retry the entire operation explicitly with a fresh EntityManager/transaction only when the application operation and its external effects can safely be repeated. A standalone atomic query can retry a confirmed `ABORTED` status up to two times. Rejected expired sessions are also replaced, including before a transaction body starts. The driver does not replay a transaction callback or retry an uncertain commit/network failure as though success were known.

YDB errors are converted to MikroORM driver exceptions, including connection failures, syntax errors, missing/existing tables, duplicate keys, and constraint violations. Unsupported capabilities raise descriptive errors rather than reporting success.

## Schema changes

Inspect SQL before executing it:

```ts
const createSql = await orm.schema.getCreateSchemaSQL();
const { up, down } = await orm.schema.getUpdateSchemaMigrationSQL();
// Review and save these artifacts using your deployment process.
// Apply the reviewed generated script when appropriate:
await orm.schema.execute(up);
```

The generator reads live table definitions through `describeTable`. It creates missing mapped tables and adds nullable columns. Updates default to `safe: true`, retaining columns absent from entity metadata. To include nullable column removals, request `{ safe: false }` explicitly when generating or applying the plan.

Primary-key changes, type/nullability changes, adding or removing required columns, and tables with indexes or database defaults require an explicit migration and cause automatic diffing to fail. The complete mapped-table plan is validated before its first DDL statement, so an unsupported later table does not cause earlier statements to run.

YDB DDL is not wrapped in a data transaction: supported statements still commit independently, and a runtime failure can leave an already applied prefix. Generated down scripts restore definitions; they do **not** restore data lost by dropping a table or column. Back up and review destructive operations using your normal deployment process.

`schema.drop()` and `schema.clear()` operate on mapped tables. `dropTables: true` is rejected: the driver does not enumerate and delete unrelated tables. Database provisioning, SQL schema selection, `wrap: true`, `fromSchema`, index management, and the SQL `@mikro-orm/migrations` extension are not implemented. `schema.execute()` accepts the generator's `CREATE TABLE`, `ALTER TABLE`, and `DROP TABLE` scripts without literals or comments; use the native client for other reviewed YQL.

## Local YDB and tests

Use a dedicated local test database. The real integration suite creates tables with a per-process run prefix and drops its own mapped tables after the run.

The included `compose.yaml` pins `ydbplatform/local-ydb:26.3.1.25`, uses in-memory test storage, and publishes the native and monitoring ports on localhost:

```sh
docker compose up -d --wait
```

Wait for the container to become healthy before starting tests. The endpoint is `grpc://localhost:2136` and the database is `/local`. On Apple Silicon, use x86-64 emulation; for Colima the documented setup is `colima start --arch aarch64 --vm-type=vz --vz-rosetta`. See [YDB's Docker instructions](https://ydb.tech/docs/en/reference/docker/start) for container settings and emulator requirements.

From this driver's checkout:

```sh
npx --yes corepack yarn install --immutable
npx --yes corepack yarn build
npx --yes corepack yarn format:check
npx --yes corepack yarn lint
npx --yes corepack yarn test
YDB_INTEGRATION=1 \
  YDB_ENDPOINT=grpc://localhost:2136 \
  YDB_DATABASE=/local \
  npx --yes corepack yarn test
```

Without `YDB_INTEGRATION=1`, the real-database suite is skipped; a unit-only run is not evidence of a working database connection. The integration suite exercises live schema creation and diffing, persistence/change tracking/identity mapping, data types, filters, relations, composite keys, transaction commit/rollback/conflicts, error conversion, and closing/reopening connections. Unit tests complement the live suite for invalid metadata, query compilation, schema planning, and lifecycle failures.

The local suite does not exercise managed Serverless IAM, TLS, billing/resource limits, credential rotation, cloud discovery topology, or cold starts. No cloud credentials are required by these local tests, and no production data is used.

Stop and remove this checkout's test container when finished:

```sh
docker compose down
```

## Compatibility and boundaries

| Component | Target |
| --- | --- |
| MikroORM | Peer range `@mikro-orm/core@^7.2.9`; all MikroORM packages in an application must use compatible matching versions |
| Node.js | ESM, 22.17.0 or newer |
| YDB SDK | `@ydbjs/core@6.3.1`, `@ydbjs/api@6.0.7`, `@ydbjs/value@6.0.8`; `yarn.lock` records transitive versions |
| Local test server | `ydbplatform/local-ydb:26.3.1.25` |
| MikroORM 6.6.14 | Requires a separate backport/build and its own real-YDB validation; unsupported by this package's peer range |

Current MikroORM v7 SQL packages use Kysely; v6.6.14 used `@mikro-orm/knex`. The core-level implementation does not use either SQL API, while the new SQL implementation uses the v7 SQL contracts. Both require a separate backport because the core driver signatures and SQL APIs differ between majors. An isolated build with the published `@mikro-orm/core@6.6.14` was attempted and fails: v6 requires `Connection.getDefaultClientUrl`, lacks the v7 `onConnect` hook and `@mikro-orm/core/schema` entry point, and uses `createSchema`/`updateSchema`/`clearDatabase` generator methods. A v6 backport must adapt these interfaces, `EntityName`/string handling, EntityManager typing, driver method generic defaults, and cancellation/lifecycle APIs, then build and rerun the same database scenarios against core 6.6.14. Changing the peer range alone is not a compatibility fix.

See [VERIFICATION.md](VERIFICATION.md) for the recorded validation and its boundaries.

Applications pinned to MikroORM 6.6.14 require a separately tested backport. PostgreSQL/Knex-specific queries, migrations, services, indexes, constraints, and application assumptions need a separate audit and port.

For the core `YdbDriver`, unsupported features include SQL QueryBuilder, SQL migrations/entity generation, secondary/unique indexes, one-to-one and many-to-many relations, embedded or polymorphic entities, inheritance/views, version properties, generated columns, raw SQL expressions/defaults, autoincrement, SQL schemas, read replicas configured through MikroORM, and database provisioning. These are driver boundaries, not a claim that YDB itself lacks every listed feature.

## Contributing and license

Run the build, formatter, lint/typecheck, unit tests, and real-YDB suite before proposing driver changes. Include a regression scenario for behavior changes and document changes to the support boundary. Keep real credentials and connection data out of fixtures.

This implementation and documentation were prepared with OpenAI Codex assistance. It is distributed under the [MIT license](LICENSE). MikroORM and the official YDB SDK retain their own licenses; their source is not relicensed by this package.
