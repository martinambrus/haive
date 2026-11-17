import { createDockerDesktopClient } from '@docker/extension-api-client';
import { createController } from './controller.js';

const ddClient = createDockerDesktopClient();
const byId = (id) => document.getElementById(id);
const controller = createController(ddClient, ({ state, busy, controls, message }) => {
  for (const [action, enabled] of Object.entries(controls)) byId(action).disabled = !enabled;
  byId('worker-logs').disabled = busy;
  byId('version').disabled = busy || Boolean(state?.installed);
  byId('consent').disabled = busy;
  byId('message').textContent = message;
  byId('directory').textContent = state?.directory ? `Install directory: ${state.directory}` : '';
  byId('release').textContent = state?.version ? `Pinned release: ${state.version}` : '';
  byId('operation-log').textContent = state?.directory
    ? `Operation log on your computer: ${state.directory}.extension.log`
    : '';
  const rows = byId('services');
  rows.replaceChildren();
  for (const service of state?.services ?? []) {
    const row = document.createElement('tr');
    for (const value of [service.Service, service.State, service.Health || '—']) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    rows.append(row);
  }
});

const reportError = (error) => {
  byId('message').textContent = error.message || 'Operation failed.';
};
for (const action of ['install', 'start', 'stop', 'status']) {
  byId(action).addEventListener('click', () =>
    controller.run(action, byId('version').value.trim()).catch(reportError),
  );
}
byId('consent').addEventListener('change', (event) => controller.accept(event.target.checked));
byId('open').addEventListener('click', () => {
  try {
    controller.open();
  } catch (error) {
    reportError(error);
  }
});
byId('logs').addEventListener('click', () => controller.logs('api').catch(reportError));
byId('worker-logs').addEventListener('click', () => controller.logs('worker').catch(reportError));
for (const link of document.querySelectorAll('a[data-external]')) {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    ddClient.host.openExternal(link.href);
  });
}
controller.run('status').catch(reportError);
