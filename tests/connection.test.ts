import { create, toBinary, type DescMessage, type MessageInitShape } from '@bufbuild/protobuf';
import {
  Configuration,
  ConnectionException,
  DatabaseObjectNotFoundException,
  DeadlockException,
  EventType,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { IssueMessageSchema, OperationSchema, StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import {
  BeginTransactionResultSchema,
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  ExecuteQueryResultSchema,
} from '@ydbjs/api/table';
import type { Driver } from '@ydbjs/core';
import { YDBError } from '@ydbjs/error';
import { Int32 } from '@ydbjs/value/primitive';
import { describe, expect, it, vi } from 'vitest';
import { YdbConnection, type YdbTransaction } from '../src/YdbConnection.js';
import { isYdbTableNotFound, YdbExceptionConverter } from '../src/YdbExceptionConverter.js';

function result<T extends DescMessage>(schema: T, value: MessageInitShape<T>) {
  return {
    operation: create(OperationSchema, {
      ready: true,
      status: Status.SUCCESS,
      result: { typeUrl: `type.googleapis.com/${schema.typeName}`, value: toBinary(schema, create(schema, value)) },
    }),
  };
}

function status(code: Status) {
  return { operation: create(OperationSchema, { ready: true, status: code }) };
}

function fixture() {
  const client = {
    createSession: vi.fn(async () =>
      result(CreateSessionResultSchema, { sessionId: 'ydb://session/3?node_id=1&id=test' }),
    ),
    deleteSession: vi.fn(async () => status(Status.SUCCESS)),
    executeDataQuery: vi.fn(async (_request: unknown) => result(ExecuteQueryResultSchema, {})),
    executeSchemeQuery: vi.fn(async () => status(Status.SUCCESS)),
    describeTable: vi.fn(async (_request: unknown) => status(Status.NOT_FOUND)),
    describePath: vi.fn(async (_request: unknown) => status(Status.NOT_FOUND)),
    beginTransaction: vi.fn(async () => result(BeginTransactionResultSchema, { txMeta: { id: 'tx1' } })),
    commitTransaction: vi.fn(async () => status(Status.SUCCESS)),
    rollbackTransaction: vi.fn(async () => status(Status.SUCCESS)),
  };
  const driver = {
    database: '/local',
    ready: vi.fn(async () => undefined),
    close: vi.fn(),
    createClient: vi.fn(() => client),
  };
  const values: Record<string, unknown> = {
    clientUrl: 'grpc://localhost:2136',
    dbName: '/local',
    driverOptions: { driver: driver as unknown as Driver },
    pool: { max: 1 },
  };
  const config = {
    getLogger: () => ({ logQuery: vi.fn() }),
    getPlatform: () => ({}),
    get: (name: string) => values[name],
    getExtension: () => undefined,
  } as unknown as Configuration;
  return { connection: new YdbConnection(config), client, driver };
}

describe('YDB native connection lifecycle', () => {
  it('binds typed parameters, reuses one session, and preserves an externally owned driver', async () => {
    const { connection, client, driver } = fixture();
    try {
      await connection.query('SELECT $id AS id', { $id: new Int32(123) });
      await connection.query('SELECT 1');
      expect(client.createSession).toHaveBeenCalledTimes(1);
      const request = client.executeDataQuery.mock.calls[0]?.[0];
      expect(request).toMatchObject({
        query: { query: { value: 'DECLARE $id AS Int32;\nSELECT $id AS id' } },
        txControl: { commitTx: true },
        parameters: { $id: { value: { value: { case: 'int32Value', value: 123 } } } },
      });
    } finally {
      await connection.close();
    }
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(driver.close).not.toHaveBeenCalled();
  });

  it('bounds retries of an atomically aborted standalone statement', async () => {
    const { connection, client } = fixture();
    client.executeDataQuery.mockResolvedValue(status(Status.ABORTED));
    try {
      await expect(connection.query('SELECT 1')).rejects.toBeInstanceOf(DeadlockException);
      expect(client.executeDataQuery).toHaveBeenCalledTimes(3);
    } finally {
      await connection.close();
    }
  });

  it('never replays a transactional callback and rolls back a failed statement', async () => {
    const { connection, client } = fixture();
    client.executeDataQuery.mockResolvedValue(status(Status.ABORTED));
    const callback = vi.fn(async (tx: YdbTransaction) => connection.query('SELECT 1', {}, tx));
    try {
      await expect(connection.transactional(callback)).rejects.toBeInstanceOf(DeadlockException);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(client.executeDataQuery).toHaveBeenCalledTimes(1);
      expect(client.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(client.commitTransaction).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it('uses one transaction id and emits transaction events in order', async () => {
    const { connection, client } = fixture();
    const dispatchEvent = vi.fn(async (_event: string) => undefined);
    try {
      await connection.transactional(
        async tx => {
          await connection.query('SELECT 1', {}, tx);
        },
        { eventBroadcaster: { dispatchEvent } as never },
      );
      expect(client.executeDataQuery.mock.calls[0]?.[0]).toMatchObject({
        txControl: { txSelector: { case: 'txId', value: 'tx1' }, commitTx: false },
      });
      expect(dispatchEvent.mock.calls.map(call => call[0])).toEqual([
        EventType.beforeTransactionStart,
        EventType.afterTransactionStart,
        EventType.beforeTransactionCommit,
        EventType.afterTransactionCommit,
      ]);
    } finally {
      await connection.close();
    }
  });

  it('replaces a rejected expired session before retrying the standalone statement', async () => {
    const { connection, client } = fixture();
    client.executeDataQuery.mockResolvedValueOnce(status(Status.BAD_SESSION));
    try {
      await connection.query('SELECT 1');
      expect(client.deleteSession).toHaveBeenCalledTimes(1);
      expect(client.createSession).toHaveBeenCalledTimes(2);
      expect(client.executeDataQuery).toHaveBeenCalledTimes(2);
    } finally {
      await connection.close();
    }
  });

  it('bounds expired-session recovery and does not replay statements within an explicit transaction', async () => {
    const { connection, client } = fixture();
    client.executeDataQuery.mockResolvedValue(status(Status.SESSION_EXPIRED));
    try {
      await expect(connection.query('SELECT 1')).rejects.toBeInstanceOf(ConnectionException);
      expect(client.createSession).toHaveBeenCalledTimes(3);
      expect(client.executeDataQuery).toHaveBeenCalledTimes(3);
      client.executeDataQuery.mockClear();
      const callback = vi.fn(async (tx: YdbTransaction) => connection.query('SELECT 1', {}, tx));
      await expect(connection.transactional(callback)).rejects.toBeInstanceOf(ConnectionException);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(client.executeDataQuery).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });

  it('replaces an expired session at begin before invoking the body or after-start subscriber', async () => {
    const { connection, client } = fixture();
    client.beginTransaction.mockResolvedValueOnce(status(Status.BAD_SESSION));
    const dispatchEvent = vi.fn(async (_event: string) => undefined);
    const callback = vi.fn(async () => 'done');
    try {
      await expect(connection.transactional(callback, { eventBroadcaster: { dispatchEvent } as never })).resolves.toBe(
        'done',
      );
      expect(callback).toHaveBeenCalledTimes(1);
      expect(client.createSession).toHaveBeenCalledTimes(2);
      expect(client.beginTransaction).toHaveBeenCalledTimes(2);
      expect(dispatchEvent.mock.calls.map(call => call[0])).toEqual([
        EventType.beforeTransactionStart,
        EventType.afterTransactionStart,
        EventType.beforeTransactionCommit,
        EventType.afterTransactionCommit,
      ]);
    } finally {
      await connection.close();
    }
  });

  it('rejects truncated reads instead of hydrating an incomplete collection', async () => {
    const { connection, client } = fixture();
    client.executeDataQuery.mockResolvedValue(result(ExecuteQueryResultSchema, { resultSets: [{ truncated: true }] }));
    try {
      await expect(connection.query('SELECT 1')).rejects.toThrow('truncated');
    } finally {
      await connection.close();
    }
  });

  it('uses an absolute database path for table introspection', async () => {
    const { connection, client } = fixture();
    client.describeTable.mockResolvedValue(result(DescribeTableResultSchema, { primaryKey: ['id'] }));
    try {
      expect(await connection.describeTable('sample')).toMatchObject({ primaryKey: ['id'] });
      expect(client.describeTable.mock.calls[0]?.[0]).toMatchObject({ path: '/local/sample' });
      expect(client.describePath).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it('confirms an ambiguous missing table through the scheme service', async () => {
    const { connection, client } = fixture();
    client.describeTable.mockResolvedValue(status(Status.SCHEME_ERROR));
    client.describePath.mockResolvedValue({
      operation: create(OperationSchema, {
        ready: true,
        status: Status.SCHEME_ERROR,
        issues: [{ message: 'Path not found' }],
      }),
    });
    try {
      expect(await connection.describeTable('missing')).toBeUndefined();
      expect(client.describePath.mock.calls[0]?.[0]).toEqual({ path: '/local/missing' });
      client.describePath.mockResolvedValue(status(Status.UNAUTHORIZED));
      await expect(connection.describeTable('restricted')).rejects.toThrow('UNAUTHORIZED');
    } finally {
      await connection.close();
    }
  });

  it('rejects nested transactions and user SQL transaction control before executing them', async () => {
    const { connection, client } = fixture();
    try {
      await expect(connection.begin({ ctx: {} })).rejects.toThrow('nested');
      await expect(connection.query('SELECT 1; COMMIT;')).rejects.toThrow('transaction control');
      expect(client.beginTransaction).not.toHaveBeenCalled();
      expect(client.executeDataQuery).not.toHaveBeenCalled();
    } finally {
      await connection.close();
    }
  });

  it.each(['commit', 'rollback'] as const)(
    'rejects concurrent statements and completion while %s is waiting for a subscriber',
    async method => {
      const { connection, client } = fixture();
      let finishHook!: () => void;
      let enterHook!: () => void;
      const hookEntered = new Promise<void>(resolve => {
        enterHook = resolve;
      });
      const hookGate = new Promise<void>(resolve => {
        finishHook = resolve;
      });
      const transaction = await connection.begin();
      const dispatchEvent = vi.fn(async (event: string) => {
        if (event === (method === 'commit' ? EventType.beforeTransactionCommit : EventType.beforeTransactionRollback)) {
          enterHook();
          await hookGate;
        }
      });
      const finishing = connection[method](transaction, { dispatchEvent } as never);
      await hookEntered;
      try {
        await expect(connection.query('SELECT 1', {}, transaction)).rejects.toThrow('Concurrent');
        await expect(connection[method](transaction)).rejects.toThrow('while');
        expect(client.executeDataQuery).not.toHaveBeenCalled();
      } finally {
        finishHook();
        await finishing;
        await connection.close();
      }
    },
  );

  it('allows rollback after a before-commit subscriber fails', async () => {
    const { connection, client } = fixture();
    const transaction = await connection.begin();
    const dispatchEvent = vi.fn(async () => {
      throw new Error('subscriber failed');
    });
    try {
      await expect(connection.commit(transaction, { dispatchEvent } as never)).rejects.toThrow('subscriber failed');
      await connection.rollback(transaction);
      expect(client.commitTransaction).not.toHaveBeenCalled();
      expect(client.rollbackTransaction).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });

  it('treats an owned transaction already aborted by the server as rolled back only for issue 2015', async () => {
    const { connection, client } = fixture();
    const transaction = await connection.begin();
    client.executeDataQuery.mockResolvedValue(status(Status.BAD_REQUEST));
    await expect(connection.query('SELECT invalid', {}, transaction)).rejects.toThrow();
    expect(transaction.state).toBe('failed');
    expect(connection.hasTransaction(transaction)).toBe(true);
    client.rollbackTransaction.mockResolvedValue({
      operation: create(OperationSchema, {
        ready: true,
        status: Status.NOT_FOUND,
        issues: [{ issueCode: 2015, message: 'Transaction not found: tx1' }],
      }),
    });
    try {
      await connection.rollback(transaction);
      expect(transaction.state).toBe('rolledBack');
      expect(connection.hasTransaction(transaction)).toBe(false);
      const next = await connection.begin();
      await connection.rollback(next);
      expect(client.createSession).toHaveBeenCalledTimes(1);
    } finally {
      await connection.close();
    }
  });

  it.each([
    { code: Status.NOT_FOUND, issueCode: 2016, message: 'Transaction not found: tx1' },
    { code: Status.NOT_FOUND, issueCode: 2015, message: 'Table not found: sample' },
    { code: Status.BAD_REQUEST, issueCode: 2015, message: 'Transaction not found: tx1' },
  ])('does not suppress another rollback error ($code/$issueCode/$message)', async ({ code, issueCode, message }) => {
    const { connection, client } = fixture();
    const transaction = await connection.begin();
    client.rollbackTransaction.mockResolvedValue({
      operation: create(OperationSchema, {
        ready: true,
        status: code,
        issues: [{ issueCode, message }],
      }),
    });
    try {
      await expect(connection.rollback(transaction)).rejects.toThrow();
      expect(connection.hasTransaction(transaction)).toBe(false);
      expect(client.deleteSession).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it('preserves a rollback subscriber failure when the server confirms the transaction is already gone', async () => {
    const { connection, client } = fixture();
    const transaction = await connection.begin();
    const failure = new Error('rollback subscriber failed');
    client.rollbackTransaction.mockResolvedValue({
      operation: create(OperationSchema, {
        ready: true,
        status: Status.NOT_FOUND,
        issues: [{ issueCode: 2015, message: 'Transaction not found: tx1' }],
      }),
    });
    try {
      await expect(
        connection.rollback(transaction, {
          dispatchEvent: vi.fn(async () => {
            throw failure;
          }),
        } as never),
      ).rejects.toBe(failure);
      expect(transaction.state).toBe('rolledBack');
      expect(connection.hasTransaction(transaction)).toBe(false);
      expect(client.rollbackTransaction).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });
});

describe('YDB error conversion', () => {
  it('distinguishes missing tables from other schema errors', () => {
    expect(isYdbTableNotFound(new YDBError(Status.NOT_FOUND, []))).toBe(true);
    expect(isYdbTableNotFound(new YDBError(Status.SCHEME_ERROR, []))).toBe(false);
    expect(isYdbTableNotFound(new YDBError(Status.UNAUTHORIZED, []))).toBe(false);
  });

  it('maps a confirmed duplicate primary-key failure', () => {
    const error = new YDBError(Status.PRECONDITION_FAILED, [
      create(IssueMessageSchema, { message: 'Duplicate keys found' }),
    ]);
    expect(new YdbExceptionConverter().convertException(error)).toBeInstanceOf(UniqueConstraintViolationException);
  });

  it('classifies the nested existing-key issue returned by real YDB', () => {
    const error = new YDBError(Status.PRECONDITION_FAILED, [
      create(IssueMessageSchema, {
        message: 'Constraint violated. Table: `/local/sample`.',
        issueCode: 2012,
        severity: 1,
        issues: [{ message: 'Conflict with existing key.', issueCode: 2012, severity: 1 }],
      }),
    ]);
    expect(new YdbExceptionConverter().convertException(error)).toBeInstanceOf(UniqueConstraintViolationException);
  });

  it('does not label a missing transaction or arbitrary precondition as a table or constraint error', () => {
    const converter = new YdbExceptionConverter();
    expect(converter.convertException(new YDBError(Status.NOT_FOUND, []))).toBeInstanceOf(
      DatabaseObjectNotFoundException,
    );
    const error = converter.convertException(new YDBError(Status.PRECONDITION_FAILED, []));
    expect(error.constructor.name).toBe('DriverException');
  });
});
