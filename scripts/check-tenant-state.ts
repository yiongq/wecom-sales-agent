// 05 R5：模块级状态默认拒绝，只做语法分析，不加载或执行 src 模块。
// 用法：tsx scripts/check-tenant-state.ts [--report] [仓库根目录（夹具用）]。
// 第 5 步只接自测；第 11 步填清单后再接 pnpm lint。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

interface Binding {
  key: string;
  location: string;
  name: string;
  what: string;
}

type Entry = { kind: 'tenant'; state: string } | { kind: 'instance'; why: string } | { kind: 'object-keyed' };

const MANIFEST = 'src/tenancy/state-manifest.ts';
const args = process.argv.slice(2);
const report = args.includes('--report');
const roots = args.filter((arg) => arg !== '--report');
if (roots.length > 1 || roots.some((arg) => arg.startsWith('--'))) {
  console.error('tenant-state: 用法：check-tenant-state.ts [--report] [仓库根目录]');
  process.exit(1);
}
if (roots[0]) process.chdir(roots[0]);

function filesIn(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesIn(file);
    return entry.isFile() && /\.tsx?$/.test(file) && !/\.selftest\.tsx?$/.test(file) ? [file] : [];
  });
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function primitiveLiteral(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  return (
    ts.isStringLiteralLike(value) ||
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isRegularExpressionLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === 'undefined') ||
    (ts.isPrefixUnaryExpression(value) &&
      (value.operator === ts.SyntaxKind.PlusToken || value.operator === ts.SyntaxKind.MinusToken) &&
      (ts.isNumericLiteral(value.operand) || ts.isBigIntLiteral(value.operand)))
  );
}

// 只豁免字面量语法；对调用结果或标识符加断言 / freeze 不扩大豁免。
function literal(expression: ts.Expression): boolean {
  const value = unwrap(expression);
  return primitiveLiteral(value) || ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value);
}

function frozenArgument(expression: ts.Expression): ts.Expression | undefined {
  const value = unwrap(expression);
  if (
    ts.isCallExpression(value) &&
    ts.isPropertyAccessExpression(value.expression) &&
    ts.isIdentifier(value.expression.expression) &&
    value.expression.expression.text === 'Object' &&
    value.expression.name.text === 'freeze' &&
    value.arguments.length === 1
  ) {
    return value.arguments[0];
  }
  return undefined;
}

function immutableLiteral(expression: ts.Expression): ts.Expression | undefined {
  if (ts.isRegularExpressionLiteral(unwrap(expression))) return expression;
  const frozen = frozenArgument(expression);
  if (frozen && literal(frozen)) return frozen;
  let value = expression;
  while (
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    if (ts.isAsExpression(value) && ts.isTypeReferenceNode(value.type) && value.type.typeName.getText() === 'const') {
      return literal(value.expression) ? value.expression : undefined;
    }
    value = value.expression;
  }
  return undefined;
}

interface BoundName {
  name: ts.Identifier;
  access: (string | ts.Expression)[];
  defaults: { depth: number; expression: ts.Expression }[];
}

function namesOf(name: ts.BindingName, access: BoundName['access'] = [], defaults: BoundName['defaults'] = []): BoundName[] {
  if (ts.isIdentifier(name)) return [{ name, access, defaults }];
  return name.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    const property = element.propertyName;
    const key = element.dotDotDotToken
      ? '*'
      : ts.isArrayBindingPattern(name)
        ? String(index)
        : property
          ? ts.isComputedPropertyName(property)
            ? property.expression
            : propertyName(property)
          : element.name.getText();
    return namesOf(
      element.name,
      [...access, key ?? '*'],
      element.initializer ? [...defaults, { depth: access.length + 1, expression: element.initializer }] : defaults,
    );
  });
}

type Primitive = string | number | boolean | bigint | null | undefined;
type Value =
  | { kind: 'primitive'; value: Primitive }
  | { kind: 'safe'; literal?: ts.Expression; source?: ts.SourceFile; module?: string }
  | { kind: 'state' };

interface Definition {
  source: ts.SourceFile;
  name: ts.Identifier;
  kind: 'const' | 'let' | 'var' | 'namespace';
  declaration?: ts.VariableDeclaration;
  access: BoundName['access'];
  defaults: BoundName['defaults'];
}

interface Imported {
  file: string | undefined;
  exported: string;
}

