import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  CastNode,
  IdentifierNode,
  JoinNode,
  type OperationNode,
  OperationNodeTransformer,
  OperatorNode,
  OrNode,
  ParensNode,
  PrimitiveValueListNode,
  type QueryId,
  QueryNode,
  ReferenceNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  TupleNode,
  UnaryOperationNode,
  ValueListNode,
  ValueNode,
} from 'kysely';

interface Target {
  table: TableNode;
  alias: string;
  aliased: boolean;
}

/** Moves qualified target-local JOIN filters into a derived target before YQL compilation. */
export class YdbJoinTransformer extends OperationNodeTransformer {
  override transformNode<T extends OperationNode | undefined>(node: T, queryId?: QueryId): T {
    const depth = this.nodeStack.length;
    try {
      return super.transformNode(node, queryId);
    } finally {
      // The base transformer does not unwind its node stack when an override rejects a tree.
      // A compiler may reuse this transformer after an unsupported query.
      this.nodeStack.length = depth;
    }
  }

  protected override transformJoin(node: JoinNode, queryId?: QueryId): JoinNode {
    const joined = super.transformJoin(node, queryId);
    if (!joined.on) return joined;

    const keys: OperationNode[] = [];
    const filters: OperationNode[] = [];
    for (const conjunct of this.conjuncts(joined.on.on)) {
      if (this.isEquijoin(conjunct)) keys.push(this.unparenthesize(conjunct));
      else filters.push(conjunct);
    }
    if (!filters.length) return joined;
    if (joined.joinType === 'RightJoin' || joined.joinType === 'FullJoin') {
      throw new Error(
        'YDB filtered RIGHT and FULL JOIN predicates cannot be pushed down without changing outer-join semantics.',
      );
    }
    if (joined.joinType !== 'LeftJoin' && joined.joinType !== 'InnerJoin') {
      throw new Error(`YDB filtered ${joined.joinType} is not supported by the JOIN transformer.`);
    }

    const target = this.target(joined.table);
    for (const predicate of filters) {
      if (!this.isTargetLocal(predicate, target)) {
        throw new Error(
          'YDB JOIN ON filters must be target-local; cross-source predicates and mixed OR conditions are unsupported.',
        );
      }
    }
    if (!keys.length) throw new Error('YDB JOIN ON requires a qualified reference-to-reference equijoin key.');
    for (const key of keys) {
      const comparison = key as BinaryOperationNode;
      if (
        this.isTargetReference(comparison.leftOperand as ReferenceNode, target) ===
        this.isTargetReference(comparison.rightOperand as ReferenceNode, target)
      ) {
        throw new Error('YDB filtered JOIN equijoin keys must connect the target to another source.');
      }
    }

    const inner = QueryNode.cloneWithWhere(
      SelectQueryNode.cloneWithSelections(
        SelectQueryNode.createFrom([AliasNode.create(target.table, IdentifierNode.create(target.alias))]),
        [SelectionNode.createSelectAll()],
      ),
      this.and(filters, true),
    );
    return JoinNode.createWithOn(
      joined.joinType,
      AliasNode.create(inner, IdentifierNode.create(target.alias)),
      this.and(keys),
    );
  }

  private conjuncts(node: OperationNode): OperationNode[] {
    const unwrapped = this.unparenthesize(node);
    return AndNode.is(unwrapped) ? [...this.conjuncts(unwrapped.left), ...this.conjuncts(unwrapped.right)] : [node];
  }

  private unparenthesize(node: OperationNode): OperationNode {
    while (ParensNode.is(node)) node = node.node;
    return node;
  }

