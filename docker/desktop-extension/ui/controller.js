export const INSTALL_ID = 'haive_desktop';
export const VERSION = /^(latest|next|v?\d+\.\d+\.\d+(-[\dA-Za-z]+([.-][\dA-Za-z]+)*)?)$/;

/** Base64url without padding: Docker Desktop passes host-binary arguments to Windows through a
 *  command line that strips double quotes, so raw JSON would arrive broken. */
export function encodeRequest(request) {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(request)))
    binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function controls(state, busy, accepted) {
  const known = state !== null && !state.error;
  return {
    install: !busy && known && !state.installed && accepted,
    start: !busy && known && state.installed && accepted,
    stop: !busy && known && state.installed,
    open: !busy && known && state.installed && state.healthy,
    status: !busy,
    logs: !busy,
  };
}

export function appURL(state) {
  const url = state?.appUrl;
  if (!/^http:\/\/localhost:\d{1,5}$/.test(url ?? '')) throw new Error('No valid local app URL.');
  const port = Number(new URL(url).port || 80);
  if (port < 1 || port > 65535) throw new Error('Invalid local app port.');
  return url + '/setup';
}

export function createController(ddClient, render) {
  let state = null;
  let busy = false;
  let accepted = false;
  let message = '';
  const update = () =>
    render({ state, busy, accepted, message, controls: controls(state, busy, accepted) });
  const controller = {
    accept(value) {
      accepted = value === true;
      update();
    },
    async run(action, version = 'latest') {
      if (busy) return;
      if (!controls(state, busy, accepted)[action]) throw new Error('This action is unavailable.');
      if (action === 'install' && !VERSION.test(version))
        throw new Error('Choose latest, next, or an exact release.');
      busy = true;
      message =
        action === 'install'
          ? 'Installing the release bundle. This can take several minutes; keep this tab open.'
          : action === 'start'
            ? 'Starting Haive. Images may need downloading; first boot can take several minutes. Keep this tab open.'
            : action === 'stop'
              ? 'Stopping Haive services…'
              : 'Reading status…';
      update();
      try {
        const engineResult = await ddClient.docker.cli.exec('info', ['--format', '{{.ID}}']);
        const engine = engineResult.stdout.trim();
        const binary = ddClient.host.platform === 'win32' ? 'haive-desktop.exe' : 'haive-desktop';
        if (!ddClient.extension.host?.cli)
          throw new Error('The extension host backend is unavailable.');
        const result = await ddClient.extension.host.cli.exec(binary, [
          encodeRequest({
            action,
            version,
            engine,
            consent: accepted ? 'accept-host-root' : '',
          }),
        ]);
        state = JSON.parse(result.stdout);
        if (state.error) throw new Error(state.error);
        message =
          action === 'install'
            ? 'Installed. Choose Start, then Open app to create your first administrator.'
            : state.healthy
              ? 'Haive is ready.'
              : state.installed
                ? 'Installed. Check service status below.'
                : 'Haive Desktop is not installed.';
      } catch (error) {
        // Host failures can reject with an ExecResult. Show only our structured
        // error, never third-party stderr or an install's environment values.
        let failed;
        try {
          failed = JSON.parse(error.stdout);
        } catch {
          /* no structured host result */
        }
        state = {
          directory: failed?.directory || state?.directory,
          error:
            failed?.error ||
            (error instanceof Error
              ? error.message
              : 'Operation failed. Refresh status and check Docker Desktop logs.'),
        };
        message = state.error;
      } finally {
        busy = false;
        update();
      }
    },
    open() {
      if (!controls(state, busy, accepted).open)
        throw new Error('Haive is not ready. Refresh status.');
      ddClient.host.openExternal(appURL(state));
    },
    async logs(service = 'api') {
      if (busy || !['api', 'worker'].includes(service)) return;
      const result = await ddClient.docker.cli.exec('ps', [
        '-a',
        '--no-trunc',
        '--filter',
        `label=com.docker.compose.project=${INSTALL_ID}`,
        '--filter',
        `label=com.docker.compose.service=${service}`,
        '--format',
        '{{.ID}}',
      ]);
      const id = result.stdout.trim().split('\n')[0];
      if (id && /^[a-f0-9]{64}$/.test(id)) await ddClient.desktopUI.navigate.viewContainerLogs(id);
      else await ddClient.desktopUI.navigate.viewContainers();
    },
  };
  update();
  return controller;
}
