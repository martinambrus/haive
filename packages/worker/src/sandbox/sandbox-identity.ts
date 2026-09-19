/** Numeric identity of the `node` user baked into the cli sandbox image. */
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;
/** That user's home: every sandbox run starts with HOME set to it. A leaf module, so adapters
 *  can name paths under it without importing the sandbox runner. */
export const SANDBOX_USER_HOME = '/home/node';
