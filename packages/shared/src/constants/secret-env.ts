/** Env-var names that look like secrets: routed to the encrypted store instead of plaintext
 *  provider env vars (guards against pasting a key in the wrong box). */
export const SECRET_LIKE_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

/** Partition env vars into plaintext env vars and secret-like ones (by name), so the caller can
 *  store the latter encrypted rather than as plaintext. */
export function splitSecretLikeEnv(env: Record<string, string>): {
  envVars: Record<string, string>;
  secrets: Record<string, string>;
} {
  const envVars: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_LIKE_ENV_NAME.test(k)) secrets[k] = v;
    else envVars[k] = v;
  }
  return { envVars, secrets };
}
