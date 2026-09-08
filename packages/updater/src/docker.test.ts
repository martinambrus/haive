import { describe, expect, it } from 'vitest';
import { redactSecrets } from './docker.js';

describe('redactSecrets', () => {
  // MEASURED: the first real upgrade printed the Postgres password into the log when the commit
  // phase failed, because Node puts the whole command line into a failed exec's message and
  // one-shot containers take their credentials as `-e` arguments.
  it('redacts a database URL passed as a docker -e argument', () => {
    const line =
      'Command failed: docker run --rm -e DATABASE_URL=postgres://haive:hunter2@postgres:5432/haive img';
    const out = redactSecrets(line);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('-e DATABASE_URL=<redacted>');
  });

  it('redacts every credential-shaped variable, not just the first', () => {
    const line =
      '-e DATABASE_URL=postgres://u:p@h/db -e CONFIG_ENCRYPTION_KEY=abc -e JWT_SECRET=xyz';
    const out = redactSecrets(line);
    for (const secret of ['postgres://u:p@h/db', 'abc', 'xyz']) expect(out).not.toContain(secret);
  });

  it('leaves ordinary arguments alone', () => {
    const line = 'docker compose -f docker-compose.yml up -d --remove-orphans';
    expect(redactSecrets(line)).toBe(line);
  });
});
