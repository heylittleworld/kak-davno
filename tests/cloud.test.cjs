const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, encode, decode } = require('../cloud.js');
const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' };
const session = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, user: { id: 'test-user' } };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function storage() { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; }

test('авторизация передаёт публичный ключ и пароль только в запросе Auth', async () => {
  const calls = [], cache = storage();
  const c = new Client(config, { storage: cache, fetch: async (url, options) => { calls.push({ url, options }); return response(url.includes('/auth/') ? session : { revision: 0 }); } });
  await c.signIn('test@example.com', 'not-a-real-password'); await c.load();
  assert.match(calls[0].url, /token\?grant_type=password$/);
  assert.equal(calls[0].options.headers.apikey, config.publishableKey);
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-access');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.doesNotMatch(cache.getItem(c.sessionKey), /not-a-real-password/);
});

test('просроченная сессия обновляется один раз для параллельных запросов', async () => {
  let refreshes = 0;
  const c = new Client(config, { storage: storage(), fetch: async url => {
    if (url.includes('refresh_token')) { refreshes++; return response({ ...session, access_token: 'new-access' }); }
    return response({});
  } });
  c.storeSession({ ...session, expires_in: -1 });
  await Promise.all([c.load(), c.load()]);
  assert.equal(refreshes, 1); assert.equal(c.session.access_token, 'new-access');
});

test('сессия восстанавливается после перезагрузки вкладки', () => {
  const cache = storage();
  const first = new Client(config, { storage: cache }); first.storeSession(session);
  const second = new Client(config, { storage: cache });
  assert.equal(second.restoreSession(), true);
  assert.equal(second.session.user.id, 'test-user');
});

test('отказ обновления сессии очищает локальные токены', async () => {
  const c = new Client(config, { storage: storage(), fetch: async () => response({}, 400) });
  c.storeSession({ ...session, expires_in: -1 });
  await assert.rejects(c.load(), error => error.code === 'AUTH');
  assert.equal(c.signedIn, false);
});

test('конфликт версии распознаётся без автоматического повтора записи', async () => {
  let calls = 0;
  const c = new Client(config, { storage: storage(), fetch: async () => { calls++; return response({ message: 'KD_CONFLICT' }, 409); } });
  c.storeSession(session);
  await assert.rejects(c.save({ entries: [], taskSettings: {} }, 1), error => error.code === 'CONFLICT');
  assert.equal(calls, 1);
});

test('сетевая ошибка не выдаётся за успешное сохранение; выход очищает сессию', async () => {
  const cache = storage();
  const c = new Client(config, { storage: cache, fetch: async () => { throw Error('offline'); } });
  c.storeSession(session);
  await assert.rejects(c.load(), error => error.code === 'NETWORK');
  await assert.rejects(c.signOut());
  assert.equal(c.signedIn, false); assert.equal(cache.getItem(c.sessionKey), null);
});

test('секретный ключ и произвольный URL не принимаются конфигурацией', () => {
  for (const invalid of [{ ...config, publishableKey: 'sb_secret_test' }, { ...config, url: 'https://example.org' }, { ...config, url: 'http://example.supabase.co' }]) assert.equal(new Client(invalid).configured, false);
});

test('кодирование сохраняет ID дела, архив и повторные выполнения', () => {
  const data = { taskSettings: { 'дело': { id: 'stable', interval: 3, archived: true } }, entries: [
    { id: 'a', name: 'Дело', date: '2024-01-01', created: 1 }, { id: 'b', name: 'Дело', date: '2024-01-01', created: 2 },
  ] };
  const encoded = encode(data);
  assert.equal(encoded.tasks.length, 1); assert.equal(encoded.tasks[0].id, 'stable');
  assert.equal(encoded.entries.length, 2);
  const decoded = decode({ ...encoded, revision: 1, imports: [] });
  assert.deepEqual(decoded.entries, data.entries);
  assert.deepEqual(decoded.taskSettings['дело'], data.taskSettings['дело']);
});

test('новый запуск использует постоянное хранилище, а не сессию вкладки', async () => {
  const vm = require('node:vm');
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'cloud.js'), 'utf8');
  const persistent = storage();
  function launch() {
    const box = { localStorage: persistent, sessionStorage: storage(), fetch: async () => response(session), AbortController, setTimeout, clearTimeout };
    vm.runInNewContext(source, box);
    return new box.KakDavnoCloud.Client(config);
  }
  const first = launch(); await first.signIn('test@example.com', 'fake-password');
  const reopened = launch();
  assert.equal(reopened.restoreSession(), true);
  assert.equal(reopened.session.user.id, 'test-user');
  await reopened.signOut();
  assert.equal(launch().restoreSession(), false);
});

function locks() {
  let tail = Promise.resolve();
  return { request(name, action) { const next = tail.then(action); tail = next.catch(() => {}); return next; } };
}

test('две вкладки обновляют общий токен один раз и замечают выход', async () => {
  const cache = storage(), sharedLocks = locks();
  let refreshes = 0;
  const options = { storage: cache, locks: sharedLocks, fetch: async url => {
    if (url.includes('refresh_token')) { refreshes++; return response({ ...session, access_token: 'fresh', refresh_token: 'rotated' }); }
    return response({});
  } };
  const a = new Client(config, options), b = new Client(config, options);
  a.storeSession({ ...session, expires_in: -1 }); b.restoreSession();
  await Promise.all([a.load(), b.load()]);
  assert.equal(refreshes, 1);
  assert.equal(b.session.refresh_token, 'rotated');
  await a.signOut();
  await assert.rejects(b.load(), error => error.code === 'AUTH');
  assert.equal(b.signedIn, false);
});

test('потеря сети при обновлении не стирает вход и допускает повторную загрузку', async () => {
  const cache = storage(); let offline = true;
  const c = new Client(config, { storage: cache, fetch: async url => {
    if (offline) throw Error('offline');
    return response(url.includes('refresh_token') ? session : {});
  } });
  c.storeSession({ ...session, expires_in: -1 });
  await assert.rejects(c.load(), error => error.code === 'NETWORK');
  assert.equal(c.signedIn, true);
  assert.notEqual(cache.getItem(c.sessionKey), null);
  offline = false; await c.load();
  assert.equal(c.signedIn, true);
});
