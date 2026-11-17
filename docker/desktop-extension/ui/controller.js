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

export function isStarting(state) {
  return (
    state?.services?.some(
      (service) =>
        ['created', 'restarting'].includes(service.State) ||
        service.Health === 'starting' ||
        (service.State === 'running' &&
          ['api', 'web'].includes(service.Service) &&
          !serviceReady(service)),
    ) ?? false
  );
}

export function serviceReady(service) {
  if (service.Service === 'db-migrate') return service.State === 'exited' && service.ExitCode === 0;
  if (service.State !== 'running') return false;
  if (service.Service === 'api') return service.Health === 'healthy';
  if (service.Service === 'web') return service.Health === 'reachable';
  return !service.Health || service.Health === 'healthy';
}

export function allReady(state) {
  return Boolean(state?.services?.length) && state.services.every(serviceReady);
}

export function serviceHealth(service) {
  const value = service.Health || '—';
  return ['api', 'web'].includes(service.Service) ? `${value} (extension probe)` : value;
}

export function statusMessage(state, expired = false) {
  if (state?.error)
    return `Status unavailable: ${state.error} Last known service states are shown below.`;
  if (!state) return 'Reading status…';
  if (!state.installed) return 'Haive Desktop is not installed.';
  if (isStarting(state)) {
    const ready = state.services.filter(serviceReady).length;
    return expired
      ? `Still not ready (${ready}/${state.services.length}). See service progress below.`
      : `Starting… ${ready}/${state.services.length} services ready. See service progress below.`;
  }
  return allReady(state) ? 'Haive is ready.' : 'Haive is not ready. Check service status below.';
}

