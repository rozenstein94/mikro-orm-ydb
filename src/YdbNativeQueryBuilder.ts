import { type Dictionary, isRaw, LockMode, type RawQueryFragment, Utils } from '@mikro-orm/core';
import { AbstractSqlPlatform, NativeQueryBuilder, QueryType, type TableOptions } from '@mikro-orm/sql';
import { fromJs, type JSValue, type Value } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import {
  Bool,
  Bytes,
  Date as YdbDate,
  Datetime,
  Double,
  Float,
  Int8,
  Int16,
  Int32,
  Int64,
  Json,
  JsonDocument,
  Timestamp,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Utf8,
  Uuid,
  BoolType,
  BytesType,
  DateType,
  DatetimeType,
  DoubleType,
  FloatType,
  Int8Type,
  Int16Type,
  Int32Type,
  Int64Type,
  JsonType,
  JsonDocumentType,
  TimestampType,
  Uint8Type,
  Uint16Type,
  Uint32Type,
  Uint64Type,
  Utf8Type,
  UuidType,
} from '@ydbjs/value/primitive';

/** Column declarations include a trailing ? when the stored column is nullable. */
export interface YdbQueryPlatform extends AbstractSqlPlatform {
  getColumnType(table: string, column: string): string | undefined;
  getPrimaryKeyColumns(table: string): string[];
  createParameterValue?(value: unknown, declaration: string): Value;
}

const primitiveTypes = {
  Bool: BoolType,
  String: BytesType,
  Utf8: Utf8Type,
  Json: JsonType,
  JsonDocument: JsonDocumentType,
  Int8: Int8Type,
  Int16: Int16Type,
  Int32: Int32Type,
  Int64: Int64Type,
  Uint8: Uint8Type,
  Uint16: Uint16Type,
  Uint32: Uint32Type,
  Uint64: Uint64Type,
  Float: FloatType,
  Double: DoubleType,
  Timestamp: TimestampType,
  Datetime: DatetimeType,
  Date: DateType,
  Uuid: UuidType,
};

/**
 * MikroORM's SQL builder produces YQL while keeping every data value bound.
 * Conflict handling uses a serializable read/write statement rather than SQL ON CONFLICT.
 */
export class YdbNativeQueryBuilder extends NativeQueryBuilder {
  readonly #ydbPlatform: YdbQueryPlatform;
  #table?: string;

  constructor(platform: YdbQueryPlatform) {
    super(platform);
    this.#ydbPlatform = platform;
  }

  override from(table: string | RawQueryFragment | NativeQueryBuilder, options?: TableOptions): this {
    this.#table = typeof table === 'string' ? table : undefined;
    return super.from(table, options);
  }

  override compile(): { sql: string; params: unknown[] } {
    if (this.options.distinctOn?.length) {
      throw new Error('YDB does not support DISTINCT ON; use GROUP BY or an explicit window query');
    }
    if (this.options.onConflict && this.type !== QueryType.INSERT) {
      throw new Error('YDB conflict handling is valid only for INSERT');
    }
    const returning = this.options.returning;
    if ([QueryType.INSERT, QueryType.UPDATE, QueryType.DELETE, QueryType.TRUNCATE].includes(this.type!)) {
      // YDB has no protocol affected-row counter. The returned rows are the authoritative count.
      this.options.returning = returning?.length ? returning : ['*'];
    }
    try {
      return super.compile();
    } finally {
      this.options.returning = returning;
    }
  }

  protected override addLockClause(): void {
    if (this.options.lockMode != null && ![LockMode.NONE, LockMode.OPTIMISTIC].includes(this.options.lockMode)) {
      throw new Error('YDB does not support pessimistic row locks; use serializable transactions');
    }
  }

  protected override addOnConflictClause(): void {
    // compileInsert implements conflict handling in native YQL; never append SQL ON CONFLICT.
  }