// 只沿语法树求原始值和绑定关系：不执行调用、不 import src、不创建类型检查器。
class Values {
  definitions = new Map<string, Definition[]>();
  private locals = new Map<string, Map<string, Definition | Value | Imported>>();
  private exports = new Map<string, Map<string, ts.Expression | Imported>>();
  private stars = new Map<string, string[]>();
  private cache = new Map<string, Value>();
  private visiting = new Set<string>();
  private sourceMap: Map<string, ts.SourceFile>;

  constructor(sources: ts.SourceFile[]) {
    this.sourceMap = new Map(sources.map((source) => [source.fileName, source]));
    for (const source of sources) this.index(source);
  }

  private target(source: ts.SourceFile, module: ts.Expression): string | undefined {
    if (!ts.isStringLiteralLike(module) || !module.text.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(source.fileName), module.text));
    const stem = base.replace(/\.js$/, '');
    return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((file) => this.sourceMap.has(file));
  }

  private index(source: ts.SourceFile): void {
    const local = new Map<string, Definition | Value | Imported>();
    const exports = new Map<string, ts.Expression | Imported>();
    const definitions: Definition[] = [];
    this.locals.set(source.fileName, local);
    this.exports.set(source.fileName, exports);
    this.definitions.set(source.fileName, definitions);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
      if (ts.isModuleDeclaration(node)) {
        if (node.parent === source && ts.isIdentifier(node.name) && !(node.flags & ts.NodeFlags.GlobalAugmentation)) {
          const definition: Definition = { source, name: node.name, kind: 'namespace', access: [], defaults: [] };
          definitions.push(definition);
          local.set(node.name.text, definition);
        }
        return;
      }
      if (ts.isVariableDeclarationList(node)) {
        const kind = node.flags & ts.NodeFlags.Const ? 'const' : node.flags & ts.NodeFlags.Let ? 'let' : 'var';
        const topLevel = ts.isVariableStatement(node.parent) && node.parent.parent === source;
        if (!topLevel && kind !== 'var') return;
        for (const declaration of node.declarations) {
          for (const bound of namesOf(declaration.name)) {
            const definition: Definition = { source, kind, declaration, ...bound };
            definitions.push(definition);
            local.set(bound.name.text, definition);
            if (
              topLevel &&
              ts.isVariableStatement(node.parent) &&
              node.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
            ) {
              exports.set(bound.name.text, { file: source.fileName, exported: bound.name.text });
            }
          }
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
        if (statement.name) local.set(statement.name.text, { kind: 'safe' });
        if (statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          const name = statement.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text;
          if (name) exports.set(name, statement.name ?? { file: undefined, exported: 'default' });
        }
      } else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const file = this.target(source, statement.moduleSpecifier);
        const clause = statement.importClause;
        if (clause.name) local.set(clause.name.text, { file, exported: 'default' });
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          local.set(clause.namedBindings.name.text, { kind: 'safe', module: file });
        } else if (clause.namedBindings) {
          for (const item of clause.namedBindings.elements)
            local.set(item.name.text, { file, exported: item.propertyName?.text ?? item.name.text });
        }
      } else if (ts.isImportEqualsDeclaration(statement)) {
        local.set(statement.name.text, { kind: 'safe' });
      } else if (ts.isExportAssignment(statement)) {
        exports.set('default', statement.expression);
      } else if (ts.isExportDeclaration(statement)) {
        const file = statement.moduleSpecifier ? this.target(source, statement.moduleSpecifier) : source.fileName;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements)
            exports.set(item.name.text, { file, exported: item.propertyName?.text ?? item.name.text });
        } else if (file && !statement.exportClause) {
          this.stars.set(source.fileName, [...(this.stars.get(source.fileName) ?? []), file]);
        }
      }
    }
  }

  private guarded(key: string, compute: () => Value): Value {
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.visiting.has(key)) return { kind: 'state' };
    this.visiting.add(key);
    const value = compute();
    this.visiting.delete(key);
    this.cache.set(key, value);
    return value;
  }

  private exported(file: string, name: string): Value {
    return this.guarded(`export:${file}:${name}`, () => {
      const item = this.exports.get(file)?.get(name);
      if (item) {
        if ('file' in item)
          return !item.file
            ? { kind: 'safe' }
            : item.file === file
              ? this.named(file, item.exported)
              : this.exported(item.file, item.exported);
        return this.expression(item, this.sourceMap.get(file)!);
      }
      for (const target of this.stars.get(file) ?? []) {
        // 循环转出默认拒绝；找不到的内部出口也不能借 import 变成豁免。
        if (this.exports.get(target)?.has(name) || this.stars.has(target)) {
          const value = this.exported(target, name);
          if (value.kind !== 'state') return value;
        }
      }
      return { kind: 'state' };
    });
  }

  private named(file: string, name: string): Value {
    return this.guarded(`${file}:${name}`, () => {
      const definition = this.locals.get(file)?.get(name);
      if (definition) {
        if ('kind' in definition && (definition.kind === 'safe' || definition.kind === 'primitive' || definition.kind === 'state'))
          return definition;
        if ('exported' in definition) return definition.file ? this.exported(definition.file, definition.exported) : { kind: 'safe' };
        if (definition.kind !== 'const' || !definition.declaration?.initializer) return { kind: 'state' };
        let value = this.expression(definition.declaration.initializer, definition.source);
        for (const [index, access] of definition.access.entries()) {
          const key =
            typeof access === 'string' ? { kind: 'primitive' as const, value: access } : this.expression(access, definition.source);
          value = key.kind === 'primitive' ? this.member(value, String(key.value)) : { kind: 'state' };
          for (const fallback of definition.defaults.filter((item) => item.depth === index + 1)) {
            const alternative = this.expression(fallback.expression, definition.source);
            if (alternative.kind === 'state') return alternative;
            if (value.kind === 'primitive' && value.value === undefined) value = alternative;
          }
        }
        return value;
      }
      if (name === 'undefined') return { kind: 'primitive', value: undefined };
      if (name === 'NaN') return { kind: 'primitive', value: NaN };
      if (name === 'Infinity') return { kind: 'primitive', value: Infinity };
      // 内建函数 / 类本身按 R5 放行；process 等可变全局不在此列。
      if (
        [
          'Object',
          'Array',
          'Date',
          'RegExp',
          'Map',
          'Set',
          'WeakMap',
          'WeakSet',
          'Promise',
          'Error',
          'Number',
          'String',
          'Boolean',
          'BigInt',
          'Symbol',
          'Math',
          'JSON',
          'Reflect',
        ].includes(name)
      )
        return { kind: 'safe' };
      return { kind: 'state' };
    });
  }

  private member(owner: Value, key: string): Value {
    if (owner.kind === 'state') return owner;
    if (owner.kind === 'primitive') {
      if (key === 'length' && typeof owner.value === 'string') return { kind: 'primitive', value: owner.value.length };
      return { kind: 'safe' };
    }
    if (owner.module) return this.exported(owner.module, key);
    if (owner.literal && owner.source) {
      const literal = unwrap(owner.literal);
      if (key === '*') return { kind: 'safe' }; // 解构 rest 跟随源绑定，不当成某个已知原始值。
      if (ts.isArrayLiteralExpression(literal) && literal.elements.some(ts.isSpreadElement)) return { kind: 'safe' };
      if (key === 'length' && ts.isArrayLiteralExpression(literal)) return { kind: 'primitive', value: literal.elements.length };
      const element = ts.isArrayLiteralExpression(literal)
        ? literal.elements[Number(key)]
        : ts.isObjectLiteralExpression(literal)
          ? literal.properties.find((item) => item.name && propertyName(item.name) === key)
          : undefined;
      const expression =
        element && ts.isPropertyAssignment(element) ? element.initializer : element && ts.isExpression(element) ? element : undefined;
      if (expression) {
        const value = this.expression(expression, owner.source);
        if (value.kind !== 'state') return value;
        if (ts.isArrayLiteralExpression(unwrap(expression)) || ts.isObjectLiteralExpression(unwrap(expression))) {
          return { kind: 'safe', literal: expression, source: owner.source };
        }
      }
      if (element && ts.isShorthandPropertyAssignment(element)) {
        const value = this.named(owner.source.fileName, element.name.text);
        if (value.kind !== 'state') return value;
      }
      if (!element && (ts.isArrayLiteralExpression(literal) || ts.isObjectLiteralExpression(literal))) {
        const uncertain =
          ts.isObjectLiteralExpression(literal) &&
          literal.properties.some((item) => ts.isSpreadAssignment(item) || (item.name && ts.isComputedPropertyName(item.name)));
        if (!uncertain && (ts.isObjectLiteralExpression(literal) || /^\d+$/.test(key))) return { kind: 'primitive', value: undefined };
      }
    }
    // 按被引用者判断：已豁免的字面量 / 函数 / 外部 import 的成员仍放行。
    return { kind: 'safe' };
  }

  expression(expression: ts.Expression, source: ts.SourceFile): Value {
    const node = unwrap(expression);
    if (ts.isStringLiteralLike(node)) return { kind: 'primitive', value: node.text };
    if (ts.isNumericLiteral(node)) return { kind: 'primitive', value: Number(node.text) };
    if (ts.isBigIntLiteral(node)) return { kind: 'primitive', value: BigInt(node.text.replace(/_/g, '').slice(0, -1)) };
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
      return { kind: 'primitive', value: node.kind === ts.SyntaxKind.TrueKeyword };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'primitive', value: null };
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { kind: 'safe' };
    if (frozenArgument(expression) && this.locals.get(source.fileName)?.has('Object')) return { kind: 'state' };
    const immutable = immutableLiteral(expression);
    if (immutable) {
      const literalValue = unwrap(immutable);
      if (
        !ts.isRegularExpressionLiteral(literalValue) &&
        !ts.isArrayLiteralExpression(literalValue) &&
        !ts.isObjectLiteralExpression(literalValue)
      ) {
        const value = this.expression(literalValue, source);
        return value.kind === 'primitive' ? value : { kind: 'state' };
      }
      return { kind: 'safe', literal: immutable, source };
    }
    if (ts.isIdentifier(node)) return this.named(source.fileName, node.text);
    if (ts.isPropertyAccessExpression(node)) return this.member(this.expression(node.expression, source), node.name.text);
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const index = this.expression(node.argumentExpression, source);
      return index.kind === 'primitive' ? this.member(this.expression(node.expression, source), String(index.value)) : { kind: 'state' };
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = this.expression(span.expression, source);
        if (value.kind !== 'primitive') return { kind: 'state' };
        text += String(value.value) + span.literal.text;
      }
      return { kind: 'primitive', value: text };
    }
    if (ts.isConditionalExpression(node)) {
      const condition = this.expression(node.condition, source);
      const yes = this.expression(node.whenTrue, source);
      const no = this.expression(node.whenFalse, source);
      return condition.kind === 'primitive' && yes.kind === 'primitive' && no.kind === 'primitive'
        ? condition.value
          ? yes
          : no
        : { kind: 'state' };
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) {
      const operand = this.expression(ts.isPrefixUnaryExpression(node) ? node.operand : node.expression, source);
      if (operand.kind !== 'primitive') return { kind: 'state' };
      try {
        if (ts.isTypeOfExpression(node)) return { kind: 'primitive', value: typeof operand.value };
        if (ts.isVoidExpression(node)) return { kind: 'primitive', value: undefined };
        const value = operand.value as number;
        switch (node.operator) {
          case ts.SyntaxKind.PlusToken:
            return { kind: 'primitive', value: +value };
          case ts.SyntaxKind.MinusToken:
            return { kind: 'primitive', value: -value };
          case ts.SyntaxKind.ExclamationToken:
            return { kind: 'primitive', value: !value };
          case ts.SyntaxKind.TildeToken:
            return { kind: 'primitive', value: ~value };
        }
      } catch {
        /* 非法 bigint 混算等不放行。 */
      }
    }
    if (ts.isBinaryExpression(node)) {
      const left = this.expression(node.left, source);
      const right = this.expression(node.right, source);
      if (left.kind !== 'primitive' || right.kind !== 'primitive') return { kind: 'state' };
      try {
        // 断言只供 TS 统一运算符的类型；运行时仍保留 string / bigint 等原始类型。
        const l = left.value as number;
        const r = right.value as number;
        let value: Primitive;
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken:
            value = l + r;
            break;
          case ts.SyntaxKind.MinusToken:
            value = l - r;
            break;
          case ts.SyntaxKind.AsteriskToken:
            value = l * r;
            break;
          case ts.SyntaxKind.SlashToken:
            value = l / r;
            break;
          case ts.SyntaxKind.PercentToken:
            value = l % r;
            break;
          case ts.SyntaxKind.AsteriskAsteriskToken:
            value = l ** r;
            break;
          case ts.SyntaxKind.LessThanLessThanToken:
            value = l << r;
            break;
          case ts.SyntaxKind.GreaterThanGreaterThanToken:
            value = l >> r;
            break;
          case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
            value = l >>> r;
            break;
          case ts.SyntaxKind.AmpersandToken:
            value = l & r;
            break;
          case ts.SyntaxKind.BarToken:
            value = l | r;
            break;
          case ts.SyntaxKind.CaretToken:
            value = l ^ r;
            break;
          case ts.SyntaxKind.LessThanToken:
            value = l < r;
            break;
          case ts.SyntaxKind.LessThanEqualsToken:
            value = l <= r;
            break;
          case ts.SyntaxKind.GreaterThanToken:
            value = l > r;
            break;
          case ts.SyntaxKind.GreaterThanEqualsToken:
            value = l >= r;
            break;
          case ts.SyntaxKind.EqualsEqualsToken:
            value = l == r;
            break;
          case ts.SyntaxKind.ExclamationEqualsToken:
            value = l != r;
            break;
          case ts.SyntaxKind.EqualsEqualsEqualsToken:
            value = left.value === right.value;
            break;
          case ts.SyntaxKind.ExclamationEqualsEqualsToken:
            value = left.value !== right.value;
            break;
          case ts.SyntaxKind.AmpersandAmpersandToken:
            value = left.value && right.value;
            break;
          case ts.SyntaxKind.BarBarToken:
            value = left.value || right.value;
            break;
          case ts.SyntaxKind.QuestionQuestionToken:
            value = left.value ?? right.value;
            break;
          case ts.SyntaxKind.CommaToken:
            value = right.value;
            break;
          default:
            return { kind: 'state' };
        }
        return { kind: 'primitive', value };
      } catch {
        /* 不执行调用；纯运算抛错时默认拒绝。 */
      }
    }
    return { kind: 'state' };
  }

  required(definition: Definition): boolean {
    return this.named(definition.source.fileName, definition.name.text).kind === 'state';
  }
}

