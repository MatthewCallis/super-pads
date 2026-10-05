/**
 * Load the published ESM tools from CommonJS modules running in Node or Node worker threads.
 * Callers in Electron must use Node threads; Chromium's renderer and worker loaders cannot load this package.
 * Import failures reject the caller's operation; Node caches successful imports within each thread.
 */
module.exports = function loadDataTools() {
  return import('@uttori/data-tools');
};