  protected override compileSelect(): void {
    const countSubquery = this.needsCountSubquery();
    const projection = this.projection(countSubquery);
    const order = countSubquery
      ? { sql: '', extra: [] as { sql: string; alias: string }[] }
      : this.compileOrder(projection);
    if (order.extra.length && this.options.distinct) {
      throw new Error('YDB DISTINCT queries must select every ORDER BY expression');
    }
    if (order.extra.length) {
      // YQL only sorts projected values. Keep the synthetic sort columns out of the public
      // projection (especially a one-column IN subquery used by joined pagination).
      this.parts.push(`select * without ${order.extra.map(item => this.quote(item.alias)).join(', ')} from (`);
    }
    if (countSubquery) this.parts.push(`select count(*) as ${this.quote('count')} from (`);
    this.parts.push('select');
    this.addHintComment();
    this.parts.push(
      `${projection.sql}${order.extra.length ? ', ' + order.extra.map(item => `${item.sql} as ${this.quote(item.alias)}`).join(', ') : ''} from ${this.getTableName()}`,
    );
    for (const join of this.options.joins ?? []) {
      if (/\b(?:lateral|natural)\s+join\b/i.test(join.sql)) {
        throw new Error('YDB does not support LATERAL or NATURAL joins');
      }
      this.parts.push(this.fragment(join.sql, join.params));
    }
    this.appendConditions();
    if (this.options.groupBy?.length) {
      this.parts.push(`group by ${this.options.groupBy.map(field => this.quote(field)).join(', ')}`);
    }
    if (this.options.having?.sql.trim()) {
      this.parts.push(`having ${this.fragment(this.options.having.sql, this.options.having.params)}`);
    }
    if (countSubquery) {
      this.parts.push(`) as ${this.quote('dcnt')}`);
      return;
    }
    if (order.sql) this.parts.push(`order by ${order.sql}`);
    if (this.options.limit != null) {
      this.parts.push(`limit ${this.pagination(this.options.limit)}`);
    } else if (this.options.offset != null) {
      // The YQL grammar requires LIMIT before OFFSET.
      this.parts.push('limit 18446744073709551615ul');
    }
    if (this.options.offset != null) this.parts.push(`offset ${this.pagination(this.options.offset)}`);
    if (order.extra.length) this.parts.push(') as `__ydb_ordered`');
  }

