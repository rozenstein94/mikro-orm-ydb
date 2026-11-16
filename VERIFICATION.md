# Verification record

## Unreleased correctness patch

The source patch branch contains correctness work that is separate from the immutable `v0.3.0` tag and npm tarball. The release and registry checks below establish the published artifact's behavior; they do not imply that these later fixes are available from `@rozenshtein94/mikro-orm-ydb@0.3.0`.

The new regression fixtures cover joined default nullable soft-delete filters and parameterized target filters, comparing joined and select-in loading while retaining parents with no visible children. They also exercise partial projections ordered by omitted values, with shuffled primary keys and sort values, repeated reads, pagination, and subquery projection arity. The implementations act on structured MikroORM join state or Kysely operation nodes before SQL rendering; raw application SQL is not parsed and rewritten.

Only qualified predicates local to a physical `INNER`/`LEFT JOIN` target can be pushed into its filtered source. Unsupported raw, subquery, cross-source, and filtered `RIGHT`/`FULL` predicates are rejected rather than moved to an outer `WHERE`. The local scenarios use owned, uniquely named tables on an existing YDB instance; they do not establish cloud-only behavior or a new registry release.

The complete source suite passed **313/313 tests in 23 files, with no skipped tests**, against actual local YDB, using published MikroORM core/SQL/migrations **7.2.9** and one **Kysely 0.29.8** runtime. This includes nullable Date/UoW, shared-FK root/joined/dotted select-in projections, 11 filtered-join integration scenarios, 20 Kysely AST checks, 16 ORM composition checks, and 12 ordered-projection checks. The Decimal ordering fixture uses an explicit test extension and lossless Int128 decoding; it does not enable Decimal in the default platform.

The following checks passed:

```sh
npx --yes corepack yarn format:check
npx --yes corepack yarn build
./node_modules/.bin/tsc --noEmit -p tsconfig.json
npx --yes corepack yarn lint
YDB_INTEGRATION=1 YDB_ENDPOINT=grpc://127.0.0.1:2136 YDB_DATABASE=/local npx --yes corepack yarn test
```

Eagerly embedding a filtered ORM QueryBuilder or its native/raw form is explicitly rejected before execution; ordinary unfiltered subqueries remain supported. Internal pagination/count clones share declarations with their owning statement. The late STI discriminator fixture creates entities through the Unit of Work; it does not prove native subclass `insertMany` without an explicit discriminator.

## 0.3.0 release and registry verification

