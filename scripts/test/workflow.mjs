import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsers } from 'prettier/plugins/yaml';

// The YAML parser declared through Prettier, as ci-browser-budget.test.mjs reads it, so
// indentation and comments cannot satisfy the checks. Scalars stay strings.
function value(node) {
  if (!node) return null;
  if ('value' in node) return node.value;
  if (node.type === 'mapping') {
    const entries = node.children.map((item) => item.children.map(value));
    assert.equal(new Set(entries.map(([key]) => key)).size, entries.length, 'duplicate YAML key');
    return Object.fromEntries(entries);
  }
  if (node.type === 'sequence' || node.type === 'flowSequence') return node.children.map(value);
  assert.equal(node.children.length, 1, `unsupported YAML node ${node.type}`);
  return value(node.children[0]);
}

export function readWorkflow(file) {
  const ast = parsers.yaml.parse(
    readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'),
  );
  return value(ast.children[0].children.find((node) => node.type === 'documentBody'));
}
