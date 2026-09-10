import { describe, it, expect } from 'vitest';
import {
  decideDdevRecovery,
  isHostPortCollision,
  isDdevVersionConstraintFailure,
  parseProcNetRouteGateway,
  parseDdevPrimaryUrl,
  parseDdevMailpitUrls,
  parseDdevProjectStatus,
  decideMailpitHostUrls,
  renderXdebugIni,
  ddevDbInternalPort,
  ddevRegistryMirrorUrl,
  buildRegistryDaemonJson,
  budgetContainerLogs,
  buildDdevTableCountCommand,
  parseDdevTableCount,
  warmStartRecoveryVerdict,
} from './ddev-runner.js';

// Pure recovery-path decision for ensureDdevStartedInner. The orchestrator gathers
// the three booleans by shelling out (ddev describe / docker info) and then routes
// on this result; the docker-shelling itself is left untested by design (no docker
// mocking in this package — mirrors how 07c extracts + tests `classifyDrift`).
describe('decideDdevRecovery', () => {
  it('serving project (describe ok + running) -> reuse, regardless of dockerd probe', () => {
    expect(decideDdevRecovery({ describeOk: true, serving: true, dockerdUp: true })).toBe('reuse');
    expect(decideDdevRecovery({ describeOk: true, serving: true, dockerdUp: false })).toBe('reuse');
  });

  it('describe returned but the project is not running, nested dockerd alive -> warm-start', () => {
    expect(decideDdevRecovery({ describeOk: true, serving: false, dockerdUp: true })).toBe(
      'warm-start',
    );
  });

  it('project down (describe failed) but runner + dockerd alive -> warm-start', () => {
    expect(decideDdevRecovery({ describeOk: false, serving: false, dockerdUp: true })).toBe(
      'warm-start',
    );
  });

  it('runner / nested dockerd gone -> cold-boot', () => {
    expect(decideDdevRecovery({ describeOk: false, serving: false, dockerdUp: false })).toBe(
      'cold-boot',
    );
  });

  it('reuse requires BOTH describeOk and serving: a stale serving read without a live describe falls to the dockerd probe', () => {
    // describe failed but its (stale) output still contained the primary_url
    // token — not trusted: with no live dockerd this must rebuild, not reuse.
    expect(decideDdevRecovery({ describeOk: false, serving: true, dockerdUp: false })).toBe(
      'cold-boot',
    );
    expect(decideDdevRecovery({ describeOk: false, serving: true, dockerdUp: true })).toBe(
      'warm-start',
    );
  });
});

describe('isDdevVersionConstraintFailure', () => {
  it('matches the real runner failure (task 38f02dee, exact-pin vs shipped patch)', () => {
    const out =
      "Failed to start project(s): unable to start the 'rs-codex-5-6-ultra' project: your DDEV " +
      "version 'v1.25.3' doesn't meet the constraint '= v1.25.2'. Please update to a DDEV version " +
      'that meets this constraint or update the `ddev_version_constraint` in your .ddev/config.yaml';
    expect(isDdevVersionConstraintFailure(out)).toBe(true);
  });

  it('is false for an ordinary transient boot failure (rebuild/retry should still run)', () => {
    expect(isDdevVersionConstraintFailure('Failed to start: container timed out after 120s')).toBe(
      false,
    );
    expect(isDdevVersionConstraintFailure('web container failed: exit 1')).toBe(false);
  });
});

describe('isHostPortCollision', () => {
  it('matches the known docker host-port-bind error forms', () => {
    // These strings come from the docker daemon and are ephemeral upstream wording;
    // the collision-retry loop keys on them, so this test pins the forms we handle.
    expect(isHostPortCollision('Bind for 127.0.0.1:49215 failed: port is already allocated')).toBe(
      true,
    );
    expect(isHostPortCollision('listen tcp 0.0.0.0:8080: bind: address already in use')).toBe(true);
    expect(isHostPortCollision('Error: ports are not available: exposing port TCP')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHostPortCollision('PORT IS ALREADY ALLOCATED')).toBe(true);
  });

  it('does not match unrelated docker errors (those should surface, not retry)', () => {
    expect(isHostPortCollision('no such image: ddev-runner:latest')).toBe(false);
    expect(isHostPortCollision('Cannot connect to the Docker daemon')).toBe(false);
    expect(isHostPortCollision('')).toBe(false);
  });
});

