# Verification record

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
