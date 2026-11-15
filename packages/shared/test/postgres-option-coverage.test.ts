import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as guard from '../src/egress/user-postgres-dsn.js';

/** Include selectors consumed before sql.options is returned (notably certificate files).
 * Use syntax nodes so comments and formatting do not change the inventory. */
function parsedKeys(source: string, options: object): string[] {
  const keys = new Set(Object.keys(options));
  const tree = ts.createSourceFile(
    'postgres.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'query'
    ) {
      keys.add(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'query' &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      keys.add(node.argumentExpression.text);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === 'query'
    ) {
      for (const element of node.name.elements)
        keys.add((element.propertyName ?? element.name).getText(tree));
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === 'searchParams'
    ) {
      const key = node.arguments[0];
      if (key && ts.isStringLiteral(key)) keys.add(key.text);
    }
    ts.forEachChild(node, visit);
  };
  const start = tree.statements.findIndex(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'parseOptions',
  );
  expect(
    start,
    'The installed driver must still expose the parser reviewed by this control',
  ).toBeGreaterThanOrEqual(0);
  for (const statement of tree.statements.slice(start)) visit(statement);
  return [...keys].sort();
}

it('requires a guard review when the installed postgres.js parser adds an option', async () => {
  // Resolve the installed ESM parser; the version is diagnostic, while its option inventory is the review gate.
  const entry = new URL(import.meta.resolve('postgres'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', entry), 'utf8')) as {
    version: string;
  };
  const source = await readFile(entry, 'utf8');
  const dsn = `postgres://user:${randomBytes(12).toString('hex')}@db.invalid/store`;
  const pg = postgres(dsn, { max: 1 });
  try {
    const keys = parsedKeys(source, pg.options);
    expect(keys, `Review the user DSN guard against postgres.js ${manifest.version}`).toEqual(
      guard.USER_POSTGRES_DSN_KNOWN_OPTIONS,
    );
    expect(keys).toEqual(
      expect.arrayContaining(['sslrootcert', 'sslcert', 'sslkey', 'sslmode', 'host']),
    );
    // A future file selector can be consumed and deleted without appearing in sql.options.
    const future = parsedKeys(
      source +
        '\nfunction certificates(query) { const { sslcrl } = query; return fs.readFileSync(sslcrl) }',
      pg.options,
    );
    expect(future.filter((key) => !keys.includes(key))).toEqual(['sslcrl']);
    expect(future).not.toEqual(guard.USER_POSTGRES_DSN_KNOWN_OPTIONS);
  } finally {
    await pg.end({ timeout: 0 });
  }
});
