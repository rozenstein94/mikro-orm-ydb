import { EntitySchema, MikroORM, Type, type FindOptions } from '@mikro-orm/core';
import { toJs } from '@ydbjs/value';
import { YdbDriver, type YdbTransaction } from '../src/index.js';

class ContractEntity {
  id!: string;
  value!: unknown;
  secret?: string | null;
}

const schema = new EntitySchema<ContractEntity>({
  class: ContractEntity,
  tableName: 'contract_entity',
  properties: {
    id: { type: 'string', primary: true, fieldName: 'entity_id' },
    value: { type: 'json' },
    secret: { type: 'string', fieldName: 'lazy_value', lazy: true, nullable: true },
  },
});

function options(entities = [schema]) {
  return {
    driver: YdbDriver,
    entities,
    clientUrl: 'grpc://localhost:2136',
    dbName: '/local',
    allowGlobalContext: true,
  };
}

describe('MikroORM driver result and conversion contracts', () => {
  let orm: MikroORM<YdbDriver>;

  beforeEach(async () => {
    orm = await MikroORM.init<YdbDriver>(options());
  });

  afterEach(async () => {
    await orm.close(true);
    vi.restoreAllMocks();
  });

  test.each(['123', 'true', 'null', '"quoted"', { nested: ['123', 1, false] }])(
    'preserves SDK-decoded JSON value %j without parsing it a second time',
    async value => {
      vi.spyOn(orm.driver.getConnection(), 'query').mockResolvedValue([{ entity_id: 'a', value }]);

      const entity = await orm.em.findOneOrFail(ContractEntity, 'a');

      expect(entity.value).toEqual(value);
      expect(typeof entity.value).toBe(typeof value);
    },
  );

  test('returns every native insert key and encodes JSON string values as JSON strings', async () => {
    const connection = orm.driver.getConnection();
    vi.spyOn(connection, 'begin').mockResolvedValue({} as YdbTransaction);
    vi.spyOn(connection, 'commit').mockResolvedValue();
    const execute = vi.spyOn(connection, 'query').mockResolvedValue([]);

    const ids = await orm.em.insertMany(ContractEntity, [
      { id: 'a', value: '123' },
      { id: 'b', value: 'true' },
    ]);

    expect(ids).toEqual(['a', 'b']);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(toJs(execute.mock.calls[0][1]!.$p1)).toBe('123');
    expect(toJs(execute.mock.calls[1][1]!.$p1)).toBe('true');
  });

  test('rejects per-parent relation limits instead of returning an unrestricted collection', async () => {
    const execute = vi.spyOn(orm.driver.getConnection(), 'query');

    await expect(
      orm.driver.find(ContractEntity, {}, {
        _partitionLimit: { partitionBy: 'id', limit: 1 },
      } as FindOptions<ContractEntity>),
    ).rejects.toThrow(/partition|limit|unsupported|not support/i);

    expect(execute).not.toHaveBeenCalled();
  });

  test('includes a populated lazy scalar in the root SELECT', async () => {
    const execute = vi
      .spyOn(orm.driver.getConnection(), 'query')
      .mockResolvedValue([{ entity_id: 'a', value: {}, lazy_value: 'explicitly loaded' }]);

    const entity = await orm.em.findOneOrFail(ContractEntity, 'a', { populate: ['secret'] });

    expect(entity.secret).toBe('explicitly loaded');
    expect(execute.mock.calls[0][0]).toContain('`lazy_value`');
  });

  test('honors explicitly selected lazy scalars alongside a wildcard projection', async () => {
    const execute = vi
      .spyOn(orm.driver.getConnection(), 'query')
      .mockResolvedValue([{ entity_id: 'a', value: {}, lazy_value: 'explicitly selected' }]);

    await orm.em.findOneOrFail(ContractEntity, 'a', { fields: ['*', 'secret'] });

    expect(execute.mock.calls[0][0]).toContain('`lazy_value`');
  });
});

test('rejects an arbitrary custom type before unimplemented native filter conversion can corrupt its values', async () => {
  class PrefixType extends Type<string, string> {
    override convertToDatabaseValue(value: string): string {
      return `database:${value}`;
    }
    override convertToJSValue(value: string): string {
      return value.replace(/^database:/, '');
    }
    override getColumnType(): string {
      return 'Utf8';
    }
  }
  const customSchema = new EntitySchema({
    name: 'UnsupportedCustomType',
    properties: {
      id: { type: 'string', primary: true },
      value: { type: PrefixType },
    },
  });

  await expect(MikroORM.init<YdbDriver>({ ...options(), entities: [customSchema] })).rejects.toThrow(
    /custom.*type|not support.*type/i,
  );
});
