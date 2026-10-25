import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { gitRemoteUrlSchema, redactGitText, redactGitUrl } from '../src/schemas/git-url.js';

it.each([
  'https://fixture-user:fixture-password@example.test/repo.git',
  'https://fixture-user@example.test/repo.git',
])('redacts URL userinfo from display and saved remotes', (url) => {
  expect(redactGitUrl(url)).toBe('https://example.test/repo.git');
  expect(gitRemoteUrlSchema.parse(url)).toBe('https://example.test/repo.git');
});
it('keeps a usable SSH login for transport while redacting it from display', () => {
  const url = 'ssh://git:fixture-password@example.test:2222/repo.git';
  expect(gitRemoteUrlSchema.parse(url)).toBe('ssh://git@example.test:2222/repo.git');
  expect(redactGitUrl(url)).toBe('ssh://example.test:2222/repo.git');
  expect(gitRemoteUrlSchema.parse('git@example.test:repo.git')).toBe('git@example.test:repo.git');
});
it('redacts every URL in command errors with the same helper', () => {
  const message =
    'failed https://u:fixture-password@example.test/r and http://u:fixture-password@other.test/r';
  expect(redactGitText(message).includes('fixture-password')).toBe(false);
  expect(redactGitText(message)).toContain('https://example.test/r');
});

// Assertions deliberately compare booleans so a red control never prints a secret.
it.each(["'", '"', '<', '>', '`', '?', '#'])(
  'redacts delimiter case %# without consuming prose',
  (delimiter) => {
    const secret = `fixture-prefix${delimiter}fixture-suffix`;
    const raw = `https://user:${secret}@example.test/repo.git`;
    const message = `failed '${raw}' then retry https://other.test/public`;
    const safe = redactGitText(message);
    expect(safe.includes('fixture-suffix')).toBe(false);
    expect(safe.includes('fixture-prefix')).toBe(false);
    expect(safe).toContain('then retry https://other.test/public');
    expect(safe).toContain('https://example.test/repo.git');
  },
);
it.each(['https://user:fixture-secret@bad[host/repo', 'https://user:fixture-secret@/repo'])(
  'redacts malformed URL case %# and preserves following text',
  (url) => {
    const safe = redactGitText(`failed ${url} then retry`);
    expect(safe.includes('fixture-secret')).toBe(false);
    expect(safe).toContain('then retry');
  },
);
it.each(['https://example.test:443/repo', 'http://example.test:80/repo'])(
  'preserves the original transport authority when removing credentials: %s',
  (url) => {
    expect(gitRemoteUrlSchema.parse(url.replace('://', '://user:fixture-secret@')) === url).toBe(
      true,
    );
  },
);

it('keeps SSH login and exact authority spelling in sanitized transport identity', () => {
  const raw = 'ssh://fixture-login:fixture-password@EXAMPLE.test:22/owner/repo';
  expect(redactGitUrl(raw, true) === 'ssh://fixture-login@EXAMPLE.test:22/owner/repo').toBe(true);
  expect(redactGitUrl(raw) === 'ssh://EXAMPLE.test:22/owner/repo').toBe(true);
  expect(redactGitUrl('fixture-login@example.test:owner/repo', true)).toBe(
    'fixture-login@example.test:owner/repo',
  );
});
it('retains quoted URL boundaries, adjacent prose and independent URLs', () => {
  const input = 'see "https://example.test/repo"<next> and `https://other.test/repo`';
  expect(redactGitText(input)).toBe(input);
});

it('does not mistake a query @ for transport userinfo', () => {
  const raw = 'https://example.test?contact=user@other.test';
  expect(redactGitUrl(raw, true)).toBe(raw);
});
it('redacts every URL when quote delimiters separate adjacent diagnostics', () => {
  const safe = redactGitText(
    'https://public.test/repo"https://user:fixture-password@example.test/repo',
  );
  expect(safe.includes('fixture-password')).toBe(false);
  expect(safe).toContain('https://public.test/repo"https://example.test/repo');
});
it.each([' ', '\t', '\r', '\n'])(
  'redacts whitespace inside quoted legacy userinfo: case %#',
  (delimiter) => {
    const secret = `fixture-prefix${delimiter}fixture-suffix`;
    const safe = redactGitText(`failed 'https://user:${secret}@example.test/repo' then retry`);
    expect(safe.includes('fixture-prefix')).toBe(false);
    expect(safe.includes('fixture-suffix')).toBe(false);
    expect(safe).toContain('then retry');
  },
);
it('does not read later prose or email addresses as userinfo', () => {
  const input = 'see "https://example.test:443/repo" then contact support@example.test';
  expect(redactGitText(input)).toContain('then contact support@example.test');
});
it.each(
  ["'", '"', '`', '<', '>'].flatMap((quote) =>
    [' ', '\t', '\r', '\n'].map((space) => [quote, space]),
  ),
)('redacts combined authority delimiters conservatively: case %#', (quote, space) => {
  const raw = `failed 'https://user:fixture-prefix${quote}${space}fixture-suffix@example.test/repo' then retry`;
  const safe = redactGitText(raw);
  expect(safe.includes('fixture-prefix')).toBe(false);
  expect(safe.includes('fixture-suffix')).toBe(false);
  expect(safe).toContain('then retry');
});
it.each([
  'see https://example.test then contact support@example.test',
  'see "https://example.test:443" then contact support@example.test',
  'see https://example.test/repo then retry https://other.test/repo',
])('preserves standalone ordinary URL prose: case %#', (text) => {
  expect(redactGitText(text)).toContain('then');
  expect(redactGitText(text)).toContain(text.slice(text.indexOf('then')));
});

it.each([
  ['scheme-free text', `'A'.repeat(1_000_000)`, 'input'],
  [
    'ambiguous authority followed by scheme-free text',
    `'https://user:prefix" ' + 'A'.repeat(1_000_000)`,
    `'https:" ' + 'A'.repeat(1_000_000)`,
  ],
  [
    'successive ambiguous authorities without userinfo terminators',
    `'https://user:prefix" '.repeat(50_000)`,
    `'https:" '.repeat(50_000)`,
  ],
])(
  'bounds diagnostic scanning for %s',
  (_label, input, expected) => {
    // Run the actual exported helper in a killable child: a quadratic regression
    // must fail within a generous budget instead of hanging the test runner.
    const source = new URL('../src/schemas/git-url.ts', import.meta.url).href;
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
    import { redactGitText } from ${JSON.stringify(source)};
    const input = ${input};
    const output = redactGitText(input);
    if (output !== ${expected}) throw new Error('Incorrect diagnostic output');
    process.stdout.write('complete');
  `,
      ],
      { timeout: 5_000, encoding: 'utf8' },
    );
    expect(result).toBe('complete');
  },
  10_000,
);

it.each([
  ['HTTPS', '', 'https'],
  ['A1+.-', '', 'a1+.-'],
  ['https', '123+.-', 'https'],
  ['https', 'word_', 'https'],
  ['https', 'word! ', 'https'],
])('retains scheme spelling rules: case %#', (scheme, prefix, normalized) => {
  const raw = `${prefix}${scheme}://user:fixture-password@example.test/repo`;
  expect(redactGitText(raw)).toBe(`${prefix}${normalized}://example.test/repo`);
});

it.each(['123://example.test/repo', '+.-://example.test/repo'])(
  'does not treat a letter-free prefix as a scheme: %s',
  (input) => expect(redactGitText(input)).toBe(input),
);
