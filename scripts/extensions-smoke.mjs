// Copy this script into an isolated npm consumer after installing the packed driver archive.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import {
  createYdbValue,
  YdbConnection,
  YdbNativeQueryBuilder,
  YdbSchemaHelper,
  YdbSqlConnection,
  YdbSqlDriver,
  YdbSqlPlatform,
} from '@rozenshtein94/mikro-orm-ydb';

// Refuse an accidental source-tree run: the proof must exercise the installed public exports.
const consumerDirectory = realpathSync(process.cwd());
const packageDirectory = realpathSync(path.join(consumerDirectory, 'node_modules', '@rozenshtein94', 'mikro-orm-ydb'));
const packageEntry = realpathSync(fileURLToPath(import.meta.resolve('@rozenshtein94/mikro-orm-ydb')));
assert.equal(
  packageEntry,
  path.join(packageDirectory, 'dist', 'index.js'),
  'Copy this script into the isolated npm consumer so imports resolve to its installed archive.',
);
const packageInfo = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
assert.equal(packageInfo.name, '@rozenshtein94/mikro-orm-ydb');

const endpoint = process.env.YDB_ENDPOINT ?? 'grpc://localhost:2136';
assert.ok(
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(endpoint).hostname),
  'This smoke test is restricted to an existing local YDB endpoint.',
);
const prefix = `ydb_ext_pack_${process.pid}_${randomUUID().replaceAll('-', '')}`;
const tableName = `${prefix}_record`;
const unrelatedTables = new RegExp(`^(?!${prefix}_).*`);
assert.ok(unrelatedTables.test('unrelated_table'));
assert.equal(unrelatedTables.test(tableName), false);

const nativeConnections = [];

class ApplicationPlatform extends YdbSqlPlatform {
  parameterCalls = 0;

  createParameterValue(value, declaration) {
    this.parameterCalls++;
    return super.createParameterValue(value, declaration);
  }
}

class ApplicationNativeConnection extends YdbConnection {
  declarationCalls = 0;
  decoderCalls = 0;

  constructor(...args) {
    super(...args);
    nativeConnections.push(this);
  }

  getParameterTypeDeclaration(value) {
    this.declarationCalls++;
    return super.getParameterTypeDeclaration(value);
  }

  decodeResultValue(value, type) {
    this.decoderCalls++;
    return super.decodeResultValue(value, type);
  }

  get attachedMetadata() {
    return this.metadata;
  }

  get attachedPlatform() {
    return this.platform;
  }
}

class ApplicationConnection extends YdbSqlConnection {
  createNativeConnection() {
    return new ApplicationNativeConnection(this.config, this.options, this.type);
  }
}

class ApplicationDriver extends YdbSqlDriver {
  constructor(config) {
    super(config, { platform: new ApplicationPlatform(), connection: ApplicationConnection });
  }
}

class PackedExtensionRecord {}

const recordSchema = new EntitySchema({
  class: PackedExtensionRecord,
  tableName,
  properties: {
    tenant: { type: 'string', primary: true, fieldName: 'tenant_key' },
    id: { type: 'string', primary: true, fieldName: 'record_key' },
    label: { type: 'string', fieldName: 'display_label' },
    score: { type: 'integer' },
    optional: { type: 'string', nullable: true },
  },
});

