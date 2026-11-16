import {
  isRaw,
  ReferenceKind,
  Utils,
  type Dictionary,
  type EntityMetadata,
  type EntityProperty,
} from '@mikro-orm/core';
import { type Value } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import {
  Bool,
  Bytes,
  Double,
  Int32,
  Int64,
  JsonDocument,
  Timestamp,
  Utf8,
  BoolType,
  BytesType,
  DoubleType,
  Int32Type,
  Int64Type,
  JsonDocumentType,
  TimestampType,
  Utf8Type,
} from '@ydbjs/value/primitive';
import type { YdbPlatform } from './YdbPlatform.js';

/** Compiles only metadata-backed identifiers; every data value is a named, typed parameter. */
export class YqlQuery {
  readonly parameters: Record<string, Value> = {};

  constructor(
    readonly meta: EntityMetadata,
    readonly platform: YdbPlatform,
  ) {}

  field(name: string): EntityProperty {
    const prop =
      this.meta.properties[name] ?? this.platform.columnProperties(this.meta).find(p => p.fieldNames[0] === name);
    if (!prop || !this.platform.columnProperties(this.meta).includes(prop)) {
      throw new Error(`YDB driver requires a stored scalar or owning to-one property: ${this.meta.className}.${name}`);
    }
    return prop;
  }

  column(name: string): string {
    return this.platform.quoteIdentifier(this.field(name).fieldNames[0]);
  }

