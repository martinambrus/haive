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
  /** Explicit API address. A different hostname uses the web's session proxy in the browser. */
  apiUrl?: string;
  /** The port the api is published on. Combined with the browser's own protocol and hostname. */
  apiPort?: string;
  /** Optional dedicated editor origin, shared with the API configuration. */
  editorOrigin?: string;
}

export interface ApiOriginInputs {
  /** Injected by the root layout. Absent when the page was served by an older build. */
  config: RuntimeApiConfig | undefined;
  /** `window.location` — protocol includes its colon, e.g. `https:`. */
  location: { protocol: string; hostname: string; port?: string } | undefined;
  /** The build-time value, kept as the last resort so nothing regresses for an install that
   *  never set any of this. */
  buildTime: string | undefined;
}

export const FALLBACK_API_URL = 'http://localhost:3001';
export const API_PROXY_PATH = '/api/haive';

/** The config the server hands the browser, from the container's environment. Server-only: these
 *  names are not `NEXT_PUBLIC_*`, so the client bundle reads them as undefined. */
export function runtimeApiConfig(): RuntimeApiConfig {
  // A blank or whitespace value is unset, as `resolveServerApiBase` reads it.
  const apiUrl = process.env.HAIVE_PUBLIC_API_URL?.trim();
  const apiPort = process.env.HAIVE_API_PORT?.trim();
  const editorOrigin = process.env.HAIVE_EDITOR_ORIGIN?.trim();
  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(apiPort ? { apiPort } : {}),
    ...(editorOrigin ? { editorOrigin } : {}),
  };
}

export interface ApiTransport {
  base: string;
  viaWebProxy: boolean;
}

/** Carries the transport decision with the address; a configured path is never a mode flag. */
export function resolveApiTransport(inputs: ApiOriginInputs): ApiTransport {
  const { config, location, buildTime } = inputs;

  const browserBase = (api: string): ApiTransport => {
    let direct = false;
    try {
      const parsed = new URL(api);
      direct =
        ['http:', 'https:'].includes(parsed.protocol) &&
        (!location || parsed.hostname === location.hostname);
    } catch {
      // Keep the document renderable. The server proxy diagnoses invalid config and answers 502.
    }
    if (location && !direct) {
      const port = location.port ? `:${location.port}` : '';
      return {
        base: `${location.protocol}//${location.hostname}${port}${API_PROXY_PATH}`,
        viaWebProxy: true,
      };
    }
    return { base: stripTrailingSlash(api), viaWebProxy: false };
  };
  if (config?.apiUrl) return browserBase(config.apiUrl);

  // The common case. `hostname`, never `host`: `host` carries the WEB app's port, which is
  // exactly the part being replaced.
  if (config?.apiPort && location) {
    return {
      base: `${location.protocol}//${location.hostname}:${config.apiPort}`,
      viaWebProxy: false,
    };
  }

  return browserBase(buildTime?.trim() || FALLBACK_API_URL);
}

export function resolveApiOrigin(inputs: ApiOriginInputs): string {
  return resolveApiTransport(inputs).base;
}

/** `new URL(path, base)` treats a trailing slash as significant, and an operator writing a base
 *  URL is as likely to include one as not. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** CSP must name the public editor host, even when app API calls use the web session proxy.
 * The API returns the authoritative grant URL; this helper only configures allowed frames. */
export function resolveEditorOrigin({ config, location, buildTime }: ApiOriginInputs): string {
  const api =
    config?.apiUrl ||
    (config?.apiPort && location
      ? `${location.protocol}//${location.hostname}:${config.apiPort}`
      : buildTime?.trim() || FALLBACK_API_URL);
  try {
    const url = new URL(config?.editorOrigin || api);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
  } catch {
    return '';
  }
}