let orm;
let failure;
let result;
try {
  assert.equal(typeof YdbNativeQueryBuilder, 'function');
  assert.equal(typeof YdbSchemaHelper, 'function');
  const explicitValue = createYdbValue('archive binding', 'Utf8');
  assert.equal(createYdbValue(explicitValue, 'Utf8'), explicitValue);
  assert.throws(() => createYdbValue(2 ** 31, 'Int32'), /out of range/);

  orm = await MikroORM.init({
    driver: ApplicationDriver,
    entities: [recordSchema],
    clientUrl: endpoint,
    dbName: process.env.YDB_DATABASE ?? '/local',
    schemaGenerator: { skipTables: [unrelatedTables] },
  });

  const platform = orm.driver.getPlatform();
  const connection = orm.driver.getConnection();
  const initialNative = connection.getYdbConnection();
  assert.ok(platform instanceof ApplicationPlatform);
  assert.ok(connection instanceof ApplicationConnection);
  assert.ok(initialNative instanceof ApplicationNativeConnection);
  assert.equal(connection.getYdbConnection(), initialNative);
  assert.equal(initialNative.attachedMetadata, orm.getMetadata());
  assert.equal(initialNative.attachedPlatform, platform);
  assert.ok(platform.getSchemaHelper() instanceof YdbSchemaHelper);
  assert.ok(platform.createNativeQueryBuilder() instanceof YdbNativeQueryBuilder);
  assert.equal(platform.getTableMetadata(tableName), orm.getMetadata(PackedExtensionRecord));
  assert.deepEqual(platform.getPrimaryKeyColumns(tableName), ['tenant_key', 'record_key']);
  assert.equal(platform.getColumnType(tableName, 'display_label'), 'Utf8');
  assert.equal(platform.getColumnType(tableName, 'score'), 'Int32');
  assert.equal(platform.getColumnType(tableName, 'optional'), 'Utf8?');

  await orm.schema.create();
  assert.equal(await orm.schema.getUpdateSchemaSQL({ safe: true, dropTables: false }), '');
  const em = orm.em.fork();
  const first = em.create(PackedExtensionRecord, {
    tenant: 'smoke',
    id: 'first',
    label: 'Packed first',
    score: 1,
    optional: null,
  });
  const second = em.create(PackedExtensionRecord, {
    tenant: 'smoke',
    id: 'second',
    label: 'Packed second',
    score: 2,
    optional: 'present',
  });
  await em.persist([first, second]).flush();
  assert.equal(await em.findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'first' }), first);
  em.clear();
  const filtered = await em.find(
    PackedExtensionRecord,
    { tenant: 'smoke', score: { $gte: 2 }, label: { $like: 'Packed%' } },
    { orderBy: { score: 'desc' }, limit: 1 },
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'second');
  assert.equal(filtered[0].optional, 'present');
  const loaded = await em.findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'first' });
  assert.equal(loaded.optional, null);
  loaded.label = 'Committed update';
  await em.flush();

  const rollback = new Error('packed extension rollback');
  await assert.rejects(
    orm.em.fork().transactional(async transaction => {
      const record = await transaction.findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'first' });
      record.label = 'Rolled back update';
      await transaction.flush();
      throw rollback;
    }),
    error => error === rollback,
  );
  const verify = orm.em.fork();
  assert.equal(
    (await verify.findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'first' })).label,
    'Committed update',
  );
  const removed = await verify.findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'second' });
  await verify.remove(removed).flush();
  assert.equal(await verify.count(PackedExtensionRecord, { tenant: 'smoke' }), 1);
  assert.ok(platform.parameterCalls > 0, 'The injected platform binding hook must run during persistence.');
  assert.ok(
    initialNative.declarationCalls > 0,
    'The injected native declaration hook must process actual RPC parameters.',
  );
  assert.ok(initialNative.decoderCalls > 0, 'The injected native decoder hook must process actual result values.');

  // This ORM owns its clients. Reconnect replaces only those clients, leaving the shared YDB service running.
  await orm.driver.reconnect({ skipOnConnect: true });
  const replacement = connection.getYdbConnection();
  assert.ok(replacement instanceof ApplicationNativeConnection);
  assert.notEqual(replacement, initialNative);
  assert.equal(connection.getYdbConnection(), replacement);
  assert.equal(replacement.attachedMetadata, orm.getMetadata());
  assert.equal(replacement.attachedPlatform, platform);
  assert.equal(
    (await orm.em.fork().findOneOrFail(PackedExtensionRecord, { tenant: 'smoke', id: 'first' })).label,
    'Committed update',
  );
  assert.ok(replacement.declarationCalls > 0);
  assert.ok(replacement.decoderCalls > 0);
  result = {
    package: packageInfo.name,
    version: packageInfo.version,
    status: 'passed',
    platformBindings: platform.parameterCalls,
    nativeInstances: nativeConnections.length,
    parameterDeclarations: nativeConnections.reduce((sum, native) => sum + native.declarationCalls, 0),
    decodedValues: nativeConnections.reduce((sum, native) => sum + native.decoderCalls, 0),
  };
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  if (orm) {
    try {
      // The schema contains exactly our unique table and excludes every unrelated table.
      await orm.schema.drop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await orm.close(true);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failure || cleanupErrors.length) {
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Packed extension smoke failed.');
  }
}

console.log(JSON.stringify(result));
