// Проверки реальной логики приложения без установки библиотек.
// Минимальная модель DOM не заменяет ручную проверку интерфейса в браузере.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function app(initial = { entries: [] }, backend = null) {
  const nodes = new Map(), alerts = [], downloads = [];
  let stored = typeof initial === 'string' ? initial : JSON.stringify(initial);
  let failWrite = false, nextPrompt = null;
  const extraStorage = new Map(), session = new Map();
  const document = {
    body: { children: [], append() {} }, activeElement: null,
    createElement: () => ({ click() {}, remove() {} }),
    querySelectorAll: () => [],
    querySelector: id => element(id),
    getElementById: id => element(id),
    addEventListener() {},
  };
  function element(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
      style: {}, dataset: {}, handlers: {}, isConnected: true,
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute() {}, querySelector: () => element('focus-target'),
      focus() { document.activeElement = this; },
    });
    return nodes.get(id);
  }
  const context = vm.createContext({
    document, navigator: {}, console, crypto: require('node:crypto').webcrypto, File,
    URL: { createObjectURL: file => { downloads.push(file); return 'blob:test'; }, revokeObjectURL() {} },
    ...(backend ? { KakDavnoCloud: { Client: class { constructor() { return backend; } }, decode: require('../cloud.js').decode } } : {}),
    sessionStorage: { getItem: key => session.get(key) || null, setItem: (key, value) => session.set(key, value) },
    localStorage: { getItem: key => key === 'kakdavno.v1' ? stored : extraStorage.get(key) || null, setItem: (key, value) => { if (failWrite) throw Error('Quota exceeded'); if (key === 'kakdavno.v1') stored = value; else extraStorage.set(key, value); } },
    alert: message => alerts.push(message), confirm: () => true, prompt: () => nextPrompt,
    setTimeout: () => 1, clearTimeout() {},
  });
  const instrumented = source.replace(/\}\)\(\);\s*$/, `globalThis.api = {
    validateData, statistics, agoParts, ageColor, dayNumber, toISO, today,
    tasks, openAdd, openHistory, setView, render,
    state: () => ({ entries, taskSettings, storageBlocked, mode, busy, cloudReady })
  }; })();`);
  vm.runInContext(instrumented, context);
  return {
    ...context.api, element, alerts, downloads,
    stored: () => stored,
    failWrites: () => { failWrite = true; },
    prompt: value => { nextPrompt = value; },
    click: id => element(id).handlers.click({ target: element(id) }),
    login: () => element('loginForm').handlers.submit({ preventDefault() {} }),
    import: data => element('importFile').handlers.change({ target: { value: 'copy.json', files: [{ text: async () => JSON.stringify(data) }] } }),
  };
}
const entry = (id, date, name = 'Полить цветы') => ({ id, date, name, created: 1 });

test('отметка внутри карточки предлагает сегодня, сохраняет выбранную дату и отменяется', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы');
  assert.equal(a.element('taskDateInput').value, a.toISO(a.today()));
  a.element('taskDateInput').value = '2024-01-05';
  await a.click('markTaskBtn');
  assert.equal(a.state().entries.length, 2);
  assert.equal(a.state().entries[1].date, '2024-01-05');
  assert.equal(a.state().entries[1].name, 'Полить цветы');
  await a.click('toastUndo');
  assert.equal(a.state().entries.length, 1);
  a.openHistory('полить цветы');
  assert.equal(a.element('taskDateInput').value, a.toISO(a.today()));
});

test('отметка внутри карточки отклоняет будущую дату и откатывается при ошибке записи', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы');
  a.element('taskDateInput').value = '9999-01-01';
  await a.click('markTaskBtn');
  assert.equal(a.state().entries.length, 1);
  a.element('taskDateInput').value = '2024-01-05';
  a.failWrites(); await a.click('markTaskBtn');
  assert.equal(a.state().entries.length, 1);
});

test('архивное дело нельзя отметить из карточки', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы'); await a.click('archiveBtn');
  a.openHistory('полить цветы');
  assert.equal(a.element('markTaskControls').hidden, true);
  await a.click('markTaskBtn');
  assert.equal(a.state().entries.length, 1);
});

