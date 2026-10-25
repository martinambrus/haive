import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../src');
// Each exception has a role policy exercised by the route sweep or a conditional feature.
const EXEMPT: Record<string, string> = {
  'middleware/auth.ts': 'sets the database role and defines requireAdmin, discovered by the sweep',
  'middleware/maintenance.ts': 'lets administrators through maintenance, never grants route access',
  'modules/loader.ts': 'module admin gates use requireAdmin; module settings paths are swept',
  'routes/admin.ts': 'self-demotion protection inside the swept admin router',
  'routes/global-kb.ts':
    'conditional enforcement controls; admin-only routes use requireAdmin and are swept',
  'routes/tasks/index.ts': 'allUsers policy is named in the sweep; pause controls are conditional',
  'routes/tasks/_helpers.ts': 'administrator pause-lock override, not an admin-only route',
  'lib/probe-egress.ts': 'administrator network policy is covered by probe-targets tests',
  'lib/probe-hosts.ts': 'selects the network policy, not route authorization',
};
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

function hasRoleCheck(text: string): boolean {
  const file = ts.createSourceFile('policy.ts', text, ts.ScriptTarget.Latest, true);
  const equalities = new Set([
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ]);
  const admin = (n: ts.Node) => ts.isStringLiteralLike(n) && n.text === 'admin';
  const role = (n: ts.Node): boolean =>
    (ts.isIdentifier(n) && /role/i.test(n.text)) ||
    (ts.isStringLiteralLike(n) && /role/i.test(n.text)) ||
    !!ts.forEachChild(n, role);
  const visit = (n: ts.Node): boolean => {
    if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === 'userRole') return true;
    if (
      ts.isBinaryExpression(n) &&
      equalities.has(n.operatorToken.kind) &&
      ((admin(n.left) && role(n.right)) || (admin(n.right) && role(n.left)))
    )
      return true;
    return !!ts.forEachChild(n, visit);
  };
  return visit(file);
}

function verdict(files: Array<{ name: string; text: string }>) {
  const checks = files.filter((f) => hasRoleCheck(f.text));
  return {
    unlistedRoleChecks: checks
      .filter((f) => !(f.name in EXEMPT))
      .map((f) => f.name)
      .sort(),
    staleExemptions: Object.keys(EXEMPT).filter((name) => !checks.some((f) => f.name === name)),
  };
}

describe('admin role policy cannot silently escape the non-admin route sweep', () => {
  it('lists every API source file that reads userRole or compares a role with admin', () => {
    const files = walk(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({
        name: relative(SRC, f),
        text: readFileSync(f, 'utf8'),
      }));
    expect(
      verdict(files),
      'use requireAdmin so the sweep discovers the route, or list the policy with its coverage reason',
    ).toEqual({ unlistedRoleChecks: [], staleExemptions: [] });
  });

  it.each([
    "c.get('userRole')",
    'c.var.userRole',
    "user.role === 'admin'",
    "'admin' !== account.role",
    "role == 'admin'",
    "'admin' != currentRole",
    "user['role'] === 'admin'",
  ])('names an unlisted policy: %s', (text) => {
    expect(verdict([{ name: 'routes/new-policy.ts', text }]).unlistedRoleChecks).toEqual([
      'routes/new-policy.ts',
    ]);
  });

  it('does not classify source labels, strings or comments as role policies', () => {
    expect(
      hasRoleCheck(
        "// c.get('userRole')\nconst note = \"role === 'admin'\"; row.source === 'admin';",
      ),
    ).toBe(false);
  });

  it('does not pass an empty tree', () => {
    expect(verdict([]).staleExemptions).toEqual(Object.keys(EXEMPT));
  });
});
