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

An isolated source build against published core **6.6.14** fails on the expected major-version contract differences. This confirms that a separate backport is required; it is not a runtime compatibility claim for v6. No Medusa application was installed or executed.

The archive is built with `yarn pack` and checked from a separate consumer directory using `scripts/smoke.mjs`. This exercises the compiled package's public imports, schema creation/diff/drop, persistence, Identity Map, JSON string preservation and rollback against real YDB. CI runs build, formatting, lint, the full live suite and this archive smoke check on Node.js 22, 24 and 26.

The upstream documentation contribution was also checked with the MikroORM monorepo's build, formatter/check, lint/typecheck, CLI help (with its workspace TS loader), and Docusaurus build. The full upstream baseline was executed: 4,475 tests passed, 576 failed and 3,611 skipped (647 failed/937 passed test files). External SQL services were absent in that baseline; that run is **not a green full regression result**. The driver introduces no changes to MikroORM's package sources or existing database suites.

Local tests do not establish managed Serverless IAM/TLS, credential refresh, scale-to-zero latency, resource limits, failover or multi-node behavior. No paid cloud resources, secrets or production data are involved. The implementation is a third-party driver with the explicitly documented feature boundary, not a complete first-party SQL dialect.

## Publication follow-up

Version 0.1.1 changes the core peer to `^7.2.9`, while the development dependency remains pinned to 7.2.9 to test the lower bound. Build, formatting, lint/typecheck and all 74 tests passed again after this packaging change. A separate consumer installed the new archive together with `@mikro-orm/core@^7.2.9`; npm resolved one deduplicated core 7.2.9, and the real-YDB archive smoke check passed. At this check, 7.2.9 is also the newest stable version in the range; future unreleased versions are not claimed as tested.

`npm pack` runs the new `prepack` build hook and includes the compiled JavaScript and declarations. `npm publish --dry-run --access public` succeeds. Registry publication still requires an authenticated npm account with rights to the package scope; a dry run does not publish the package. The existing GitHub v0.1.0 tag and archive remain unchanged.