test('читает старый формат истории без потери записей', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  assert.equal(a.state().entries.length, 1);
  assert.equal(a.tasks()[0].settings.archived, false);
});

test('различает выполнения, дни активности и медиану, включая переход года', async () => {
  const a = app();
  const result = a.statistics([
    entry('a', '2023-12-31'), entry('b', '2024-01-01'),
    entry('c', '2024-01-01'), entry('d', '2024-01-10'),
  ], new Date(2024, 0, 31));
  assert.equal(result.days, 3);
  assert.equal(result.median, 5);
  assert.equal(result.currentMonth, 3);
  assert.equal(result.months[4].count, 1);
  assert.equal(a.statistics([]).median, null);
});

test('валидирует реальные даты, типы полей, версии и повторные идентификаторы', async () => {
  const a = app();
  for (const bad of [
    { entries: {} }, { entries: [entry('a', '2024-02-31')] },
    { entries: [entry('a', '2023-02-29')] }, { entries: [entry('a', '9999-01-01')] },
    { entries: [entry('a', '2024-01-01', 42)] },
    { entries: [entry('a', '2024-01-01'), entry('a', '2024-01-02')] },
    { entries: [], version: 99 }, { entries: [], taskSettings: { test: { interval: 0 } } },
  ]) assert.throws(() => a.validateData(bad));
  assert.equal(a.validateData({ entries: [entry('a', '2024-02-29')] }).entries.length, 1);
});

test('ошибка записи откатывает добавление и не показывает успех', async () => {
  const a = app();
  a.openAdd('2024-01-01', 'Полить цветы'); a.failWrites(); await a.click('saveBtn');
  assert.equal(a.state().entries.length, 0);
  assert.equal(JSON.parse(a.stored()).entries.length, 0);
  assert.match(a.alerts.at(-1), /Изменение не сохранено/);
  assert.equal(a.element('toastText').textContent, '');
});

test('повреждённые исходные данные не перезаписываются', async () => {
  const a = app('{broken');
  a.openAdd('2024-01-01', 'Полить цветы'); await a.click('saveBtn');
  assert.equal(a.stored(), '{broken');
  assert.equal(a.state().storageBlocked, true);
});

test('импорт повторной копии не дублирует записи и сохраняет текущие настройки', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')], taskSettings: { 'полить цветы': { interval: 7, archived: true } } });
  const backup = { version: 2, entries: [entry('a', '2024-01-01'), entry('b', '2024-01-02')], taskSettings: { 'полить цветы': { interval: 2, archived: false } } };
  await a.import(backup); await a.import(backup);
  assert.equal(a.state().entries.length, 2);
  assert.equal(a.state().taskSettings['полить цветы'].interval, 7);
  assert.equal(a.state().taskSettings['полить цветы'].archived, true);
});

test('конфликт идентификаторов отменяет весь импорт', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  const before = a.stored();
  await a.import({ entries: [entry('b', '2024-01-02'), entry('a', '2024-01-03')] });
  assert.equal(a.stored(), before);
  assert.equal(a.state().entries.length, 1);
});

test('архив сохраняет историю и исключает дело только из активного списка', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы'); await a.click('archiveBtn');
  assert.equal(a.state().entries.length, 1);
  assert.equal(a.state().taskSettings['полить цветы'].archived, true);
  assert.doesNotMatch(a.element('list').innerHTML, /data-key=/);
  a.setView('archive'); assert.match(a.element('list').innerHTML, /Полить цветы/);
  a.openHistory('полить цветы'); await a.click('archiveBtn');
  assert.equal(a.state().taskSettings['полить цветы'].archived, false);
});

test('интервал и переименование сохраняют связь с историей', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы'); a.element('intervalInput').value = '14'; await a.click('saveIntervalBtn');
  a.prompt('Полить растения'); await a.click('renameBtn');
  assert.equal(a.state().entries[0].name, 'Полить растения');
  assert.equal(a.state().taskSettings['полить растения'].interval, 14);
  assert.equal(a.state().taskSettings['полить цветы'], undefined);
});