  private projection(countSubquery: boolean): { sql: string; names: Map<string, string>; wildcard: Set<string> } {
    if (!this.options.select?.length) throw new Error('No fields selected');
    const names = new Map<string, string>();
    const wildcard = new Set<string>();
    const fields = this.options.select.map(field => {
      let sql = this.quote(field);
      const aliased = sql.match(/\s+as\s+(`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)\s*$/i);
      const source = (aliased ? sql.slice(0, aliased.index) : sql).trim();
      const reference = this.reference(source);
      const star = source.match(/^(.*)\.\*$/);
      if (source === '*') wildcard.add('*');
      else if (star) wildcard.add(star[1].replaceAll('`', ''));
      if (aliased) {
        const alias = this.identifier(aliased[1]);
        names.set(source, alias);
        names.set(this.platform.quoteIdentifier(alias), alias);
      } else if (reference) {
        const alias = reference.at(-1)!;
        names.set(source, alias);
        names.set(this.platform.quoteIdentifier(alias), alias);
        // YQL retains the qualifier in an unaliased projection, whereas SQL drivers
        // and MikroORM's pivot/hydration mappers expect the unqualified column name.
        if (reference.length > 1 && (this.type !== QueryType.COUNT || countSubquery)) {
          sql += ` as ${this.quote(alias)}`;
        }
      }
      return sql;
    });
    let sql = fields.join(', ');
    if (countSubquery || this.options.distinct) sql = `distinct ${sql}`;
    if (this.type === QueryType.COUNT && !countSubquery) sql = `count(${sql}) as ${this.quote('count')}`;
    return { sql, names, wildcard };
  }

  private compileOrder(projection: { names: Map<string, string>; wildcard: Set<string> }): {
    sql: string;
    extra: { sql: string; alias: string }[];
  } {
    const extra: { sql: string; alias: string }[] = [];
    if (!this.options.orderBy) return { sql: '', extra };
    const orders = this.splitExpressions(this.options.orderBy).map(term => {
      const match = term.match(/\s+(asc|desc)(?:\s+nulls\s+(first|last))?\s*$/i);
      const expression = (match ? term.slice(0, match.index) : term).trim();
      const direction = match ? term.slice(match.index) : '';
      const selected = projection.names.get(expression);
      if (selected) return this.quote(selected) + direction;
      const reference = this.reference(expression);
      if (reference?.length === 1 && [...projection.names.values()].includes(reference[0])) {
        return this.quote(reference[0]) + direction;
      }
      let missing = false;
      const rewritten = this.rewriteIdentifiers(expression, (source, parts, next) => {
        if (parts.length === 1) {
          if (
            next !== '(' &&
            !projection.wildcard.size &&
            ![...projection.names.values()].includes(parts[0]) &&
            this.#table &&
            this.#ydbPlatform.getColumnType(this.#table, parts[0])
          )
            missing = true;
          return source;
        }
        const selected = projection.names.get(source);
        if (selected) return this.quote(selected);
        if (projection.wildcard.has('*') || projection.wildcard.has(parts.slice(0, -1).join('.'))) {
          return this.quote(parts.at(-1)!);
        }
        missing = true;
        return source;
      });
      if (reference?.length === 1 && !projection.wildcard.size && !projection.names.has(expression)) missing = true;
      // Aggregation must happen in SELECT/GROUP BY, never in the post-projection ORDER BY.
      if (!missing && !/\b(?:min|max|sum|avg|count|some|every|listagg|aggregate_list)\s*\(/i.test(expression)) {
        return rewritten + direction;
      }
      if (expression.includes('?'))
        throw new Error('Select a parameterized ORDER BY expression with an explicit alias');
      let index = extra.length;
      while ([...projection.names.values()].includes(`__ydb_order_${index}`)) index++;
      const alias = `__ydb_order_${index}`;
      extra.push({ sql: expression, alias });
      return this.quote(alias) + direction;
    });
    return { sql: orders.join(', '), extra };
  }

  private identifier(value: string): string {
    return value.replace(/^`|`$/g, '').replaceAll('``', '`');
  }

  private reference(expression: string): string[] | undefined {
    const parts = expression.split(/\s*\.\s*/);
    return parts.every(part => /^(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)$/.test(part))
      ? parts.map(part => this.identifier(part))
      : undefined;
  }

  private splitExpressions(sql: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | undefined;
    let start = 0;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) {
          if (sql[i + 1] === quote) i++;
          else quote = undefined;
        }
      } else if (["'", '"', '`'].includes(c)) quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(sql.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(sql.slice(start).trim());
    return parts;
  }

  protected override compileInsert(): void {
    const conflict = this.options.onConflict;
    if (conflict) {
      this.compileConflictInsert();
      return;
    }
    this.parts.push(`insert into ${this.getTableName()}`);
    if (this.options.insertSubQuery) {
      const source = this.options.insertSubQuery;
      if (source.columns.length) this.parts.push(`(${source.columns.join(', ')})`);
      this.parts.push(this.fragment(source.sql, source.params));
      return;
    }
    const rows = this.rows();
    const columns = this.columns(rows);
    if (!columns.length) throw new Error('YDB INSERT requires stored column values');
    this.parts.push(`(${columns.map(column => this.quote(column)).join(', ')}) values`);
    this.parts.push(
      rows.map(row => `(${columns.map(column => this.dataValue(column, row[column])).join(', ')})`).join(', '),
    );
  }

  protected override compileUpdate(): void {
    if (!this.options.data || !Object.keys(this.options.data).length) throw new Error('YDB UPDATE requires data');
    if (this.options.joins?.length) {
      throw new Error('YDB UPDATE with JOIN is not supported; select the keys first in the same transaction');
    }
    const primary = this.#table ? this.#ydbPlatform.getPrimaryKeyColumns(this.#table) : [];
    if (Object.keys(this.options.data).some(column => primary.includes(column))) {
      throw new Error('YDB cannot update primary-key columns');
    }
    this.parts.push(`update ${this.getTableName()} set`);
    this.parts.push(
      Object.entries(this.options.data)
        .map(([column, value]) => `${this.quote(column)} = ${this.dataValue(column, value)}`)
        .join(', '),
    );
    this.appendConditions();
  }

  protected override compileDelete(): void {
    if (this.options.joins?.length) throw new Error('YDB DELETE with JOIN requires an explicit key subquery');
    super.compileDelete();
  }

  /** Schema clear removes data atomically; YDB sequence values are deliberately not reset. */
  protected override compileTruncate(): void {
    this.parts.push(`delete from ${this.getTableName()}`);
  }

  protected override compileCtes(): void {
    const defined = new Set<string>();
    const names = new Set(this.options.ctes?.map(cte => cte.name));
    for (const cte of this.options.ctes ?? []) {
      if (cte.recursive || cte.columns?.length || cte.materialized != null) {
        throw new Error('YDB named subqueries do not support recursive, column-list or materialized CTE options');
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cte.name)) throw new Error('Invalid YDB named-subquery identifier');
      const sql = this.namedSources(this.fragment(cte.sql, cte.params), defined, names);
      this.parts.push(`$${cte.name} = (${sql});`);
      defined.add(cte.name);
    }
  }

  protected override combineParts(): { sql: string; params: unknown[] } {
    const compiled = super.combineParts();
    const names = new Set(this.options.ctes?.map(cte => cte.name));
    return names.size ? { sql: this.namedSources(compiled.sql, names, names), params: compiled.params } : compiled;
  }

  private namedSources(sql: string, defined: Set<string>, names: Set<string>): string {
    let source = false;
    return this.rewriteIdentifiers(sql, (token, parts) => {
      if (source) {
        source = false;
        if (parts.length === 1 && names.has(parts[0])) {
          if (!defined.has(parts[0]))
            throw new Error(`YDB named subquery ${parts[0]} is referenced before it is defined`);
          return `$${parts[0]}`;
        }
      }
      if (/^(?:from|join)$/i.test(token)) source = true;
      return token;
    });
  }

  protected override getTableName(): string {
    const table = super.getTableName();
    const cte = this.options.ctes?.find(item => item.name === this.#table);
    return cte ? table.replace(this.platform.quoteIdentifier(cte.name), `$${cte.name}`) : table;
  }

  protected override quote(id: string | RawQueryFragment | NativeQueryBuilder): string {
    if (Array.isArray(id)) return super.quote(id[0] as string);
    if (isRaw(id)) return this.fragment(id.sql, id.params);
    if (id instanceof NativeQueryBuilder) {
      const compiled = id.compile();
      return this.fragment(compiled.sql, compiled.params);
    }
    return super.quote(id);
  }

  private rows(): Dictionary[] {
    if (!this.options.data) throw new Error('YDB INSERT requires data');
    const rows = Utils.asArray(this.options.data);
    if (!rows.length) throw new Error('YDB INSERT requires at least one row');
    return rows;
  }

  private columns(rows: Dictionary[]): string[] {
    return [...new Set(rows.flatMap(row => Object.keys(row)))];
  }

  private pagination(value: number): string {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('YDB pagination requires a non-negative safe integer');
    this.params.push(new Uint64(BigInt(value)));
    return 'CAST(? AS Uint64)';
  }

  private appendConditions(): void {
    if (this.options.where?.sql.trim())
      this.parts.push(`where ${this.fragment(this.options.where.sql, this.options.where.params)}`);
  }

  private dataValue(
    column: string,
    value: unknown,
    merge?: { incoming: string; existing: string; columns: string[] },
  ): string {
    const type = this.#table ? this.#ydbPlatform.getColumnType(this.#table, column) : undefined;
    if (isRaw(value)) {
      let expression = this.fragment(value.sql, value.params);
      if (merge)
        expression = this.rewriteIdentifiers(expression, (source, parts, next) => {
          if (parts[0] === 'excluded')
            return [merge.incoming, ...parts.slice(1)].map(part => this.quote(part)).join('.');
          if (parts.length > 1 && parts.slice(0, -1).join('.') === this.#table) {
            return `${this.quote(merge.existing)}.${this.quote(parts.at(-1)!)}`;
          }
          if (parts.length === 1 && merge.columns.includes(parts[0]) && next !== '(') {
            return `${this.quote(merge.existing)}.${this.quote(parts[0])}`;
          }
          return source;
        });
      return type ? this.cast(expression, type) : expression;
    }
    if (value === undefined) value = null;
    this.params.push(
      type
        ? this.#ydbPlatform.createParameterValue
          ? this.#ydbPlatform.createParameterValue(value, type)
          : typedValue(value, type)
        : fromJs(value as JSValue),
    );
    return type ? this.cast('?', type) : '?';
  }

  private cast(expression: string, type: string): string {
    if (!/^(?:[A-Za-z][A-Za-z0-9_]*|Decimal\([0-9]+\s*,\s*[0-9]+\))\??$/.test(type)) {
      throw new Error(`Unsupported YDB column type declaration: ${type}`);
    }
    const target = type.endsWith('?') ? `Optional<${type.slice(0, -1)}>` : type;
    const cast = `CAST(${expression} AS ${target})`;
    return type.endsWith('?') ? cast : `Unwrap(${cast})`;
  }

  private compileConflictInsert(): void {
    const conflict = this.options.onConflict!;
    if (!this.#table) throw new Error('YDB conflict handling requires a physical target table');
    if (isRaw(conflict.fields)) throw new Error('YDB conflict targets must be primary-key columns');
    const primary = this.#ydbPlatform.getPrimaryKeyColumns(this.#table);
    const target = conflict.fields.length ? conflict.fields : primary;
    if (!primary.length || target.length !== primary.length || primary.some(key => !target.includes(key))) {
      throw new Error('YDB UPSERT and IGNORE support only the complete primary key as conflict target');
    }
    if (conflict.where) throw new Error('YDB conditional ON CONFLICT requires an explicit serializable transaction');
    if (conflict.ignore && conflict.merge != null) throw new Error('YDB conflict action cannot both ignore and merge');
    const rows = this.options.insertSubQuery ? undefined : this.rows();
    const columns = rows
      ? this.columns(rows)
      : this.options.insertSubQuery!.columns.map(column => column.replace(/^`|`$/g, ''));
    if (primary.some(key => !columns.includes(key)))
      throw new Error('YDB conflict INSERT must supply every primary-key column');
    if (rows?.some(row => primary.some(key => row[key] == null)))
      throw new Error('YDB conflict INSERT requires non-null primary keys');
    const merge = conflict.merge;
    if (Array.isArray(merge) && merge.some(isRaw)) throw new Error('YDB merge fields must be stored column names');
    const merged = Array.isArray(merge)
      ? merge.length
        ? (merge as string[])
        : columns
      : merge
        ? Object.keys(merge)
        : columns;
    if (merged.some(column => !columns.includes(column))) {
      throw new Error('YDB conflict merge columns must also be present in the inserted column list');
    }
    const version = conflict.version && !merged.includes(conflict.version.field) ? conflict.version : undefined;
    const simple =
      !conflict.ignore && !version && !Utils.isPlainObject(merge) && columns.every(column => merged.includes(column));
    this.parts.push(`upsert into ${this.getTableName()} (${columns.map(column => this.quote(column)).join(', ')})`);
    if (simple && rows) {
      this.parts.push('values');
      this.parts.push(
        rows.map(row => `(${columns.map(column => this.dataValue(column, row[column])).join(', ')})`).join(', '),
      );
      return;
    }
    const incoming = '__ydb_incoming';
    const existing = '__ydb_existing';
    const ref = (alias: string, column: string) => `${this.quote(alias)}.${this.quote(column)}`;
    const absent = `${ref(existing, primary[0])} IS NULL`;
    const selections = columns.map(column => {
      let expression = ref(incoming, column);
      if (!conflict.ignore && !primary.includes(column)) {
        if (version?.field === column) {
          expression = `CASE WHEN ${absent} THEN ${expression} ELSE ${version.timestamp ?? `${ref(existing, column)} + 1`} END`;
        } else if (Utils.isPlainObject(merge) && Object.hasOwn(merge, column)) {
          const update = this.dataValue(column, (merge as Dictionary)[column], { incoming, existing, columns });
          expression = `CASE WHEN ${absent} THEN ${expression} ELSE ${update} END`;
        } else if (!merged.includes(column)) {
          expression = `CASE WHEN ${absent} THEN ${expression} ELSE ${ref(existing, column)} END`;
        }
      }
      const type = this.#ydbPlatform.getColumnType(this.#table!, column);
      return `${type ? this.cast(expression, type) : expression} AS ${this.quote(column)}`;
    });
    // Projection parameters precede source parameters in the generated SQL.
    this.parts.push(`select ${selections.join(', ')} from (`);
    if (rows) {
      this.parts.push(
        rows
          .map(
            row =>
              `select ${columns.map(column => `${this.dataValue(column, row[column])} AS ${this.quote(column)}`).join(', ')}`,
          )
          .join(' union all '),
      );
    } else {
      this.parts.push(this.fragment(this.options.insertSubQuery!.sql, this.options.insertSubQuery!.params));
    }
    this.parts.push(`) AS ${this.quote(incoming)}`);
    if (simple) return;
    this.parts.push(
      `left ${conflict.ignore ? 'only ' : ''}join ${this.platform.quoteIdentifier(this.#table)} AS ${this.quote(existing)} on`,
    );
    this.parts.push(primary.map(key => `${ref(incoming, key)} = ${ref(existing, key)}`).join(' AND '));
  }

  /** Expand identifier placeholders while preserving data placeholders and their parameter order. */
  private fragment(sql: string, parameters: readonly unknown[]): string {
    let output = '';
    let parameter = 0;
    let quote: string | undefined;
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      if (quote) {
        output += char;
        if (char === '\\' && i + 1 < sql.length) output += sql[++i];
        else if (char === quote) {
          if (sql[i + 1] === quote) output += sql[++i];
          else quote = undefined;
        }
      } else if (["'", '"', '`'].includes(char)) {
        quote = char;
        output += char;
      } else if (char === '-' && sql[i + 1] === '-') {
        const end = sql.indexOf('\n', i);
        if (end === -1) {
          output += sql.slice(i);
          break;
        }
        output += sql.slice(i, end + 1);
        i = end;
      } else if (char === '/' && sql[i + 1] === '*') {
        const end = sql.indexOf('*/', i + 2);
        if (end === -1) throw new Error('Unclosed YDB SQL comment');
        output += sql.slice(i, end + 2);
        i = end + 1;
      } else if (char === '?') {
        if (parameter >= parameters.length) throw new Error('YDB SQL placeholder has no corresponding parameter');
        const value = parameters[parameter++];
        if (sql[i + 1] === '?') {
          if (typeof value !== 'string') throw new Error('YDB identifier parameters must be strings');
          output += this.platform.quoteIdentifier(value);
          i++;
        } else if (isRaw(value)) output += this.fragment(value.sql, value.params);
        else {
          output += '?';
          this.params.push(value);
        }
      } else output += char;
    }
    if (parameter !== parameters.length) throw new Error('YDB SQL received more parameters than placeholders');
    return output;
  }

  private rewriteIdentifiers(sql: string, rewrite: (source: string, parts: string[], next: string) => string): string {
    let result = '';
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i];
      if (char === "'" || char === '"') {
        const start = i;
        for (i++; i < sql.length; i++) {
          if (sql[i] === '\\') i++;
          else if (sql[i] === char) {
            if (sql[i + 1] === char) i++;
            else break;
          }
        }
        result += sql.slice(start, i + 1);
        continue;
      }
      if (char === '-' && sql[i + 1] === '-') {
        const end = sql.indexOf('\n', i);
        if (end === -1) {
          result += sql.slice(i);
          break;
        }
        result += sql.slice(i, end + 1);
        i = end;
        continue;
      }
      if (char === '/' && sql[i + 1] === '*') {
        const end = sql.indexOf('*/', i + 2);
        if (end === -1) throw new Error('Unclosed YDB SQL comment');
        result += sql.slice(i, end + 2);
        i = end + 1;
        continue;
      }
      if (char === '`' || (/[A-Za-z_]/.test(char) && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? ''))) {
        const token = sql
          .slice(i)
          .match(
            /^(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)(?:\s*\.\s*(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*))*/,
          )?.[0];
        if (token) {
          const parts = this.reference(token)!;
          const next = sql.slice(i + token.length).trimStart()[0] ?? '';
          result += rewrite(token, parts, next);
          i += token.length - 1;
          continue;
        }
      }
      result += char;
    }
    return result;
  }
}

