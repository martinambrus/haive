---
name: prettier-rewrites-json-fixtures
description: 'lint-staged prettier reformats a committed .json fixture, so a byte-for-byte compare against it passes before the commit and fails in CI'
metadata:
  node_type: memory
  type: feedback
  originSessionId: f5017f4f-0dce-49e2-af7e-9b3e0ca76aaf
  modified: 2026-10-16T03:48:20.784Z
---

The pre-commit hook (lint-staged, `prettier --write` on `*.json`) pretty-prints any JSON fixture you commit. A test that compares an API response byte for byte with that file passes when run before the commit and fails in CI (#795: `[K0]` providers baseline, 19/20).

**Why:** the hook changes file content at commit time; a pre-commit test run never sees the formatted file. Same class as [[prettier-unescapes-nul]].

**How to apply:** compare against the fixture's canonical form (`JSON.stringify(JSON.parse(file))` keeps content and key order), or store byte-exact fixtures under a non-formatted extension; and run gated/fixture tests AFTER committing, not only before.
