const local = require('./scripts/local-modules.cjs');
module.exports = {
  hooks: { readPackage: local.effectivePackage, updateConfig: local.updateConfig },
};