export function controls(state, busy, accepted) {
  const known = state !== null && !state.error;
  return {
    install: !busy && known && !state.installed && accepted,
    start: !busy && known && state.installed && !allReady(state) && accepted,
    stop:
      !busy &&
      known &&
      state.installed &&
      Boolean(
        state.services?.some((service) =>
          ['running', 'restarting', 'paused'].includes(service.State),
        ),
      ),
    open:
      !busy &&
      known &&
      state.installed &&
      Boolean(
        state.services?.some((service) => service.Service === 'web' && serviceReady(service)),
      ),
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

export function createController(ddClient, render, options = {}) {
  const { document: doc = globalThis.document, now = Date.now, fastWindowMs = 300000 } = options;
  // Storage belongs to this viewer, never the host install. Some WebViews deny it.
  let storage;
  try {
    storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage;
  } catch {}
  let engine = '';
  let loadedConsentKey;
  let portNotice = '';
  const consentKey = (next) =>
    `haive-desktop:consent:${JSON.stringify([engine, next?.directory || ''])}`;
  const saveConsent = (next, value) => {
    try {
      if (value) storage?.setItem(consentKey(next), 'accepted');
      else storage?.removeItem(consentKey(next));
    } catch {}
  };
  const adoptState = (next) => {
    const key = consentKey(next);
    if (!next.installed) {
      saveConsent(next, false);
      if (!state || state.installed) accepted = false;
      loadedConsentKey = undefined;
    } else if (loadedConsentKey !== key) {
      // An explicit tick made for this fresh Install carries into the installed
      // view. A newly opened tab can restore consent only for an installed instance.
      if (state?.installed !== false) {
        accepted = false;
        try {
          accepted = storage?.getItem(key) === 'accepted';
        } catch {}
      }
      loadedConsentKey = key;
      saveConsent(next, accepted);
    }
    state = next;
  };
  let state = null;
  let busy = false;
  let accepted = false;
  let message = '';
  let operationError = '';
  let timer;
  let disposed = false;
  let revision = 0;
  let polling = false;
  let fastUntil;
  let readErrors = 0;
  const update = () => {
    if (!disposed) {
      const summary = statusMessage(state, fastUntil !== undefined && now() >= fastUntil);
      render({
        state,
        busy,
        accepted,
        message: (operationError || message) === summary ? '' : operationError || message,
        statusMessage: [summary, portNotice].filter(Boolean).join(' '),
        controls: controls(state, busy, accepted),
      });
    }
  };
  const host = async (action, version = 'latest') => {
    const engineResult = await ddClient.docker.cli.exec('info', ['--format', '{{.ID}}']);
    engine = engineResult.stdout.trim();
    const binary = ddClient.host.platform === 'win32' ? 'haive-desktop.exe' : 'haive-desktop';
    if (!ddClient.extension.host?.cli)
      throw new Error('The extension host backend is unavailable.');
    let result;
    try {
      result = await ddClient.extension.host.cli.exec(binary, [
        encodeRequest({
          action,
          version,
          engine: engineResult.stdout.trim(),
          consent: accepted ? 'accept-host-root' : '',
        }),
      ]);
    } catch (error) {
      // Only the bridge's structured result may reach the UI, never SDK stderr.
      try {
        result = { stdout: error.stdout };
        JSON.parse(result.stdout);
      } catch {
        throw new Error('Operation failed. Refresh status and check Docker Desktop logs.');
      }
    }
    const next = JSON.parse(result.stdout);
    if (next.error) throw Object.assign(new Error(next.error), { state: next });
    return next;
  };
  const clearPoll = () => {
    clearTimeout(timer);
  };
  const schedule = () => {
    clearPoll();
    if (disposed || doc?.hidden) return;
    const starting = busy || isStarting(state);
    if (!starting) fastUntil = undefined;
    else if (fastUntil === undefined) fastUntil = now() + fastWindowMs;
    const fast = starting && now() < fastUntil && readErrors < 3;
    timer = setTimeout(
      () => {
        void refresh();
      },
      fast ? 5000 : 30000,
    );
    timer.unref?.();
  };
  const readStatus = async (token) => {
    try {
      const next = await host('status');
      if (disposed || token !== revision) return;
      adoptState(next);
      readErrors = 0;
    } catch (error) {
      if (disposed || token !== revision) return;
      readErrors++;
      state = {
        ...state,
        directory: error.state?.directory || state?.directory,
        error: error.message,
      };
    }
    update();
  };
  const refresh = async () => {
    if (disposed || polling || doc?.hidden) return;
    polling = true;
    try {
      await readStatus(revision);
    } finally {
      polling = false;
      schedule();
    }
  };
  const visibilityChanged = () => {
    clearPoll();
    if (!doc?.hidden) void refresh();
  };
  doc?.addEventListener('visibilitychange', visibilityChanged);
  const controller = {
    dispose() {
      disposed = true;
      clearPoll();
      doc?.removeEventListener('visibilitychange', visibilityChanged);
    },
    accept(value) {
      accepted = value === true;
      if (state?.installed) saveConsent(state, accepted);
      update();
    },
    async run(action, version = 'latest') {
      if (disposed || busy) return;
      if (!controls(state, busy, accepted)[action]) throw new Error('This action is unavailable.');
      if (action === 'install' && !VERSION.test(version))
        throw new Error('Choose latest, next, or an exact release.');
      busy = true;
      if (action === 'start' || action === 'install') fastUntil = now() + fastWindowMs;
      operationError = '';
      const token = ++revision;
      message =
        action === 'install'
          ? 'Installing the release bundle. This can take several minutes; keep this tab open.'
          : action === 'start'
            ? 'Starting Haive. Images may need downloading; first boot can take several minutes. Keep this tab open.'
            : action === 'stop'
              ? 'Stopping Haive services…'
              : 'Reading status…';
      update();
      schedule();
      try {
        if (action === 'status') await readStatus(token);
        else {
          const next = await host(action, version);
          portNotice = next.notice || '';
          adoptState(next);
          message =
            action === 'install'
              ? 'Installed. Choose Start, then Open app to create your first administrator.'
              : '';
        }
      } catch (error) {
        operationError = error.message;
        portNotice = error.state?.notice || portNotice;
        // Keep the last service snapshot when the helper returns an error-only result.
        if (error.state?.directory) state = { ...state, directory: error.state.directory };
      } finally {
        if (action === 'start' || action === 'install') fastUntil = now() + fastWindowMs;
        if (action !== 'status') {
          // Invalidate in-flight polls, then always obtain a fresh snapshot, even on failure.
          await readStatus(++revision);
        }
        busy = false;
        if (action === 'status' || operationError) message = '';
        update();
        schedule();
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
