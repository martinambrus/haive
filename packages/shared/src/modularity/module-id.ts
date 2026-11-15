// databaseName('module', id) must fit Postgres' 63-byte identifier under the longest install id:
// 63 - 33 ('<32 chars>_') - 7 ('module_') = 23.
export const MODULE_ID_MAX_LENGTH = 23;
export const MODULE_ID_PATTERN_SOURCE = `[a-z0-9][a-z0-9-]{0,${MODULE_ID_MAX_LENGTH - 1}}`;
export const MODULE_ID_PATTERN = new RegExp(`^${MODULE_ID_PATTERN_SOURCE}$`);
