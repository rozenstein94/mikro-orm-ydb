import { create } from '@bufbuild/protobuf';
import { IssueMessageSchema } from '@ydbjs/api/operation';
import { expect, test } from 'vitest';
import { YDBError } from '@ydbjs/error';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YdbExceptionConverter } from '../src/YdbExceptionConverter.js';
import { DeadlockException } from '@mikro-orm/core';
import { AbortedTransactionError } from 'kysely';

test('SQL errors retain nested YQL diagnostic messages', () => {
  const error = new YDBError(Status.GENERIC_ERROR, [
    create(IssueMessageSchema, { message: 'Type annotation', issues: [{ message: 'Unknown column missing_id' }] }),
  ]);
  expect(new YdbExceptionConverter().convertException(error).message).toContain('Unknown column missing_id');
});

test('preserves a confirmed commit-abort exception through the Kysely transaction wrapper', () => {
  const original = new DeadlockException(new Error('Confirmed abort'));
  const wrapper = new AbortedTransactionError();
  wrapper.cause = original;
  expect(new YdbExceptionConverter().convertException(wrapper)).toBe(original);
});