Version **0.3.0** is published as npm `latest`. The immutable release source is commit `c7ec4a8deec56bca8d74ff87efdb87a9d868fa3d`, tagged `v0.3.0`. It uses published MikroORM core/SQL/migrations **7.2.9** and one shared **Kysely 0.29.8** runtime. The [release-source Node 22/24/26 CI](https://github.com/rozenstein94/mikro-orm-ydb/actions/runs/43871465441) is green: every matrix job passes formatting, build, lint/typecheck, **237/237 tests in 16 files with no skipped tests**, and the three packed-consumer smoke checks against actual local YDB.

A fresh consumer installed **0.3.0 directly from the npm registry**, together with the exact matching MikroORM peers and Kysely version. Its lockfile resolves the driver to `https://registry.npmjs.org/@rozenshtein94/mikro-orm-ydb/-/mikro-orm-ydb-0.3.0.tgz`, and dependency inspection confirms one shared core and Kysely. The core, SQL, and extension smoke scripts all pass against actual local YDB. The TypeScript composition example from `EXTENDING.md` also compiles against the installed declarations; both legacy and new package-root exports are present.

The registry-consumer check installs the registry version rather than a local archive:

```sh
npm install --prefix /tmp/ydb-registry-consumer --ignore-scripts --save-exact \
  @mikro-orm/core@7.2.9 @mikro-orm/sql@7.2.9 @mikro-orm/migrations@7.2.9 kysely@0.29.8 \
  @rozenshtein94/mikro-orm-ydb@0.3.0
npm ls --prefix /tmp/ydb-registry-consumer \
  @mikro-orm/core @mikro-orm/sql @mikro-orm/migrations kysely --all
cp scripts/smoke.mjs scripts/sql-smoke.mjs scripts/extensions-smoke.mjs /tmp/ydb-registry-consumer/
cd /tmp/ydb-registry-consumer
YDB_ENDPOINT=grpc://127.0.0.1:2136 YDB_DATABASE=/local node smoke.mjs
YDB_ENDPOINT=grpc://127.0.0.1:2136 YDB_DATABASE=/local node sql-smoke.mjs
YDB_ENDPOINT=grpc://127.0.0.1:2136 YDB_DATABASE=/local node extensions-smoke.mjs
```

The downloaded registry tarball and the uploaded GitHub release artifact are byte-identical. Their SHA256 and npm integrity are:

```text
SHA256: 9d5fb71d89ad42b8869ccb01e15a6f835c63e1f6c020ca10a122ff4fc1084b89
integrity: sha512-ahtwft9aJ852725msmRgCsJXlj2qxVSKYGElhmqakHEec1mIto16HCOPBwOCJreYVcmjSg6V6VdRGak6sPo/GA==
```

The earlier release-preparation baseline `be193c34ac4a932c7815f9ea9180f953ed3dd50e` separately passed the complete **237/237** local suite, formatting, build, and type-aware lint/typecheck. Its [Node 22/24/26 CI](https://github.com/rozenstein94/mikro-orm-ydb/actions/runs/43869268593) also passed all tests and core/SQL/extension packed-consumer checks. The historical 235-test candidate SHAs, source-archive hash, canary results, and immutable 0.2.0 archive below remain separate evidence.

Decimal remains outside the default platform's feature policy; the physical Decimal coverage uses the public extension API. Dynamic discovery still requires explicit platform validation before schema/write operations. The migration lock policy still releases the lock after a caught migration error and does not make DDL/history atomic. Native YQL/Table API evidence does not establish PostgreSQL wire compatibility, MikroORM v6 support, cloud IAM/TLS, managed Serverless behavior, or application-specific portability.

## Original core-driver validation

Validated locally on 2026-11-16 with Node.js 26.8.1, Yarn 4.18.1, and the official `ydbplatform/local-ydb:26.3.1.25` container running a real single-node YDB database at `/local`. The container uses the checked-in Compose configuration and in-memory storage.

```sh
npx --yes corepack yarn install --immutable
npx --yes corepack yarn format:check
npx --yes corepack yarn build
npx --yes corepack yarn lint
YDB_INTEGRATION=1 npx --yes corepack yarn test
```

The build, formatting and lint/typecheck pass. The complete driver suite passes **74 tests in 5 files, with no skipped tests**: 21 real-database scenarios and 53 complementary contract, metadata, compiler, schema-planning and connection tests. The real tests cover create/introspect/alter/drop, schema no-op diff, CRUD/change tracking/identity mapping, JSON primitives and binary/64-bit/date values, scalar/logical filters, projections and pagination, many-to-one/one-to-many relations, scalar/composite keys, exact affected counts, explicit/callback transactions, rollback, serializable conflicts and explicit retry, transaction events, duplicate-key conversion, reuse and close/reopen.

The same complete suite also passes **74/74** when the installed core is temporarily replaced with the built core from upstream MikroORM `master` commit `d8a2ba8a13c5d16eab947f26580031f403c50087`. The normal install uses published core 7.2.9, not a private core patch.

An isolated source build against published core **6.6.14** fails on the expected major-version contract differences. This confirms that a separate backport is required; it is not a runtime compatibility claim for v6.

The archive is built with `yarn pack` and checked from a separate consumer directory using `scripts/smoke.mjs`. This exercises the compiled package's public imports, schema creation/diff/drop, persistence, Identity Map, JSON string preservation and rollback against real YDB. CI runs build, formatting, lint, the full live suite and this archive smoke check on Node.js 22, 24 and 26.

The upstream documentation contribution was also checked with the MikroORM monorepo's build, formatter/check, lint/typecheck, CLI help (with its workspace TS loader), and Docusaurus build. The full upstream baseline was executed: 4,475 tests passed, 576 failed and 3,611 skipped (647 failed/937 passed test files). External SQL services were absent in that baseline; that run is **not a green full regression result**. The driver introduces no changes to MikroORM's package sources or existing database suites.

Local tests do not establish managed Serverless IAM/TLS, credential refresh, scale-to-zero latency, resource limits, failover or multi-node behavior. No paid cloud resources, secrets or production data are involved. The implementation is a third-party driver with the explicitly documented feature boundary, not a complete first-party SQL dialect.

## Publication follow-up

Version 0.1.1 changes the core peer to `^7.2.9`, while the development dependency remains pinned to 7.2.9 to test the lower bound. Build, formatting, lint/typecheck and all 74 tests passed again after this packaging change. A separate consumer installed the new archive together with `@mikro-orm/core@^7.2.9`; npm resolved one deduplicated core 7.2.9, and the real-YDB archive smoke check passed. At this check, 7.2.9 is also the newest stable version in the range; future unreleased versions are not claimed as tested.

`npm pack` runs the new `prepack` build hook and includes the compiled JavaScript and declarations. `npm publish --dry-run --access public` succeeds; a dry run does not publish the package. The npm package uses the authenticated publisher's scope, `@rozenshtein94/mikro-orm-ydb`.


## SQL driver 0.2.0

The SQL implementation uses published `@mikro-orm/core`, `@mikro-orm/sql` and `@mikro-orm/migrations` **7.2.9**, with one shared **Kysely 0.29.8** runtime. Local tests use the digest-pinned YDB **26.3.1.25** container from `compose.yaml`; no cloud resources or production data are used.

```sh
npx --yes corepack yarn install --immutable
npx --yes corepack yarn format
npx --yes corepack yarn build
npx --yes corepack yarn lint
YDB_INTEGRATION=1 npx --yes corepack yarn test
```

All checks pass. The complete suite passes **207/207 tests in 14 files, with no skipped tests**. It includes the original core-driver coverage and real SQL-driver QueryBuilder joins/subqueries/aggregates/pagination, joined relations, M:N pivot mutations and cleanup, 1:1 unique indexes, composite-key relations, custom mapped types, optimistic locking, STI, Serial keys, ORM upsert/upsertMany partial merge/ignore/identity mapping, schema creation/introspection/reversible nullable changes, generated migrations/up/down/history, concurrent and failed migrations, and direct Kysely CRUD/CTEs/transactions. Additional tests prove lossless integer/date/binary/JSON parameters, aborted-query behavior and session cleanup after rejected concurrent transaction control with a one-session pool. The independent review's transaction-ownership finding was reproduced before its fix and rechecked afterward.

A separate clean consumer installs the built 0.2.0 archive with all matching MikroORM peers and explicit Kysely 0.29.8, then runs both public-package smoke scripts against actual YDB:

```sh
npm install --prefix /tmp/ydb-consumer --ignore-scripts \
  @mikro-orm/core@7.2.9 @mikro-orm/sql@7.2.9 @mikro-orm/migrations@7.2.9 kysely@0.29.8 \
  /path/to/rozenshtein94-mikro-orm-ydb-0.2.0.tgz
cp scripts/smoke.mjs scripts/sql-smoke.mjs /tmp/ydb-consumer/
node /tmp/ydb-consumer/smoke.mjs
node /tmp/ydb-consumer/sql-smoke.mjs
```

Both smoke checks pass. The SQL check covers the compiled package exports, actual persistence, joined/M:N loading, Identity Map, JSON string preservation, millisecond timestamps and exact Int64 values, SQL QueryBuilder/count, rollback, schema no-op diff and clearing/dropping its own tables.

The source also builds, passes lint/typecheck and passes **207/207** tests against physical copies of the built upstream core/SQL/migrations from `d8a2ba8a13c5d16eab947f26580031f403c50087` (the runtime code is unchanged through the documentation PR head `729083904d52e222f181d043f6acd498989a00c0`). That upstream SQL build requires **Kysely 0.29.9**, so this separate canary explicitly aligns its Kysely resolution to 0.29.9. It is not a claim that the two Kysely versions can coexist: mixing root 0.29.8 with SQL's nested 0.29.9 fails TypeScript nominal contracts. Kysely is therefore a peer, and the SQL driver rejects mismatched runtime identities before connecting. The clean consumer and CI explicitly install the version required by their actual SQL package and deduplicate the tree.

MikroORM **6.6.14 is not supported** by this release; its separate SQL/core backport is tracked in [issue #1](https://github.com/rozenstein94/mikro-orm-ydb/issues/1). Live Yandex Cloud IAM/TLS, suspended Serverless cold starts, quotas and cloud failover remain outside this local evidence. Engine limitations and nontransactional DDL recovery are documented in `SQL.md`.


### npm registry verification

Version **0.2.0** is published as the npm `latest` release. A new consumer installed it directly from the registry with MikroORM core/SQL/migrations 7.2.9 and Kysely 0.29.8. The lockfile resolves the driver to `https://registry.npmjs.org/@rozenshtein94/mikro-orm-ydb/-/mikro-orm-ydb-0.2.0.tgz`; `npm ls` shows one shared core and Kysely. Both `smoke.mjs` and `sql-smoke.mjs` pass against actual local YDB.

The release source is `615d5ea3d84ead938bd563961ba86b15063c1c26` (tag `v0.2.0`). The registry integrity exactly matches the validated GitHub release archive:

```text
sha512-TTAiEOw0Vnpt2Bba1Wh8/x1aayjHnvPPDIddPbvI1IyzFFR6KdpSxY9daaU8XF8660dv30FrmR2SdSwM6WY7lQ==
```

[Node 22/24/26 CI](https://github.com/rozenstein94/mikro-orm-ydb/actions/runs/43858535575) passes build, formatting, lint/typecheck, all 207 tests and the packed-consumer checks. Later installation-documentation commits do not change the immutable 0.2.0 source tag or registry archive.

## Historical public extension API source candidate (0.3.0)

The source candidate adds optional `YdbSqlDriverComponents`, public registered-metadata lookup, a protected column-type validator, public schema helper/query builder/value-factory exports, and native parameter-declaration/result-decoding hooks. Published 0.2.0 remains unchanged and does not contain this API. Dependency versions and the strict default feature policy are unchanged.

Validation against the pinned MikroORM 7.2.9 / shared Kysely 0.29.8 baseline:

```sh
npx --yes corepack yarn format
npx --yes corepack yarn build
npx --yes corepack yarn lint
YDB_INTEGRATION=1 npx --yes corepack yarn test
```

All checks pass. The complete suite passes **235/235 tests in 16 files, with no skipped tests**. The 28 added cases cover public component composition, live metadata registration independent of a custom validator, renamed/composite/STI keys, native connection replacement, and a strict extension storing physical Decimal values through the original compiler and lifecycle. The Decimal fixture verifies exact signed Int128 encoding, null handling, schema introspection/diff/application, Unit of Work and Identity Map, batch operations, filters/order/pagination and rollback against actual local YDB. It does not enable Decimal in the default driver.

`orm.discoverEntity()` requires an explicit platform validation step before dynamic schema operations or writes, as documented in [EXTENDING.md](EXTENDING.md). Migration lock/error policy is unchanged. This source-candidate evidence does not claim npm publication, Node-matrix CI completion, cloud authentication or compatibility with MikroORM 6.6.14.

### Immutable extension candidate evidence

The initial extension API candidate is commit `abf618566cb3cac02632618567b558b4ff92adc2`, on `feat/sql-driver-extensions`. Its [Node 22/24/26 CI](https://github.com/rozenstein94/mikro-orm-ydb/actions/runs/43868397324) passes every build, formatting, lint/typecheck, 235-test and core/SQL packed-consumer step. An independently downloaded GitHub source archive matches all 48 tracked Git blobs. Its downloaded source-archive SHA256 is `ff04d017ece223a537a79bcbfbf9a2c7c5c2b0bb1d3eab5f1c00fa0bc14e7e9f`; this identifies that source download, not an npm registry artifact.

Building and packing that exact source produces a separate 0.3.0 candidate archive. A clean consumer with exact 7.2.9 MikroORM peers and one Kysely 0.29.8 passes the public extension smoke: installed root exports, injected platform/SQL/native classes, physical renamed composite keys, CRUD/filter/rollback, live codec hooks, and replacement transport with metadata/platform reattached. The TypeScript composition example from `EXTENDING.md` compiles against the installed declarations. This is a locally packed source candidate; it does not claim registry publication.

A separate physical-copy canary of the built upstream core/SQL/migrations runtime also passes build, type-aware lint/typecheck, and **235/235 tests** for exactly `abf6185`, using one Kysely 0.29.9 as required by that SQL build. All 253 core, 113 SQL, and 19 migrations runtime/declaration/manifest files match the upstream build. The runtime is unchanged between upstream `d8a2ba8a13c5d16eab947f26580031f403c50087` and `3b7d726541dfcf0b12a5679ccaf04caae486b2d2`. This canary does not permit mixing Kysely 0.29.8 with 0.29.9 in one application.

A subsequent regression adds physical `Decimal(35,18)` through the same API without implementation changes. Its exact adjacent values `90071992547409931.123456789012345678` and `90071992547409931.123456789012345679` survive managed and native batch writes, hydration, numeric comparison/order, and a last-digit update. Schema introspection and no-op diff preserve `(35,18)`, and codec checks cover ±10⁻¹⁸, precision limits, overflow, and excess scale. The targeted extension file passes **15/15** tests (7 live cases and 8 codec cases). After this regression, the complete local suite passes **237/237 tests in 16 files, with no skipped tests**, together with format, build, and lint/typecheck. `scripts/extensions-smoke.mjs` also runs in every matrix job against the installed built archive.