  private isEquijoin(node: OperationNode): boolean {
    node = this.unparenthesize(node);
    if (
      !BinaryOperationNode.is(node) ||
      !OperatorNode.is(node.operator) ||
      !['=', '=='].includes(node.operator.operator) ||
      !ReferenceNode.is(node.leftOperand) ||
      !ReferenceNode.is(node.rightOperand)
    )
      return false;
    const left = node.leftOperand;
    const right = node.rightOperand;
    if (!left.table || !right.table || left.column.kind !== 'ColumnNode' || right.column.kind !== 'ColumnNode')
      return false;
    return (
      left.table.table.identifier.name !== right.table.table.identifier.name ||
      left.table.table.schema?.name !== right.table.table.schema?.name
    );
  }

  private target(node: OperationNode): Target {
    if (TableNode.is(node)) return { table: node, alias: node.table.identifier.name, aliased: false };
    if (AliasNode.is(node) && TableNode.is(node.node) && IdentifierNode.is(node.alias)) {
      return { table: node.node, alias: node.alias.name, aliased: true };
    }
    throw new Error(
      'YDB filtered JOIN pushdown requires a physical table target with a simple alias; derived and raw sources are unsupported.',
    );
  }

  private isTargetReference(node: ReferenceNode, target: Target): boolean {
    if (!node.table || node.column.kind !== 'ColumnNode') {
      throw new Error('YDB JOIN ON references must be qualified column references.');
    }
    if (
      !target.aliased &&
      node.table.table.identifier.name === target.alias &&
      node.table.table.schema &&
      node.table.table.schema.name === target.table.table.schema?.name
    ) {
      throw new Error(
        'YDB filtered JOIN target columns must use a simple table alias instead of a schema-qualified reference.',
      );
    }
    return node.table.table.identifier.name === target.alias && !node.table.table.schema;
  }

  private isTargetLocal(node: OperationNode, target: Target): boolean {
    if (ReferenceNode.is(node)) return this.isTargetReference(node, target);
    // Do not descend into bound values: SDK values, Date instances and lists are opaque data.
    if (ValueNode.is(node) || PrimitiveValueListNode.is(node)) return true;
    if (ParensNode.is(node)) return this.isTargetLocal(node.node, target);
    if (AndNode.is(node) || OrNode.is(node)) {
      const left = this.isTargetLocal(node.left, target);
      const right = this.isTargetLocal(node.right, target);
      return left && right;
    }
    if (BinaryOperationNode.is(node)) {
      this.validateOperator(node.operator);
      const left = this.isTargetLocal(node.leftOperand, target);
      const right = this.isTargetLocal(node.rightOperand, target);
      return left && right;
    }
    if (UnaryOperationNode.is(node)) {
      this.validateOperator(node.operator);
      if (!['not', '-'].includes((node.operator as OperatorNode).operator)) {
        throw new Error('YDB JOIN ON supports target-local NOT and arithmetic negation, not subquery predicates.');
      }
      return this.isTargetLocal(node.operand, target);
    }
    if (ValueListNode.is(node) || TupleNode.is(node)) {
      return node.values.map(value => this.isTargetLocal(value, target)).every(Boolean);
    }
    if (CastNode.is(node)) {
      if (node.dataType.kind !== 'DataTypeNode') this.unsupported(node.dataType);
      return this.isTargetLocal(node.expression, target);
    }
    return this.unsupported(node);
  }

  private validateOperator(node: OperationNode): void {
    if (!OperatorNode.is(node)) this.unsupported(node);
  }

  private unsupported(node: OperationNode): never {
    if (node.kind === 'RawNode')
      throw new Error('Raw SQL fragments and operators are unsupported in YDB JOIN ON predicates.');
    if (node.kind.endsWith('QueryNode'))
      throw new Error(`Subqueries (${node.kind}) are unsupported inside YDB JOIN ON predicates.`);
    throw new Error(`Unsupported ${node.kind} in a YDB JOIN ON target-local predicate.`);
  }

  private and(nodes: OperationNode[], group = false): OperationNode {
    return nodes
      .slice(1)
      .reduce(
        (left, right) =>
          AndNode.create(group ? ParensNode.create(left) : left, group ? ParensNode.create(right) : right),
        nodes[0],
      );
  }
}