  bind(prop: EntityProperty, value: unknown): string {
    if (isRaw(value) || value === undefined)
      throw new Error(`YDB driver cannot bind SQL expressions or undefined: ${prop.name}`);
    const type = this.platform.getYdbType(prop);
    const invalid = (): never => {
      throw new Error(`Invalid YDB ${type} value for ${this.meta.className}.${prop.name}`);
    };
    let item: Value;
    const types = {
      Utf8: Utf8Type,
      Int32: Int32Type,
      Int64: Int64Type,
      Double: DoubleType,
      Bool: BoolType,
      Timestamp: TimestampType,
      String: BytesType,
      JsonDocument: JsonDocumentType,
    };
    if (value === null) {
      const TypeClass = types[type as keyof typeof types];
      item = new Optional(null, new TypeClass());
    } else {
      switch (type) {
        case 'Utf8':
          if (typeof value !== 'string') invalid();
          item = new Utf8(value as string);
          break;
        case 'Int32':
          if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)
            invalid();
          item = new Int32(value as number);
          break;
        case 'Int64': {
          if (
            !['bigint', 'string', 'number'].includes(typeof value) ||
            (typeof value === 'number' && !Number.isSafeInteger(value))
          )
            invalid();
          let big: bigint;
          try {
            big = BigInt(value as string);
          } catch {
            return invalid();
          }
          if (big < -(1n << 63n) || big >= 1n << 63n) invalid();
          item = new Int64(big);
          break;
        }
        case 'Double':
          if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
          item = new Double(value as number);
          break;
        case 'Bool':
          if (typeof value !== 'boolean') invalid();
          item = new Bool(value as boolean);
          break;
        case 'Timestamp': {
          const date = value instanceof Date ? value : new Date(value as string);
          if (Number.isNaN(date.getTime()) || date.getTime() < 0 || date.getTime() >= Date.UTC(2106, 0, 1)) invalid();
          item = new Timestamp(date);
          break;
        }
        case 'String':
          if (!(value instanceof Uint8Array)) invalid();
          item = new Bytes(value as Uint8Array);
          break;
        case 'JsonDocument': {
          let json: string;
          try {
            json = typeof value === 'string' ? value : JSON.stringify(value);
            JSON.parse(json);
          } catch {
            return invalid();
          }
          item = new JsonDocument(json);
          break;
        }
        default:
          return invalid();
      }
      if (prop.nullable) item = new Optional(item);
    }
    const name = `$p${Object.keys(this.parameters).length}`;
    this.parameters[name] = item;
    return name;
  }

  where(input: unknown): string {
    if (Utils.isPrimaryKey(input)) {
      if (this.meta.compositePK) throw new Error('YDB composite-key filters require an object or a tuple');
      input = { [this.meta.primaryKeys[0]]: input };
    }
    if (Array.isArray(input)) {
      if (!this.meta.compositePK || input.length !== this.meta.primaryKeys.length)
        throw new Error('Invalid YDB composite primary key');
      input = Object.fromEntries(this.meta.primaryKeys.map((k, i) => [k, (input as unknown[])[i]]));
    }
    if (!Utils.isPlainObject(input)) throw new Error('YDB filters must be metadata-backed objects');
    const clauses: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (key === '$and' || key === '$or') {
        if (!Array.isArray(value)) throw new Error(`YDB ${key} requires an array`);
        const children = value.map(v => `(${this.where(v)})`);
        clauses.push(
          children.length ? `(${children.join(key === '$and' ? ' AND ' : ' OR ')})` : key === '$and' ? 'TRUE' : 'FALSE',
        );
      } else if (key === '$not') {
        clauses.push(`NOT (${this.where(value)})`);
      } else if (key.includes('~~~')) {
        clauses.push(this.compositeCondition(key, value));
      } else {
        clauses.push(this.condition(this.field(key), value));
      }
    }
    return clauses.length ? clauses.join(' AND ') : 'TRUE';
  }

  private compositeCondition(key: string, value: unknown): string {
    const keys = key.split('~~~');
    if (keys.join('~~~') !== this.meta.primaryKeys.join('~~~') || !Utils.isPlainObject<Dictionary>(value)) {
      throw new Error('Unsupported YDB composite key filter');
    }
    if (Object.keys(value).length !== 1 || !Array.isArray(value.$in))
      throw new Error('YDB composite key filters require $in tuples');
    const input = value.$in as unknown[];
    // MikroORM represents a root composite tuple as a flat $in value.
    const tuples =
      input.length && input.every(item => Utils.isPlainObject(item))
        ? input.map(item => {
            const row = item as Dictionary;
            if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) {
              throw new Error('Invalid YDB composite key object');
            }
            return keys.map(key => row[key]);
          })
        : input.length && input.every(item => !Array.isArray(item) && !Utils.isPlainObject(item))
          ? [input]
          : input;
    return tuples.length
      ? `(${tuples
          .map(row => {
            if (!Array.isArray(row) || row.length !== keys.length) throw new Error('Invalid YDB composite key tuple');
            return `(${keys.map((k, i) => this.condition(this.field(k), row[i])).join(' AND ')})`;
          })
          .join(' OR ')})`
      : 'FALSE';
  }

  private condition(prop: EntityProperty, value: unknown): string {
    const column = this.platform.quoteIdentifier(prop.fieldNames[0]);
    if (Array.isArray(value)) value = { $in: value };
    if (value === null) return `${column} IS NULL`;
    if (!Utils.isPlainObject(value)) return `${column} = ${this.bind(prop, value)}`;
    const operators: Record<string, string> = {
      $eq: '=',
      $ne: '!=',
      $gt: '>',
      $gte: '>=',
      $lt: '<',
      $lte: '<=',
      $like: 'LIKE',
    };
    return (
      Object.entries(value)
        .map(([operator, operand]) => {
          if (operator === '$not') return `NOT (${this.condition(prop, operand)})`;
          if (operator === '$exists') {
            if (typeof operand !== 'boolean') throw new Error('YDB $exists requires a boolean');
            return `${column} IS ${operand ? 'NOT ' : ''}NULL`;
          }
          if (operator === '$in' || operator === '$nin') {
            if (!Array.isArray(operand)) throw new Error(`YDB ${operator} requires an array`);
            if (!operand.length) return operator === '$in' ? 'FALSE' : 'TRUE';
            if (operand.includes(null))
              throw new Error('YDB $in/$nin with null is ambiguous; use an explicit $or and null filter');
            return `${column} ${operator === '$nin' ? 'NOT ' : ''}IN (${operand.map(v => this.bind(prop, v)).join(', ')})`;
          }
          if (!operators[operator])
            throw new Error(`YDB driver does not support filter operator ${operator} on ${prop.name}`);
          if (operand === null) {
            if (operator !== '$eq' && operator !== '$ne') throw new Error('YDB null filters only support $eq/$ne');
            return `${column} IS ${operator === '$ne' ? 'NOT ' : ''}NULL`;
          }
          if (operator === '$like' && this.platform.getYdbType(prop) !== 'Utf8')
            throw new Error('YDB $like requires a text property');
          return `${column} ${operators[operator]} ${this.bind(prop, operand)}`;
        })
        .map(c => `(${c})`)
        .join(' AND ') || 'TRUE'
    );
  }

  orderBy(order: unknown): string {
    if (order == null) return '';
    const clauses = Utils.asArray(order).flatMap(item => {
      if (!Utils.isPlainObject(item)) throw new Error('YDB orderBy requires a scalar property map');
      return Object.entries(item).map(([name, direction]) => {
        const dir = direction === 1 ? 'ASC' : direction === -1 ? 'DESC' : String(direction).toUpperCase();
        if (!['ASC', 'DESC'].includes(dir)) throw new Error('YDB driver supports ASC or DESC ordering only');
        return `${this.column(name)} ${dir}`;
      });
    });
    return clauses.length ? ` ORDER BY ${clauses.join(', ')}` : '';
  }

  pagination(limit?: number, offset?: number): string {
    for (const value of [limit, offset]) {
      if (value != null && (!Number.isSafeInteger(value) || value < 0))
        throw new Error('YDB limit/offset must be non-negative safe integers');
    }
    return (
      (limit != null ? ` LIMIT ${limit}` : offset != null ? ' LIMIT 18446744073709551615ul' : '') +
      (offset != null ? ` OFFSET ${offset}` : '')
    );
  }

  data(data: Dictionary, convertCustomTypes = true): [EntityProperty, unknown][] {
    return Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => {
        const prop = this.field(name);
        if (value === null && !prop.nullable) throw new Error(`YDB property ${prop.name} is not nullable`);
        if (prop.kind !== ReferenceKind.SCALAR && Utils.isPlainObject(value))
          throw new Error('YDB relation data must be a scalar primary key');
        const converted =
          convertCustomTypes && prop.customType
            ? prop.customType.convertToDatabaseValue(value, this.platform, { mode: 'query' })
            : value;
        return [prop, converted];
      });
  }
}
