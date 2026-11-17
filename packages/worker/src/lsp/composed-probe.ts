import type { DockerRunner } from '../sandbox/docker-runner.js';
import type { ComposedLspReport } from './composed-evidence.js';
import type { ComposedLspServer } from '../sandbox/lsp-layer.js';

/** Executes entirely inside the image, as node. A launcher exit/command-v alone cannot
 * satisfy this probe: it must return an initialize result with capabilities. */
export const COMPOSED_LSP_PROBE = String.raw`
const {spawn, execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const server = process.argv[1];
const specs = {
 intelephense: ['intelephense', ['--stdio'], 'intelephense', ['node', ['--version']]],
 vtsls: ['vtsls', ['--stdio'], '@vtsls/language-server', ['node', ['--version']]],
 pyright: ['pyright-langserver', ['--stdio'], 'pyright', ['node', ['--version']]],
 gopls: ['gopls', [], null, ['go', ['version']]],
 'rust-analyzer': ['rust-analyzer', [], null, ['rust-analyzer', ['--version']]],
 solargraph: ['solargraph', ['stdio'], null, ['ruby', ['--version']]],
 jdtls: ['jdtls', ['-data', '/tmp/haive-lsp-probe/jdtls'], null, ['java', ['--version']]],
};
const spec = specs[server];
if (!spec) process.exit(1);
spec[0] = '/usr/local/bin/' + spec[0];
const capture = (cmd, args) => execFileSync(cmd, args, {encoding:'utf8',timeout:3000,maxBuffer:4096}).trim().slice(0,256);
let installedVersion, toolchainVersion;
try {
 if (server === 'rust-analyzer') {
  const wrapper = fs.readFileSync('/usr/local/bin/rust-analyzer','utf8');
  const bin = /exec "([^"\n]+)\/rust-analyzer"/.exec(wrapper)?.[1];
  if (!bin) throw new Error('missing isolated Rust toolchain');
  toolchainVersion = capture(path.join(bin,'rustc'), ['--version']);
 } else toolchainVersion = capture(...spec[3]);
 if (spec[2]) {
  const root = capture('npm', ['root','-g']);
  installedVersion = JSON.parse(fs.readFileSync(path.join(root, spec[2], 'package.json'), 'utf8')).version;
 } else if (server === 'jdtls') {
  installedVersion = fs.readdirSync('/opt/haive-lsp/jdtls/plugins').find(n => /^org.eclipse.jdt.ls.core_.*\.jar$/.test(n));
 } else installedVersion = capture(spec[0], [server === 'gopls' ? 'version' : '--version']);
 if (!installedVersion || !toolchainVersion) throw new Error('missing version');
} catch { console.log(JSON.stringify({server,passed:false,skipped:true,installedVersion:null,toolchainVersion:null})); process.exit(1); }
fs.mkdirSync('/tmp/haive-lsp-probe', {recursive:true});
const child = spawn(spec[0], spec[1], {cwd:'/tmp/haive-lsp-probe',stdio:['pipe','pipe','pipe']});
let buffer = Buffer.alloc(0), finished = false;
const finish = passed => {
 if (finished) return;
 finished = true;
 clearTimeout(timer);
 child.kill('SIGKILL');
 console.log(JSON.stringify({server,passed,skipped:false,installedVersion:String(installedVersion).slice(0,256),toolchainVersion}));
 process.exitCode = passed ? 0 : 1;
};
const timer = setTimeout(() => finish(false), 8000);
child.on('error', () => finish(false));
child.on('exit', () => finish(false));
child.stdin.on('error', () => finish(false));
const send = message => { const b = Buffer.from(JSON.stringify(message)); child.stdin.write('Content-Length: '+b.length+'\r\n\r\n'); child.stdin.write(b); };
child.stdout.on('data', data => {
 buffer = Buffer.concat([buffer, data]);
 if (buffer.length > 65536) return finish(false);
 while (!finished) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return;
  const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString());
  if (!match || Number(match[1]) > 32768) return finish(false);
  const size = Number(match[1]);
  if (buffer.length < end + 4 + size) return;
  let message;
  try { message = JSON.parse(buffer.subarray(end+4,end+4+size).toString()); } catch { return finish(false); }
  buffer = buffer.subarray(end+4+size);
  if (message.id === 1) return finish(message.jsonrpc === '2.0' && !message.error && message.result && typeof message.result.capabilities === 'object' && message.result.capabilities !== null);
  if (message.id !== undefined && message.method) send({jsonrpc:'2.0',id:message.id,result:null});
 }
});
let stderrBytes = 0;
child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 65536) finish(false); });
send({jsonrpc:'2.0',id:1,method:'initialize',params:{processId:null,rootUri:'file:///tmp/haive-lsp-probe',capabilities:{},workspaceFolders:[]}});
`;

export function parseComposedProbeReport(
  server: ComposedLspServer,
  result: {
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    error?: string;
  },
): ComposedLspReport {
  let raw: Partial<ComposedLspReport> = {};
  try {
    raw = JSON.parse(result.stdout.trim());
  } catch {
    /* Invalid/partial output is a failed check. */
  }
  const version = (v: unknown) =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : null;
  const installedVersion = version(raw.installedVersion),
    toolchainVersion = version(raw.toolchainVersion);
  return {
    server,
    passed:
      result.exitCode === 0 &&
      !result.timedOut &&
      !result.error &&
      raw.server === server &&
      raw.passed === true &&
      raw.skipped === false &&
      !!installedVersion &&
      !!toolchainVersion,
    skipped: raw.skipped === true,
    installedVersion,
    toolchainVersion,
    stdout: result.stdout.slice(0, 2000),
    stderr: (result.error ?? result.stderr).slice(0, 2000),
  };
}

export async function probeComposedServer(
  runner: DockerRunner,
  imageId: string,
  server: ComposedLspServer,
  signal?: AbortSignal,
): Promise<ComposedLspReport> {
  const result = await runner.run({
    image: imageId,
    cmd: ['node', '-e', COMPOSED_LSP_PROBE, server],
    entrypoint: '',
    user: 'node',
    network: 'none',
    pull: 'never',
    readOnly: true,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges'],
    mounts: [{ source: '', target: '/tmp', tmpfs: true }],
    maxOutputBytes: 8192,
    timeoutMs: 25_000,
    memoryLimitMb: 512,
    cpuLimitMilli: 500,
    pidsLimit: 64,
    signal,
  });
  return parseComposedProbeReport(server, result);
}
