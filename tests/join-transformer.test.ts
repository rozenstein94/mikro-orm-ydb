import { createQueryId, DefaultQueryCompiler, Kysely, type RootOperationNode, sql } from 'kysely';
import { Int32 } from '@ydbjs/value/primitive';
import { YdbDialect, YdbQueryCompiler } from '../src/YdbDialect.js';
import { type YdbConnection } from '../src/YdbConnection.js';
import { YdbJoinTransformer } from '../src/YdbJoinTransformer.js';

interface Database {
  authors: { id: string; tenant: string; enabled: boolean; rank: number };
  posts: {
    id: string;
    author_id: string;
    owner_id: string;
    tenant: string;
    deleted_at: Date | null;
    rank: number;
    published: boolean;
    state: string;
  };
}

const db = new Kysely<Database>({ dialect: new YdbDialect({} as YdbConnection) });
const transform = <T extends RootOperationNode>(node: T): T => new YdbJoinTransformer().transformNode(node);
const compile = (node: RootOperationNode) => new YdbQueryCompiler().compileQuery(transform(node), createQueryId());
const plainCompile = (node: RootOperationNode) => new DefaultQueryCompiler().compileQuery(node, createQueryId());

describe('YDB Kysely JOIN AST transformation', () => {
  test('pushes LEFT JOIN target IS NULL into a derived target and retains the equijoin', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.deleted_at', 'is', null))
      .select(['a.id', 'p.id as post_id'])
      .toOperationNode();
    const compiled = compile(node);
    expect(compiled.sql).toBe(
      'select `a`.`id`, `p`.`id` as `post_id` from `authors` as `a` left join (select * from `posts` as `p` where `p`.`deleted_at` is null) as `p` on `p`.`author_id` = `a`.`id`',
    );
    expect(compiled.parameters).toEqual([]);
  });

  test('uses the physical name as the unchanged alias for an unaliased target', () => {
    const node = db
      .selectFrom('authors')
      .innerJoin('posts', join => join.onRef('posts.author_id', '=', 'authors.id').on('posts.published', '=', true))
      .select('posts.id')
      .toOperationNode();
    expect(compile(node).sql).toContain(
      'inner join (select * from `posts` as `posts` where `posts`.`published` = ?) as `posts` on `posts`.`author_id` = `authors`.`id`',
    );
    expect(compile(node).parameters).toEqual([true]);
  });

  test('retains composite equijoin keys and moves only the target-local conjuncts', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join =>
        join
          .onRef('p.author_id', '=', 'a.id')
          .onRef('p.tenant', '=', 'a.tenant')
          .on('p.rank', '>=', 3)
          .on('p.state', '!=', 'deleted'),
      )
      .select('a.id')
      .toOperationNode();
    const compiled = compile(node);
    expect(compiled.sql).toContain('where (`p`.`rank` >= ?) and (`p`.`state` != ?)');
    expect(compiled.sql).toContain('on `p`.`author_id` = `a`.`id` and `p`.`tenant` = `a`.`tenant`');
    expect(compiled.parameters).toEqual([3, 'deleted']);
  });

  test('preserves target-only OR, NOT and nested AND boolean grouping', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join =>
        join
          .onRef('p.author_id', '=', 'a.id')
          .on(eb =>
            eb.or([
              eb('p.rank', '>=', 5),
              eb.and([eb('p.state', '=', 'draft'), eb.not(eb('p.published', '=', false))]),
            ]),
          )
          .on('p.deleted_at', 'is', null),
      )
      .select('a.id')
      .toOperationNode();
    const compiled = compile(node);
    expect(compiled.sql).toContain('where (');
    expect(compiled.sql).toContain('`p`.`rank` >= ? or (`p`.`state` = ? and not `p`.`published` = ?)');
    expect(compiled.sql).toContain('and (`p`.`deleted_at` is null)');
    expect(compiled.parameters).toEqual([5, 'draft', false]);
    expect(compiled.sql.split(') as `p` on ')[1]).toBe('`p`.`author_id` = `a`.`id`');
  });

  test('preserves Date and SDK values by identity and follows the new SQL parameter order', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const rank = new Int32(8);
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join =>
        join
          .onRef('p.author_id', '=', 'a.id')
          .on('p.deleted_at', '<=', date)
          .on('p.rank', '=', rank as unknown as number),
      )
      .select([sql.val('projection').as('bound'), 'a.id'])
      .where('a.tenant', '=', 'outer-tenant')
      .toOperationNode();
    const compiled = compile(node);
    expect(compiled.parameters).toEqual(['projection', date, rank, 'outer-tenant']);
    expect(compiled.parameters[1]).toBe(date);
    expect(compiled.parameters[2]).toBe(rank);
  });

  test('leaves the original outer WHERE intact and never places join filters there', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.deleted_at', 'is', null))
      .select('a.id')
      .where('a.enabled', '=', true)
      .toOperationNode();
    const transformed = transform(node);
    expect(transformed.where).toEqual(node.where);
    expect(compile(node).sql).toMatch(/\) as `p` on `p`.`author_id` = `a`.`id` where `a`.`enabled` = \?$/);
    expect(compile(node).parameters).toEqual([true]);
  });

  test('transforms joins inside nested SELECT queries', () => {
    const nested = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.deleted_at', 'is', null))
      .select('a.id');
    const node = db.selectFrom('authors').select('id').where('id', 'in', nested).toOperationNode();
    expect(compile(node).sql).toContain(
      'in (select `a`.`id` from `authors` as `a` left join (select * from `posts` as `p` where `p`.`deleted_at` is null) as `p` on',
    );
  });

  test('keeps pure equijoins unchanged, including RIGHT and FULL joins', () => {
    for (const node of [
      db.selectFrom('authors as a').leftJoin('posts as p', 'p.author_id', 'a.id').select('a.id').toOperationNode(),
      db.selectFrom('authors as a').rightJoin('posts as p', 'p.author_id', 'a.id').select('a.id').toOperationNode(),
      db.selectFrom('authors as a').fullJoin('posts as p', 'p.author_id', 'a.id').select('a.id').toOperationNode(),
    ]) {
      expect(transform(node)).toEqual(node);
    }
  });

  test('keeps a pure equijoin to an already derived target unchanged', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin(db.selectFrom('posts').selectAll().as('p'), 'p.author_id', 'a.id')
      .select('a.id')
      .toOperationNode();
    expect(transform(node)).toEqual(node);
  });

  test('does not mutate the original frozen AST and is idempotent', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.rank', 'in', [1, 2, 3]))
      .select('a.id')
      .toOperationNode();
    const before = plainCompile(node);
    const once = transform(node);
    const twice = transform(once);
    expect(plainCompile(node)).toEqual(before);
    expect(once).not.toBe(node);
    expect(once.joins?.[0]).not.toBe(node.joins?.[0]);
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(once)).toBe(true);
    expect(plainCompile(twice)).toEqual(plainCompile(once));
    expect(compile(node).parameters).toEqual([1, 2, 3]);
  });

  test('moves target-to-target reference comparisons into the target WHERE', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').onRef('p.owner_id', '=', 'p.author_id'))
      .select('a.id')
      .toOperationNode();
    expect(compile(node).sql).toContain('where `p`.`owner_id` = `p`.`author_id`');
    expect(compile(node).sql.split(') as `p` on ')[1]).toBe('`p`.`author_id` = `a`.`id`');
  });

  test('rejects filtered RIGHT and FULL joins without changing outer-join semantics', () => {
    for (const node of [
      db
        .selectFrom('authors as a')
        .rightJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.deleted_at', 'is', null))
        .select('a.id')
        .toOperationNode(),
      db
        .selectFrom('authors as a')
        .fullJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.deleted_at', 'is', null))
        .select('a.id')
        .toOperationNode(),
    ])
      expect(() => transform(node)).toThrow(/RIGHT|FULL/);
  });

  test('rejects cross-alias non-equality and outer-only filters', () => {
    const inequality = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').onRef('p.rank', '>', 'a.rank'))
      .select('a.id')
      .toOperationNode();
    const outer = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('a.enabled', '=', true))
      .select('a.id')
      .toOperationNode();
    expect(() => transform(inequality)).toThrow(/target-local|target-only/);
    expect(() => transform(outer)).toThrow(/target-local|target-only/);
  });

  test('rejects mixed OR containing target and outer references', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join =>
        join.onRef('p.author_id', '=', 'a.id').on(eb => eb.or([eb('p.rank', '>', 2), eb('a.enabled', '=', true)])),
      )
      .select('a.id')
      .toOperationNode();
    expect(() => transform(node)).toThrow(/target-local|target-only/);
  });

  test('rejects schema-qualified target references before deriving a new target scope', () => {
    const node = db
      .withTables<{ 'archive.posts': Database['posts'] }>()
      .selectFrom('authors as a')
      .leftJoin('archive.posts', join =>
        join.onRef('archive.posts.author_id', '=', 'a.id').on('archive.posts.deleted_at', 'is', null),
      )
      .select('a.id')
      .toOperationNode();
    expect(() => transform(node)).toThrow(/simple table alias|schema-qualified/);
  });

  test('rejects unqualified ON references', () => {
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('deleted_at', 'is', null))
      .select('a.id')
      .toOperationNode();
    expect(() => transform(node)).toThrow(/qualified/);
  });

  test('rejects raw ON fragments and operators even when their apparent SQL is target-local', () => {
    const rawPredicate = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on(sql<boolean>`p.deleted_at is null`))
      .select('a.id')
      .toOperationNode();
    const rawOperator = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', sql`=`, 'a.id'))
      .select('a.id')
      .toOperationNode();
    expect(() => transform(rawPredicate)).toThrow(/RawNode|raw/i);
    expect(() => transform(rawOperator)).toThrow(/RawNode|raw/i);
  });

  test('rejects subqueries inside ON instead of moving correlated scopes', () => {
    const subquery = db.selectFrom('authors').select('rank');
    const node = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.rank', 'in', subquery))
      .select('a.id')
      .toOperationNode();
    expect(() => transform(node)).toThrow(/subquer|SelectQueryNode/);
  });

  test('can reuse a transformer after rejecting an unsupported JOIN tree', () => {
    const transformer = new (class extends YdbJoinTransformer {
      get stackDepth(): number {
        return this.nodeStack.length;
      }
    })();
    const rejected = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on(sql<boolean>`p.published`))
      .select('a.id')
      .toOperationNode();
    const valid = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.onRef('p.author_id', '=', 'a.id').on('p.published', '=', true))
      .select('a.id')
      .toOperationNode();
    expect(() => transformer.transformNode(rejected)).toThrow(/raw/i);
    expect(transformer.stackDepth).toBe(0);
    expect(transformer.transformNode(valid)).toEqual(transform(valid));
    expect(transformer.stackDepth).toBe(0);
  });

  test('rejects filtered derived sources and joins without an equijoin key', () => {
    const derived = db
      .selectFrom('authors as a')
      .leftJoin(db.selectFrom('posts').selectAll().as('p'), join =>
        join.onRef('p.author_id', '=', 'a.id').on('p.published', '=', true),
      )
      .select('a.id')
      .toOperationNode();
    const keyless = db
      .selectFrom('authors as a')
      .leftJoin('posts as p', join => join.on('p.published', '=', true))
      .select('a.id')
      .toOperationNode();
    expect(() => transform(derived)).toThrow(/physical table|derived/);
    expect(() => transform(keyless)).toThrow(/equijoin/);
  });
});