function position(source: ts.SourceFile, node: ts.Node): string {
  return `${source.fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
}

function description(declaration: ts.VariableDeclaration, kind: string, source: ts.SourceFile): string {
  if (!declaration.initializer) return `${kind} / 无初始值`;
  const value = unwrap(declaration.initializer);
  if (ts.isArrayLiteralExpression(value)) return `${kind} / 数组字面量`;
  if (ts.isObjectLiteralExpression(value)) return `${kind} / 对象字面量`;
  if (ts.isNewExpression(value)) return `${kind} / new ${value.expression.getText(source).replace(/\s+/g, ' ')}`;
  if (ts.isCallExpression(value)) return `${kind} / 调用 ${value.expression.getText(source).replace(/\s+/g, ' ').slice(0, 100)}`;
  return `${kind} / ${ts.SyntaxKind[value.kind]}`;
}

function bindingsOf(source: ts.SourceFile, values: Values): Binding[] {
  return (values.definitions.get(source.fileName) ?? [])
    .filter((definition) => values.required(definition))
    .map((definition) => {
      const { name, declaration, kind } = definition;
      const initializer = declaration?.initializer && unwrap(declaration.initializer);
      const alias =
        initializer &&
        (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer));
      return {
        key: `${source.fileName}:${name.text}`,
        location: position(source, name),
        name: name.text,
        what: alias
          ? `${kind} / 别名 ${initializer.getText(source).replace(/\s+/g, ' ').slice(0, 100)}`
          : declaration
            ? description(declaration, kind, source)
            : 'namespace / 模块对象',
      };
    });
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function properties(object: ts.ObjectLiteralExpression, source: ts.SourceFile, errors: string[]): Map<string, ts.Expression> {
  const values = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    const name = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined;
    if (name === undefined || !ts.isPropertyAssignment(property)) {
      errors.push(`${position(source, property)} 清单必须是静态属性赋值`);
    } else if (values.has(name)) {
      errors.push(`${position(source, property)} 清单属性 ${name} 重复`);
    } else {
      values.set(name, property.initializer);
    }
  }
  return values;
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function readManifest(source: ts.SourceFile | undefined, errors: string[]): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  const declarations = source?.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'STATE_MANIFEST',
        )
      : [],
  );
  if (!source || declarations?.length !== 1 || !declarations[0].initializer) {
    errors.push(`${MANIFEST}:1 缺少唯一的 STATE_MANIFEST 对象字面量`);
    return entries;
  }
  const initializer = declarations[0].initializer;
  const object = unwrap(frozenArgument(initializer) ?? initializer);
  if (!ts.isObjectLiteralExpression(object)) {
    errors.push(`${position(source, object)} STATE_MANIFEST 必须是对象字面量`);
    return entries;
  }
  for (const [key, expression] of properties(object, source, errors)) {
    const value = unwrap(expression);
    if (
      !/^src\/.+\.tsx?:[^:]+$/.test(key) ||
      path.posix.normalize(key.split(':')[0]) !== key.split(':')[0] ||
      !ts.isObjectLiteralExpression(value)
    ) {
      errors.push(`${position(source, expression)} 无效清单条目 ${key}`);
      continue;
    }
    const fields = properties(value, source, errors);
    const kind = stringValue(fields.get('kind'));
    const state = stringValue(fields.get('state'));
    const why = stringValue(fields.get('why'));
    if (kind === 'tenant' && state?.trim()) entries.set(key, { kind, state });
    else if (kind === 'instance' && why?.trim()) entries.set(key, { kind, why });
    else if (kind === 'object-keyed') entries.set(key, { kind });
    else errors.push(`${position(source, expression)} 无效清单分类 ${key}（tenant 要有 state，instance 要有 why）`);
  }
  return entries;
}

function registrationsOf(source: ts.SourceFile): Map<string, string[]> {
  const registrations = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'registerTenantState' &&
      node.arguments[0]
    ) {
      const argument = unwrap(node.arguments[0]);
      if (ts.isObjectLiteralExpression(argument)) {
        const property = argument.properties.find((item) => ts.isPropertyAssignment(item) && propertyName(item.name) === 'name');
        const name = property && ts.isPropertyAssignment(property) ? stringValue(property.initializer) : undefined;
        if (name !== undefined) registrations.set(name, [...(registrations.get(name) ?? []), position(source, node)]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return registrations;
}

const files = filesIn('src').toSorted();
const sources = files.map((file) =>
  ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  ),
);
const errors: string[] = [];
for (const source of sources) {
  // createSourceFile 不做类型检查；语法损坏不能被当成检查通过。
  for (const diagnostic of (source as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) {
    errors.push(
      `${source.fileName}:${source.getLineAndCharacterOfPosition(diagnostic.start).line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
}
const values = new Values(sources);
const bindings = sources.flatMap((source) => bindingsOf(source, values));
if (report) {
  for (const binding of bindings) console.log(`  ${binding.location} ${binding.name} ${binding.what}`);
  console.log(`tenant-state: 扫描 ${files.length} 个文件，需登记 ${bindings.length} 个绑定（report）`);
} else {
  const entries = readManifest(
    sources.find((source) => source.fileName === MANIFEST),
    errors,
  );
  const keys = new Set(bindings.map((binding) => binding.key));
  for (const binding of bindings) {
    if (!entries.has(binding.key)) errors.push(`${binding.location} ${binding.name} ${binding.what} 未登记`);
  }
  for (const key of entries.keys()) {
    if (!keys.has(key)) errors.push(`${MANIFEST}:1 陈旧条目 ${key}（已无需要登记的绑定）`);
  }
  const registrations = new Map<string, string[]>();
  for (const source of sources) {
    for (const [name, locations] of registrationsOf(source)) {
      registrations.set(name, [...(registrations.get(name) ?? []), ...locations]);
    }
  }
  for (const [name, locations] of registrations) {
    if (locations.length > 1) errors.push(`${locations.join('、')} state ${name} 重复登记（${locations.length} 次）`);
  }
  // 多个模块绑定可以由同一项租户登记覆盖；同名缺登记只报一次。
  const tenantNames = new Set([...entries.values()].flatMap((entry) => (entry.kind === 'tenant' ? [entry.state] : [])));
  for (const name of tenantNames) {
    if (!registrations.has(name)) errors.push(`${MANIFEST}:1 tenant state ${name} 缺少 registerTenantState 登记`);
  }
  if (!errors.length)
    console.log(`tenant-state: 扫描 ${files.length} 个文件，需登记 ${bindings.length} 个绑定，清单 ${entries.size} 个条目，通过`);
}
if (errors.length) {
  console.error(`tenant-state: ${errors.length} 项错误：`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
