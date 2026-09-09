/**
 * Which origin the BROWSER should call the api on.
 *
 * `NEXT_PUBLIC_API_URL` cannot answer this. Next inlines every `NEXT_PUBLIC_*` value into the
 * client bundle at BUILD time, so a published `haive-web` image carries whatever the builder
 * chose — `http://localhost:3001` — and no runtime environment can change it. MEASURED on a real
 * v0.2.0-rc.1 install whose api the installer had moved to 3003 because 3001 was taken: the
 * browser POSTed to `http://localhost:3001/auth/register` and every client call failed, while the
 * server-rendered shell around them worked, because SSR reads `API_URL_INTERNAL` instead.
 *
 * That made two shipped features contradict each other. The installer probes host ports precisely
 * so a second install, or a machine already running something on 3001, gets free ones — and doing
 * so moved the api somewhere the UI could not reach.
 *
 * So the value is resolved at RUNTIME from config the server injects into the document. Deriving
 * the host from `location` rather than trusting a configured hostname also fixes a case that never
 * worked: a browser on another machine reaching this install by IP or DNS name, for which
 * `localhost` was always the wrong answer.
 */

export interface RuntimeApiConfig {
  /** Explicit, absolute, and wins outright. For a reverse proxy or a public hostname, where the
   *  api is not simply "this host on another port". */
  apiUrl?: string;
  /** The port the api is published on. Combined with the browser's own protocol and hostname. */
  apiPort?: string;
}

export interface ApiOriginInputs {
  /** Injected by the root layout. Absent when the page was served by an older build. */
  config: RuntimeApiConfig | undefined;
  /** `window.location` — protocol includes its colon, e.g. `https:`. */
  location: { protocol: string; hostname: string } | undefined;
  /** The build-time value, kept as the last resort so nothing regresses for an install that
   *  never set any of this. */
  buildTime: string | undefined;
}

export const FALLBACK_API_URL = 'http://localhost:3001';

export function resolveApiOrigin(inputs: ApiOriginInputs): string {
  const { config, location, buildTime } = inputs;

  // An operator who states the URL means it: a reverse proxy can put the api on a path, a
  // different host, or the same port as the web app, and none of that is derivable.
  if (config?.apiUrl) return stripTrailingSlash(config.apiUrl);

  // The common case. `hostname`, never `host`: `host` carries the WEB app's port, which is
  // exactly the part being replaced.
  if (config?.apiPort && location) {
    return `${location.protocol}//${location.hostname}:${config.apiPort}`;
  }

  return stripTrailingSlash(buildTime ?? FALLBACK_API_URL);
}

/** `new URL(path, base)` treats a trailing slash as significant, and an operator writing a base
 *  URL is as likely to include one as not. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
