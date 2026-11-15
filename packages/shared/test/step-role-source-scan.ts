import ts from 'typescript';

export interface ReaderSite {
  file: string;
  symbol: string;
  context: string;
  value: string;
  count: number;
}
export interface ReaderPin extends ReaderSite {
  reason: string;
}
const roles = ['08c-code-review', '08c2-code-audit'];

/** Production scope is explicit; tests, fixtures and generated artifacts cannot hide a reader. */
export function isRoleReaderSource(file: string): boolean {
  if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file)) return false;
  if (
    !/^(?:packages\/(?:shared|worker|api|web)\/src\/|(?:modules|external-modules)\/[^/]+\/(?:src\/)?|scripts\/)/.test(
      file,
    )
  )
    return false;
  return !/(?:^|\/)(?:test|tests|__tests__|fixtures|dist|node_modules|generated|\.next|coverage)(?:\/|$)|\.(?:test|spec|generated)\.|\.d\.ts$/.test(
    file,
  );
}
function name(node: ts.Node): string | undefined {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyAssignment(node)
  )
    return node.name?.getText();
  return undefined;
}
function symbol(node: ts.Node): string {
  const parts: string[] = [];
  for (let n: ts.Node | undefined = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    const part = name(n);
    if (part) parts.unshift(part);
    if (ts.isImportDeclaration(n)) parts.unshift('import');
    if (ts.isExportDeclaration(n)) parts.unshift('export');
  }
  return parts.join('.') || '<module>';
}
function context(node: ts.Node): string {
  for (let n = node.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) return n.expression.getText();
    if (ts.isBinaryExpression(n)) return ts.SyntaxKind[n.operatorToken.kind];
    if (ts.isImportDeclaration(n)) return 'import';
  }
  return ts.SyntaxKind[node.parent.kind];
}
const key = (site: ReaderSite) =>
  JSON.stringify([site.file, site.symbol, site.context, site.value]);

/** AST enumeration catches literals in predicates, collections, wrappers and TSX equally.
 * Every use of an imported role table is also pinned, including renamed imports and aliases:
 * it cannot become a back door from a canonical constant into a physical-ID reader. */
export function roleReaderSites(file: string, text: string): ReaderSite[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const aliases = new Set(['STEP_ROLES']);
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const spec of statement.importClause.namedBindings.elements)
        if ((spec.propertyName?.text ?? spec.name.text) === 'STEP_ROLES')
          aliases.add(spec.name.text);
    }
  }
  const roleAliases = new Set<string>();
  const isRoleValue = (node: ts.Node): boolean =>
    (ts.isStringLiteralLike(node) && roles.includes(node.text)) ||
    (ts.isIdentifier(node) && roleAliases.has(node.text)) ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ((ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'STEP_ROLES')));
  function findAliases(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name) && isRoleValue(node.initializer))
        roleAliases.add(node.name.text);
      if (
        ts.isIdentifier(node.name) &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text)
      )
        aliases.add(node.name.text);
      if (
        ts.isObjectBindingPattern(node.name) &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text)
      )
        for (const element of node.name.elements)
          if (ts.isIdentifier(element.name)) roleAliases.add(element.name.text);
    }
    ts.forEachChild(node, findAliases);
  }
  // Two passes cover a forward alias declaration without building a whole TS program.
  findAliases(source);
  findAliases(source);
  const sites = new Map<string, ReaderSite>();
  function visit(node: ts.Node) {
    let value: string | undefined;
    if (
      (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      roles.some((role) => node.text.includes(role))
    )
      value = node.text;
    if (ts.isIdentifier(node) && aliases.has(node.text) && !ts.isImportSpecifier(node.parent))
      value = '@roles';
    if (ts.isIdentifier(node) && roleAliases.has(node.text)) value = '@role-alias:' + node.text;
    if (value !== undefined) {
      const site = { file, symbol: symbol(node), context: context(node), value, count: 1 };
      const existing = sites.get(key(site));
      if (existing) existing.count++;
      else sites.set(key(site), site);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...sites.values()];
}
export function checkRoleReaderPins(sites: ReaderSite[], pins: ReaderPin[]): string[] {
  const actual = new Map(sites.map((site) => [key(site), site]));
  const expected = new Map(pins.map((pin) => [key(pin), pin]));
  const failures: string[] = [];
  if (expected.size !== pins.length) failures.push('duplicate reader pin');
  for (const site of sites) {
    const pin = expected.get(key(site));
    if (!pin || pin.count !== site.count || !pin.reason.trim())
      failures.push(`unapproved reader: ${JSON.stringify(site)}`);
  }
  for (const pin of pins)
    if (!actual.has(key(pin))) failures.push(`stale reader pin: ${JSON.stringify(pin)}`);
  return failures;
}