test('редактирует выбранную дату и отменяет изменение', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы');
  a.element('histList').handlers.click({ target: { closest: selector => selector === '[data-edit]' ? { dataset: { edit: 'a' } } : null } });
  a.element('dateInput').value = '2024-01-05'; await a.click('saveBtn');
  assert.equal(a.state().entries[0].date, '2024-01-05');
  await a.click('toastUndo');
  assert.equal(a.state().entries[0].date, '2024-01-01');
});

test('экранирует импортированные идентификаторы при выводе истории', async () => {
  const a = app({ entries: [entry('a" onmouseover="alert(1)', '2024-01-01')] });
  a.openHistory('полить цветы');
  assert.match(a.element('histList').innerHTML, /&quot;/);
  assert.doesNotMatch(a.element('histList').innerHTML, /data-id="a" onmouseover/);
});

test('365 дней отображаются как год, интервал влияет на цвет', async () => {
  const a = app();
  assert.equal(a.agoParts(365)[0], 1);
  assert.equal(a.ageColor(13, 14), 'var(--fresh)');
  assert.equal(a.ageColor(14, 14), 'var(--mid)');
  assert.equal(a.ageColor(15, 14), 'var(--old)');
  assert.equal(a.dayNumber('2024-04-01') - a.dayNumber('2024-03-30'), 2);
});

test('ошибка сохранения архива откатывает настройки', async () => {
  const a = app({ entries: [entry('a', '2024-01-01')] });
  a.openHistory('полить цветы'); a.failWrites(); await a.click('archiveBtn');
  assert.equal(a.tasks()[0].settings.archived, false);
  assert.match(a.element('list').innerHTML, /Полить цветы/);
});

test('ошибка сохранения импорта откатывает записи и новые настройки', async () => {
  const a = app(); a.failWrites();
  await a.import({ version: 2, entries: [entry('a', '2024-01-01')], taskSettings: { 'полить цветы': { interval: 7, archived: true } } });
  assert.equal(a.state().entries.length, 0);
  assert.equal(a.state().taskSettings['полить цветы'], undefined);
});

test('резервная копия v2 восстанавливает историю, интервал и архив', async () => {
  const a = app();
  await a.import({ app: 'kak-davno', version: 2, entries: [entry('a', '2024-01-01')], taskSettings: { 'полить цветы': { interval: 7, archived: true } } });
  const reloaded = app(a.stored());
  assert.equal(reloaded.state().entries.length, 1);
  assert.equal(reloaded.tasks()[0].settings.archived, true);
  assert.equal(reloaded.tasks()[0].settings.interval, 7);
});

test('календарь различает два выполнения в один день', async () => {
  const a = app();
  const date = a.toISO(a.today());
  const b = app({ entries: [entry('a', date), entry('b', date)] });
  b.setView('cal');
  b.element('calFilter').handlers.change({ target: { value: 'полить цветы' } });
  assert.match(b.element('dayPanel').innerHTML, /выполнений — 2, дней активности — 1/);
  b.openHistory('полить цветы');
  assert.match(b.element('taskStats').innerHTML, /пока мало данных/);
});

// Модель сервера для проверки переключения режимов. SQL проверяется отдельно verify.sql.
function backend() {
  const { encode } = require('../cloud.js');
  let data = { revision: 0, imports: [], tasks: [], entries: [] };
  const api = {
    configured: true, signedIn: false, fail: false, calls: 0,
    restoreSession: () => false,
    async signIn() { api.signedIn = true; },
    async signOut() { api.signedIn = false; },
    async load() { if (api.fail) throw Error('Сеть недоступна'); return structuredClone(data); },
    async save(snapshot, revision, source) {
      api.calls++;
      if (api.pending) await api.pending;
      if (api.fail) throw Error('Сеть недоступна');
      if (source && data.imports.includes(source)) return structuredClone(data);
      if (revision !== data.revision) throw Error('Конфликт версии');
      const encoded = encode(snapshot);
      data = { ...encoded, revision: data.revision + 1, imports: source ? [...data.imports, source] : data.imports };
      return structuredClone(data);
    },
    changeElsewhere: () => { data.revision++; },
  };
  return api;
}

