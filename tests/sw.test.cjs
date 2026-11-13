const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('service worker пропускает запросы Supabase и посторонние файлы без кэширования', () => {
  const handlers = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), {
    URL, self: { registration: { scope: 'https://example.org/kak-davno/' }, location: { origin: 'https://example.org' }, addEventListener: (event, fn) => { handlers[event] = fn; } },
  });
  for (const [method, url] of [
    ['GET', 'https://example.supabase.co/auth/v1/user'],
    ['GET', 'https://example.supabase.co/rest/v1/kd_entries'],
    ['POST', 'https://example.supabase.co/rest/v1/rpc/kd_load'],
    ['GET', 'https://example.org/another-app/index.html'],
  ]) {
    let intercepted = false;
    handlers.fetch({ request: { method, url }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false);
  }
});
