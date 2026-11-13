// Локальный просмотр без установки библиотек. Только 127.0.0.1.
// node tests/preview.cjs — реальные файлы с незаполненной/пользовательской конфигурацией.
// node tests/preview.cjs --mock-cloud — тестовая модель облака, без сетевых обращений в Supabase.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mock = process.argv.includes('--mock-cloud');
const allowed = new Set(['index.html', 'sw.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'cloud.js', 'supabase-config.js']);
let data = { revision: 0, tasks: [], entries: [], imports: [] };
http.createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (mock && route.startsWith('/__mock/')) {
    if (req.method !== 'POST') return send({}, 405);
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 5000000) { req.destroy(); return; } }
    try {
      const body = JSON.parse(raw);
      if (route === '/__mock/auth/v1/token') {
        if (body.email !== 'test@example.test' && body.refresh_token !== 'mock-refresh') return send({}, 400);
        return send({ access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600, user: { id: '00000000-0000-4000-8000-000000000001' } });
      }
      if (req.headers.authorization !== 'Bearer mock-access') return send({}, 401);
      if (route === '/__mock/auth/v1/logout') { res.writeHead(204); res.end(); return; }
      if (route === '/__mock/rest/v1/rpc/kd_load') return send(data);
      if (route === '/__mock/rest/v1/rpc/kd_save') {
        if (body.p_import_id && data.imports.includes(body.p_import_id)) return send(data);
        if (body.p_revision !== data.revision) return send({ message: 'KD_CONFLICT' }, 409);
        data = { ...body.p_data, revision: data.revision + 1, imports: body.p_import_id ? [...data.imports, body.p_import_id] : data.imports };
        return send(data);
      }
      return send({}, 404);
    } catch { return send({}, 400); }
  }
  const file = route.slice(1) || 'index.html';
  if (!allowed.has(file)) { res.writeHead(404); res.end(); return; }
  let body = fs.readFileSync(path.join(root, file));
  if (mock && file === 'supabase-config.js') body = Buffer.from(`
    globalThis.KAK_DAVNO_SUPABASE = { url: 'https://browser-test.supabase.co', publishableKey: 'sb_publishable_mock' };
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (url, options) => {
      if (typeof url === 'string' && url.startsWith('https://browser-test.supabase.co/'))
        return realFetch('/__mock' + new URL(url).pathname + new URL(url).search, options);
      return realFetch(url, options);
    };
  `);
  // Mock-конфигурация не должна попадать в кэш установленного приложения.
  if (mock && file === 'index.html') body = Buffer.from(body.toString().replace("if ('serviceWorker' in navigator)", "if (false)"));
  const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.json') ? 'application/json' : 'image/png';
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }); res.end(body);
}).listen(mock ? 4174 : 4173, '127.0.0.1', () => console.log(mock ? 'Mock preview: http://127.0.0.1:4174 (test@example.test, любой тестовый пароль)' : 'Preview: http://127.0.0.1:4173'));
