// Test process only. The production importer still validates the URL and all redirects.
const http = require('node:http');
const { syncBuiltinESMExports } = require('node:module');
const get = http.get;
const fixturePort = Number(process.env.A11Y_TEST_UPSTREAM_PORT);
http.get = function (url, options, callback) {
  if (url instanceof URL && url.origin === 'http://93.184.216.34' && fixturePort) {
    // Forward only the fixed test origin. Other calls use the original transport.
    const local = new URL(url.pathname + url.search, `http://127.0.0.1:${fixturePort}`);
    const { lookup, ...rest } = options;
    return get.call(this, local, rest, callback);
  }
  return get.apply(this, arguments);
};
syncBuiltinESMExports();