export function typedValue(value: unknown, declaration: string): Value {
  if (
    value != null &&
    typeof (value as Value).encode === 'function' &&
    typeof (value as Value).type?.encode === 'function'
  ) {
    return value as Value;
  }
  const nullable = declaration.endsWith('?');
  const name = declaration.replace(/\?$/, '');
  const type = primitiveTypes[name as keyof typeof primitiveTypes];
  if (value == null) {
    if (!nullable) throw new Error(`YDB ${declaration} column cannot receive null or a missing value`);
    if (!type) throw new Error(`Cannot bind a null YDB ${declaration} value`);
    return new Optional(null, new type());
  }
  const integer = (bits: number, unsigned = false): bigint => {
    if (
      (typeof value !== 'bigint' && typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))
    )
      throw new Error(`Invalid YDB ${name} value`);
    const big = BigInt(value as string);
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const max = unsigned ? 1n << BigInt(bits) : 1n << BigInt(bits - 1);
    if (big < min || big >= max) throw new Error(`YDB ${name} value is out of range`);
    return big;
  };
  const date = (): Date => {
    const result = value instanceof Date ? value : new Date(value as string);
    if (!Number.isFinite(result.getTime()) || result.getTime() < 0 || result.getTime() >= Date.UTC(2106, 0, 1)) {
      throw new Error(`Invalid YDB ${name} value`);
    }
    return result;
  };
  let result: Value;
  switch (name) {
    case 'Bool':
      if (typeof value !== 'boolean') throw new Error('Invalid YDB Bool value');
      result = new Bool(value);
      break;
    case 'Utf8':
      if (typeof value !== 'string') throw new Error('Invalid YDB Utf8 value');
      result = new Utf8(value);
      break;
    case 'String':
      if (!(value instanceof Uint8Array)) throw new Error('Invalid YDB String value');
      result = new Bytes(value);
      break;
    case 'Int8':
      result = new Int8(Number(integer(8)));
      break;
    case 'Int16':
      result = new Int16(Number(integer(16)));
      break;
    case 'Int32':
      result = new Int32(Number(integer(32)));
      break;
    case 'Int64':
      result = new Int64(integer(64));
      break;
    case 'Uint8':
      result = new Uint8(Number(integer(8, true)));
      break;
    case 'Uint16':
      result = new Uint16(Number(integer(16, true)));
      break;
    case 'Uint32':
      result = new Uint32(Number(integer(32, true)));
      break;
    case 'Uint64':
      result = new Uint64(integer(64, true));
      break;
    case 'Float':
    case 'Double':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid YDB ${name} value`);
      result = name === 'Float' ? new Float(value) : new Double(value);
      break;
    case 'Timestamp':
      result = new Timestamp(date());
      break;
    case 'Datetime':
      result = new Datetime(date());
      break;
    case 'Date':
      result = new YdbDate(date());
      break;
    case 'Uuid':
      if (typeof value !== 'string') throw new Error('Invalid YDB Uuid value');
      result = new Uuid(value);
      break;
    case 'Json':
    case 'JsonDocument': {
      const json = typeof value === 'string' ? value : JSON.stringify(value);
      JSON.parse(json);
      result = name === 'Json' ? new Json(json) : new JsonDocument(json);
      break;
    }
    default:
      result = fromJs(value as JSValue);
  }
  return nullable ? new Optional(result) : result;
}
