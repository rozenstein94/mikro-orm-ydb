import {
  ConnectionException,
  ConstraintViolationException,
  DatabaseObjectNotFoundException,
  DeadlockException,
  DriverException,
  ExceptionConverter,
  NotNullConstraintViolationException,
  SyntaxErrorException,
  TableExistsException,
  TableNotFoundException,
  UniqueConstraintViolationException,
  type Dictionary,
} from '@mikro-orm/core';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YDBError } from '@ydbjs/error';

function issueMessages(issues: unknown): string[] {
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.flatMap(issue => {
    if (!issue || typeof issue !== 'object') {
      return [];
    }
    const entry = issue as { message?: unknown; issues?: unknown };
    return [typeof entry.message === 'string' ? entry.message : '', ...issueMessages(entry.issues)];
  });
}

function errorText(error: YDBError): string {
  return [error.message, ...issueMessages(error.issues)].join('\n');
}

/** Whether YDB explicitly identified a missing table, rather than any schema error. */
export function isYdbTableNotFound(error: unknown): boolean {
  if (!(error instanceof YDBError)) {
    return false;
  }

  return (
    error.code === Status.NOT_FOUND ||
    (error.code === Status.SCHEME_ERROR && /\b(?:path|table) (?:does not exist|not found)\b/i.test(errorText(error)))
  );
}

/** Converts YDB status codes without treating all schema or precondition errors alike. */
export class YdbExceptionConverter extends ExceptionConverter {
  override convertException(exception: Error & Dictionary): DriverException {
    if (exception instanceof DriverException) {
      return exception;
    }

    if (exception instanceof YDBError) {
      const detail = errorText(exception);
      if (exception.code === Status.SCHEME_ERROR && isYdbTableNotFound(exception)) {
        return new TableNotFoundException(exception);
      }

      switch (exception.code) {
        case Status.NOT_FOUND:
          return new DatabaseObjectNotFoundException(exception);
        case Status.ABORTED:
          return new DeadlockException(exception);
        case Status.BAD_SESSION:
        case Status.SESSION_EXPIRED:
        case Status.UNAVAILABLE:
        case Status.OVERLOADED:
        case Status.TIMEOUT:
        case Status.UNDETERMINED:
          return new ConnectionException(exception);
        case Status.ALREADY_EXISTS:
          return new TableExistsException(exception);
        case Status.PRECONDITION_FAILED:
          if (/duplicate|already exists|unique constraint|conflict with existing key/i.test(detail)) {
            return new UniqueConstraintViolationException(exception);
          }
          if (/not null|null value|cannot be null/i.test(detail)) {
            return new NotNullConstraintViolationException(exception);
          }
          if (/constraint/i.test(detail)) {
            return new ConstraintViolationException(exception);
          }
          break;
        case Status.BAD_REQUEST:
          return new SyntaxErrorException(exception);
      }
    }

    // nice-grpc transport errors carry numeric gRPC codes (the YDB status codes are 400xxx).
    if (typeof exception.code === 'number' && [1, 4, 8, 13, 14, 16].includes(exception.code)) {
      return new ConnectionException(exception);
    }

    return super.convertException(exception);
  }
}
