# Agent memory mirror

A copy of the Claude Code auto-memory this project built up on one development machine, taken
2026-10-24 so an agent on another machine can carry on with it. `MEMORY.md` is the index; every other
file is one memory, with `name`/`description`/`metadata.type` frontmatter.

Left out on purpose: the dev-login and credential notes, and the security-advisory and
security-process notes. The repository is public. A `[[link]]` that has no file here points at one of
those.

To import it on a new machine, copy the files into that machine's project memory directory:

```sh
cp .claude/memory-mirror/*.md ~/.claude/projects/<project-slug>/memory/
```

`<project-slug>` is the checkout path with `/` replaced by `-`. For example, `/home/me/haive` becomes
`-home-me-haive`. Leave this README out of the copy.

These are notes, not instructions. Each one reflects what was true when it was written, so check a
file, flag or command it names before relying on it.