describe('parseProcNetRouteGateway', () => {
  // Xdebug's client_host must be the gateway the nested PHP (L3) container routes
  // through to reach the runner. We read it from /proc/net/route (no iproute2 dep);
  // the default-route gateway is a little-endian hex quad. This fixture is the real
  // output captured from a running DDEV web container (gateway 172.20.0.1).
  const REAL = [
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
    'eth1\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
    'eth0\t000013AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
    'eth1\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  ].join('\n');

  it('decodes the little-endian default-route gateway (real fixture -> 172.20.0.1)', () => {
    expect(parseProcNetRouteGateway(REAL)).toBe('172.20.0.1');
  });

  it('skips the header and non-default routes, decoding only Destination 00000000', () => {
    // 0100A8C0 little-endian -> 192.168.0.1
    const text = 'Iface\tDestination\tGateway\n' + 'eth0\t00000000\t0100A8C0\t0003\t0\t0\t0';
    expect(parseProcNetRouteGateway(text)).toBe('192.168.0.1');
  });

  it('returns null when there is no default route or the table is empty', () => {
    expect(parseProcNetRouteGateway('Iface\tDestination\tGateway')).toBeNull();
    expect(parseProcNetRouteGateway('eth0\t000013AC\t00000000\t0001')).toBeNull();
    expect(parseProcNetRouteGateway('')).toBeNull();
  });
});

describe('renderXdebugIni', () => {
  // The setting NAMES differ between Xdebug majors and each ignores the other's keys,
  // so emitting the wrong set is a silent no-op (DBGp goes nowhere). These tests lock
  // the per-major output — a regression here is invisible until a live debug session.
  it('Xdebug 3 uses client_* + start_with_request=trigger (not remote_*)', () => {
    const ini = renderXdebugIni('172.20.0.1', 3);
    expect(ini).toContain('xdebug.client_host=172.20.0.1');
    expect(ini).toContain('xdebug.client_port=9003');
    expect(ini).toContain('xdebug.discover_client_host=0');
    expect(ini).toContain('xdebug.start_with_request=trigger');
    expect(ini).not.toContain('xdebug.remote_host');
  });

  it('Xdebug 2 uses remote_* + autostart/connect_back off (not client_*)', () => {
    const ini = renderXdebugIni('172.20.0.1', 2);
    expect(ini).toContain('xdebug.remote_enable=1');
    expect(ini).toContain('xdebug.remote_host=172.20.0.1');
    expect(ini).toContain('xdebug.remote_port=9003');
    expect(ini).toContain('xdebug.remote_connect_back=0');
    expect(ini).toContain('xdebug.remote_autostart=0');
    expect(ini).not.toContain('xdebug.client_host');
    expect(ini).not.toContain('start_with_request');
  });

  it('does NOT override max_nesting_level (keeps the DDEV safety-net default)', () => {
    // DDEV's default cap surfaces runaway recursion as a fast clean abort instead of a
    // slow OOM — useful while debugging. The ini sets only DBGp routing. (Guards
    // against re-adding the band-aid that once masked a real infinite-recursion bug.)
    expect(renderXdebugIni('10.0.0.1', 2)).not.toContain('max_nesting_level');
    expect(renderXdebugIni('10.0.0.1', 3)).not.toContain('max_nesting_level');
  });
});

describe('ddevDbInternalPort', () => {
  // The db socat hop forwards to this port inside the project network; a wrong value
  // is a silent connection failure (postgres on 3306 refuses), so pin the mapping.
  it('maps the DDEV db engine to its container port', () => {
    expect(ddevDbInternalPort('postgres')).toBe(5432);
    expect(ddevDbInternalPort('mysql')).toBe(3306);
    expect(ddevDbInternalPort('mariadb')).toBe(3306);
  });
  it('defaults unknown / absent engines to 3306 (DDEV runs mariadb by default)', () => {
    expect(ddevDbInternalPort('')).toBe(3306);
    expect(ddevDbInternalPort('sqlite')).toBe(3306);
  });
});

describe('ddev registry pull-through cache config', () => {
  // The runner's nested dockerd routes Hub pulls through the mirror only if the
  // daemon.json names it as a registry-mirror AND lists it insecure (it's plaintext
  // HTTP) — miss either and dockerd silently pulls direct, defeating the cache. The
  // worker renders this and passes it to the runner via env, so pin the shape.
  it('mirror URL is the in-cluster container name on the registry port', () => {
    expect(ddevRegistryMirrorUrl()).toBe('http://haive-ddev-registry:5000');
  });

  it('daemon.json sets registry-mirrors (full URL) + insecure-registries (host:port)', () => {
    const json = JSON.parse(buildRegistryDaemonJson('http://haive-ddev-registry:5000')) as Record<
      string,
      string[]
    >;
    expect(json['registry-mirrors']).toEqual(['http://haive-ddev-registry:5000']);
    expect(json['insecure-registries']).toEqual(['haive-ddev-registry:5000']);
  });

  it('strips the http(s) scheme for the insecure-registries entry', () => {
    const json = JSON.parse(buildRegistryDaemonJson('https://mirror.example:5000')) as Record<
      string,
      string[]
    >;
    expect(json['insecure-registries']).toEqual(['mirror.example:5000']);
  });
});

// Regression for the gate-2 / VNC "navigates to localhost, ERR_CONNECTION_REFUSED"
// bug: `ddev describe -j` prepends stray log lines (a PHP warning here) before the
// describe payload, and the old indexOf('{')..lastIndexOf('}') slice spanned both
// objects -> JSON.parse threw -> null -> callers fell back to http://localhost.
describe('parseDdevPrimaryUrl', () => {
  const payload = (url: string) =>
    JSON.stringify({ level: 'info', msg: 'Project Information...', raw: { primary_url: url } });

  it('returns primary_url from a clean single-object describe', () => {
    expect(parseDdevPrimaryUrl(payload('https://x.ddev.site:8443'))).toBe(
      'https://x.ddev.site:8443',
    );
  });

  it('returns primary_url even when a log line precedes the payload (the real bug)', () => {
    const warning = JSON.stringify({
      level: 'info',
      msg: "PHP Warning:  Module 'mysql' already loaded in Unknown on line 0",
      time: '2026-06-30T00:11:05Z',
    });
    const out = `${warning}\n${payload('https://rs-ollama2.ddev.site:51650')}\n`;
    expect(parseDdevPrimaryUrl(out)).toBe('https://rs-ollama2.ddev.site:51650');
  });

  it('returns null when no line carries raw.primary_url', () => {
    expect(parseDdevPrimaryUrl('{"level":"info","msg":"no url here"}\n')).toBeNull();
    expect(parseDdevPrimaryUrl('')).toBeNull();
  });
});

describe('parseDdevMailpitUrls', () => {
  const payload = (raw: Record<string, string>) =>
    JSON.stringify({ level: 'info', msg: 'Project Information...', raw });
  const full = {
    primary_url: 'https://x.ddev.site',
    mailpit_url: 'http://x.ddev.site:8025',
    mailpit_https_url: 'https://x.ddev.site:8026',
  };

  it('reads both Mailpit URLs off the describe payload', () => {
    expect(parseDdevMailpitUrls(payload(full))).toEqual({
      http: 'http://x.ddev.site:8025',
      https: 'https://x.ddev.site:8026',
    });
  });

  // Same failure parseDdevPrimaryUrl exists for: a stray log object ahead of the payload
  // makes an indexOf('{')..lastIndexOf('}') slice span two objects and throw.
  it('survives a log line preceding the payload', () => {
    const warning = JSON.stringify({ level: 'info', msg: "PHP Warning: Module 'mysql' loaded" });
    expect(parseDdevMailpitUrls(`${warning}\n${payload(full)}\n`)?.http).toBe(
      'http://x.ddev.site:8025',
    );
  });

  // A DDEV predating Mailpit, or a project that omitted the service, must contribute
  // nothing rather than half an answer pointing at a port nobody is listening on.
  it('returns null when either URL is missing, and when there is no payload at all', () => {
    const { mailpit_https_url: _dropped, ...httpOnly } = full;
    expect(parseDdevMailpitUrls(payload(httpOnly))).toBeNull();
    expect(parseDdevMailpitUrls(payload({ primary_url: 'https://x.ddev.site' }))).toBeNull();
    expect(parseDdevMailpitUrls('')).toBeNull();
  });

  // Read off the SAME object that carries primary_url, so a stray line cannot contribute.
  it('ignores mailpit keys on an object with no primary_url', () => {
    const stray = JSON.stringify({ raw: { mailpit_url: 'http://nope', mailpit_https_url: 'x' } });
    expect(parseDdevMailpitUrls(stray)).toBeNull();
  });
});

// Which reported Mailpit URL may be handed to a browser on the HOST. `ddev config global
// --mailpit-*-port` is what the runner pins, but a project's own .ddev/config.yaml OVERRIDES
// global (DDEV says so in its own --help) and agents write that file unprompted — so the
// reported port and the published one can disagree, and a link on the wrong port 404s.
describe('decideMailpitHostUrls', () => {
  const reported = { http: 'http://x.ddev.site:8025', https: 'https://x.ddev.site:8026' };

  it('offers both when the reported ports are the ones this runner published', () => {
    expect(decideMailpitHostUrls(reported, { http: 8025, https: 8026 })).toEqual(reported);
  });

  it('drops only the half whose port disagrees', () => {
    expect(decideMailpitHostUrls(reported, { http: 8025, https: 9999 })).toEqual({
      http: reported.http,
    });
  });

  it('offers nothing when the project moved both ports out from under the pin', () => {
    expect(decideMailpitHostUrls(reported, { http: 9998, https: 9999 })).toEqual({});
  });

  // No labels = direct access was off at runner start (or the runner predates the feature),
  // so nothing was published and there is no host link to give.
  it('offers nothing with no reported URLs and nothing with no published ports', () => {
    expect(decideMailpitHostUrls(null, { http: 8025, https: 8026 })).toEqual({});
    expect(decideMailpitHostUrls(reported, null)).toEqual({});
  });

  // A portless URL carries no port to agree with — never assume the default.
  it('offers nothing for a URL with no explicit port', () => {
    expect(
      decideMailpitHostUrls(
        { http: 'http://x.ddev.site', https: 'https://x.ddev.site' },
        {
          http: 80,
          https: 443,
        },
      ),
    ).toEqual({});
  });
});

// Regression for task 3b7b8140: the capture concatenated web's log then db's and
// tail-sliced the RESULT, so db's mysqld boot trace (its own start.sh runs `set -x`)
// evicted the web block entirely — and web was the container that had exited, so the
// only log naming the cause was the one guaranteed to be dropped.
describe('budgetContainerLogs', () => {
  const sentinel = '@@HAIVE-DDEV-LOG@@';
  const capture = (web: string, db: string) =>
    `${sentinel}ddev-x-web\n${web}\n${sentinel}ddev-x-db\n${db}\n`;

  it('keeps the web block even when db out-logs the whole budget', () => {
    const out = budgetContainerLogs(
      capture('chown: Operation not permitted', 'mysqld noise\n'.repeat(500)),
      3000,
    );
    expect(out).toContain('=== ddev-x-web ===');
    expect(out).toContain('chown: Operation not permitted');
    expect(out).toContain('=== ddev-x-db ===');
    expect(out.length).toBeLessThanOrEqual(3200);
  });

  it('keeps the TAIL of an over-budget block — the failing command logs last', () => {
    const out = budgetContainerLogs(capture(`${'x'.repeat(5000)}\nFATAL last line`, 'db ok'), 1000);
    expect(out).toContain('FATAL last line');
  });

  it('lets a lone noisy block spend the whole budget', () => {
    const out = budgetContainerLogs(`${sentinel}ddev-x-web\n${'y'.repeat(9000)}`, 3000);
    expect(out.length).toBeGreaterThan(2900);
  });

  it('gives a short block its remainder back to the noisy one', () => {
    const short = budgetContainerLogs(capture('tiny', 'z'.repeat(9000)), 3000);
    // db gets far more than an even 1500 split would have allowed it.
    expect(short.length).toBeGreaterThan(2900);
    expect(short).toContain('tiny');
  });

  it('drops empty blocks rather than emitting a bare heading', () => {
    expect(budgetContainerLogs(capture('web line', '   '), 3000)).not.toContain('ddev-x-db');
  });

  it('falls back to a plain tail when the capture emitted no sentinel', () => {
    expect(budgetContainerLogs('docker: no such container', 3000)).toBe(
      'docker: no such container',
    );
    expect(budgetContainerLogs('', 3000)).toBe('');
  });

  it('emits nothing rather than everything when the budget is smaller than the block count', () => {
    // `slice(-0)` returns the whole string, so a zero share has to short-circuit.
    const out = budgetContainerLogs(capture('a'.repeat(100), 'b'.repeat(100)), 1);
    expect(out).not.toContain('aaaa');
    expect(out).not.toContain('bbbb');
  });
});

// A STOPPED project describes cleanly and still reports its primary_url, which is why the
// reuse test could not be `output.includes('primary_url')`. Task 75d8cbab: 01c reused a
// project with no containers, and the pg_restore pipeline that followed had both of its ddev
// processes start it at once. Shape is verbatim from `ddev describe -j` on v1.25.3 — one
// newline-delimited log object whose `raw` carries both fields.
const DESCRIBE_LINE = (status: string): string =>
  JSON.stringify({
    level: 'info',
    msg: 'describe',
    raw: { name: 'elmont-rs', primary_url: 'https://elmont-rs.ddev.site', status },
    time: '2026-09-06T10:53:00Z',
  });

describe('parseDdevProjectStatus', () => {
  it('reads the status off the same object that carries primary_url', () => {
    expect(parseDdevProjectStatus(DESCRIBE_LINE('running'))).toBe('running');
    expect(parseDdevProjectStatus(DESCRIBE_LINE('stopped'))).toBe('stopped');
  });

  // The describe payload carries per-service `status` keys too, so a text match would read
  // whichever one happened to come first. MEASURED on the live runner: one service reported
  // "stopped" while the project itself was "running".
  it('ignores a service status that is not the project status', () => {
    const withServices =
      '{"level":"info","msg":"service","raw":{"status":"stopped"}}\n' + DESCRIBE_LINE('running');
    expect(parseDdevProjectStatus(withServices)).toBe('running');
  });

  it('survives the stray log lines that precede the payload', () => {
    const noisy =
      '{"level":"info","msg":"PHP Warning: Module already loaded"}\n' + DESCRIBE_LINE('running');
    expect(parseDdevProjectStatus(noisy)).toBe('running');
    expect(parseDdevPrimaryUrl(noisy)).toBe('https://elmont-rs.ddev.site');
  });

  it('returns null when no describe payload is present', () => {
    expect(parseDdevProjectStatus('not json at all')).toBeNull();
  });

  // The regression itself: this output used to be read as "serving" and skip the start.
  it('does not report a stopped project as running', () => {
    expect(parseDdevProjectStatus(DESCRIBE_LINE('stopped'))).not.toBe('running');
    expect(
      decideDdevRecovery({
        describeOk: true,
        serving: parseDdevProjectStatus(DESCRIBE_LINE('stopped')) === 'running',
        dockerdUp: true,
      }),
    ).toBe('warm-start');
  });
});

// A `ddev import-db` that exits 0 having created nothing is the case this pair exists
// for: task ef954a3d recorded `"imported": true` against a database with zero tables and
// the workflow only found out ~20 hours later, at Gate 2.
describe('post-import table count', () => {
  it("asks postgres and mysql with each engine's own client and schema predicate", () => {
    expect(buildDdevTableCountCommand('/p', 'postgres')).toContain('ddev psql');
    expect(buildDdevTableCountCommand('/p', 'postgres')).toContain('information_schema.tables');
    expect(buildDdevTableCountCommand('/p', 'mariadb')).toContain('ddev mysql');
    expect(buildDdevTableCountCommand('/p', 'mariadb')).toContain('table_schema = database()');
  });

  it("treats an unknown engine as mysql — DDEV's default when no database block is set", () => {
    expect(buildDdevTableCountCommand('/p', null)).toContain('ddev mysql');
  });

  it('reads the count from a clean answer', () => {
    expect(parseDdevTableCount('412\n')).toBe(412);
  });

  it('reads ZERO as a count, never as "no answer" — that is the whole failure', () => {
    expect(parseDdevTableCount('0\n')).toBe(0);
  });

  it('takes the last all-digit LINE, so a number inside a DDEV log line is not the count', () => {
    expect(parseDdevTableCount('Container ddev-x-db  Running for 17 seconds\n412\n')).toBe(412);
  });

  it('returns null when nothing in the output is a count', () => {
    expect(parseDdevTableCount('')).toBeNull();
    expect(parseDdevTableCount('psql: command not found\n')).toBeNull();
  });
});

// A project whose tables live in a custom schema is a LIVE database. Counting only
// `public` calls it empty, and the warm-start branch answers "empty" by restoring an
// older snapshot OVER it — so a wrong probe here is a data-loss path, not a cosmetic
// miscount.
describe('table-count schema scope', () => {
  it('counts EVERY non-system postgres schema, not just public', () => {
    const cmd = buildDdevTableCountCommand('/p', 'postgres');
    expect(cmd).toContain("not in ('pg_catalog', 'information_schema')");
    expect(cmd).not.toContain("= 'public'");
  });

  it('leaves mysql alone — there a schema IS the database, so database() already covers it', () => {
    expect(buildDdevTableCountCommand('/p', 'mariadb')).toContain('table_schema = database()');
  });
});

// The asymmetry here is easy to get backwards. `null` (unreadable count) is a safe
// FIRST reading — nothing established, so nothing acts. It is not a safe SECOND one:
// by then the database has been PROVED empty and an unreadable probe does not
// overturn that. Task ef954a3d spent ~8 hours and two gate-2 rejections on exactly
// the state this decides about.
describe('warmStartRecoveryVerdict', () => {
  it('proceeds when recovery is PROVED — a positive non-zero count', () => {
    expect(warmStartRecoveryVerdict({ recoveredTables: 160, snapshotExists: true })).toBe('ok');
  });

  it('refuses when the snapshot is still not in the database', () => {
    expect(warmStartRecoveryVerdict({ recoveredTables: 0, snapshotExists: true })).toBe(
      'unrecovered',
    );
  });

  it('refuses an UNREADABLE count once the database is known empty — absence of a zero is not proof', () => {
    expect(warmStartRecoveryVerdict({ recoveredTables: null, snapshotExists: true })).toBe(
      'unrecovered',
    );
  });

  it('carries on with no snapshot — nothing to recover, so empty is just the project', () => {
    // A greenfield repo, or any task that imported no dump. Throwing here would break
    // every one of them.
    expect(warmStartRecoveryVerdict({ recoveredTables: 0, snapshotExists: false })).toBe('ok');
    expect(warmStartRecoveryVerdict({ recoveredTables: null, snapshotExists: false })).toBe('ok');
  });
});