test('вход открывает облако, сохранение и выход не перезаписывают локальную историю', async () => {
  const server = backend();
  const a = app({ entries: [entry('local', '2024-01-01', 'Локальное дело')] }, server);
  const original = a.stored();
  await a.login();
  assert.equal(a.state().mode, 'cloud'); assert.equal(a.state().entries.length, 0);
  a.openAdd('2024-01-02', 'Облачное дело'); await a.click('saveBtn');
  assert.equal(a.state().entries.length, 1); assert.equal(a.stored(), original);
  await a.click('localModeBtn');
  assert.equal(a.state().mode, 'local'); assert.equal(a.state().entries[0].id, 'local');
});

test('облачная ошибка откатывает действие и требует загрузки перед следующей записью', async () => {
  const server = backend(), a = app({ entries: [] }, server);
  await a.login(); server.fail = true;
  a.openAdd('2024-01-01', 'Дело'); await a.click('saveBtn');
  assert.equal(a.state().entries.length, 0); assert.equal(a.state().cloudReady, false);
  server.fail = false; await a.click('saveBtn');
  assert.equal(server.calls, 1); assert.equal(a.state().entries.length, 0);
  await a.click('reloadCloudBtn');
  assert.equal(a.state().cloudReady, true);
});

test('устаревшая вкладка не перезаписывает чужое изменение', async () => {
  const server = backend(), a = app({ entries: [] }, server);
  await a.login(); server.changeElsewhere();
  a.openAdd('2024-01-01', 'Дело'); await a.click('saveBtn');
  assert.equal(a.state().entries.length, 0);
  assert.match(a.alerts.at(-1), /Конфликт/);
});

test('пока сохранение не завершено, второе действие не меняет снимок', async () => {
  const server = backend(), a = app({ entries: [] }, server);
  await a.login();
  let finish; server.pending = new Promise(resolve => { finish = resolve; });
  a.openAdd('2024-01-01', 'Дело'); const first = a.click('saveBtn');
  assert.equal(a.state().busy, true);
  await a.click('saveBtn'); assert.equal(server.calls, 1);
  finish(); await first;
  assert.equal(a.state().entries.length, 1); assert.equal(a.state().busy, false);
});

test('перенос требует подтверждения копии и не воскрешает удалённые записи', async () => {
  const server = backend(), a = app({ entries: [entry('local', '2024-01-01')] }, server);
  const original = a.stored(); await a.login();
  await a.click('migrateBtn'); await a.click('confirmMigrationBtn');
  assert.equal(server.calls, 0);
  a.element('backupConfirmed').checked = true; await a.click('confirmMigrationBtn');
  assert.equal(a.state().entries.length, 1); assert.equal(a.stored(), original);
  a.openHistory('полить цветы'); await a.click('deleteTaskBtn');
  await a.click('migrateBtn'); await a.click('confirmMigrationBtn');
  assert.equal(a.state().entries.length, 0);
  assert.match(a.element('cloudNotice').textContent, /уже перенесена/);
});

test('переименование облачного дела сохраняет его ID', async () => {
  const server = backend(), a = app({ entries: [] }, server);
  await a.login(); a.openAdd('2024-01-01', 'Дело'); await a.click('saveBtn');
  const id = a.state().taskSettings['дело'].id;
  a.openHistory('дело'); a.prompt('Новое название'); await a.click('renameBtn');
  assert.equal(a.state().taskSettings['новое название'].id, id);
});

test('резервная копия перед переносом содержит локальные, а не облачные записи', async () => {
  const a = app({ entries: [entry('local', '2024-01-01')] }, backend());
  await a.login();
  assert.equal(a.state().entries.length, 0);
  await a.click('localBackupBtn');
  assert.equal(a.downloads.length, 1);
  assert.equal(JSON.parse(await a.downloads[0].text()).entries[0].id, 'local');
});
