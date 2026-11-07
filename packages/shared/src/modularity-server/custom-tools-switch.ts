import { CONFIG_KEYS, type ConfigService } from '../config/config.service.js';

/** An absent key reads on, as the seed has it, for every reader. A config outage throws and no caller catches it. */
export const resolveCustomToolsEnabled = (
  config: Pick<ConfigService, 'getBoolean'>,
): Promise<boolean> => config.getBoolean(CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED, true);
