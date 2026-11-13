/* Личный облачный режим: Auth + атомарные RPC, без внешних библиотек. */
(() => {
  'use strict';
  const normalize = s => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
  class CloudError extends Error {
    constructor(message, code = 'NETWORK') { super(message); this.code = code; }
  }
  function encode(data, uuid = () => crypto.randomUUID()) {
    const grouped = new Map();
    for (const entry of data.entries) {
      const key = normalize(entry.name);
      if (!grouped.has(key)) {
        const settings = data.taskSettings[key] || {};
        grouped.set(key, { id: settings.id || uuid(), name: entry.name, archived: settings.archived === true, interval_days: settings.interval ?? null });
      }
    }
    return {
      tasks: [...grouped.values()],
      entries: data.entries.map(e => ({ id: e.id, task_id: grouped.get(normalize(e.name)).id, date: e.date, created: e.created })),
    };
  }
  function decode(data) {
    if (!data || !Number.isSafeInteger(data.revision) || !Array.isArray(data.tasks) || !Array.isArray(data.entries) || !Array.isArray(data.imports)) throw new CloudError('Облако вернуло неизвестный формат данных.', 'DATA');
    const byId = new Map(data.tasks.map(t => [t.id, t]));
    const taskSettings = Object.create(null);
    for (const t of data.tasks) taskSettings[normalize(t.name)] = { id: t.id, interval: t.interval_days, archived: t.archived };
    return {
      version: 2, taskSettings,
      entries: data.entries.map(e => {
        const task = byId.get(e.task_id);
        if (!task) throw new CloudError('Не найдена связь записи с делом.', 'DATA');
        return { id: e.id, name: task.name, date: e.date, created: e.created };
      }),
    };
  }
  class Client {
    constructor(config, options = {}) {
      this.config = config || {};
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.storage = options.storage;
      if (!this.storage) { try { this.storage = globalThis.sessionStorage; } catch {} }
      this.session = null;
      this.sessionKey = 'kakdavno.auth.' + this.config.url;
      this.refreshing = null;
    }
    get configured() { return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(this.config.url || '') && /^sb_publishable_[A-Za-z0-9_-]+$/.test(this.config.publishableKey || ''); }
    get signedIn() { return Boolean(this.session); }
    storeSession(data) {
      if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !data.user?.id || !Number.isFinite(data.expires_in)) throw new CloudError('Не удалось прочитать ответ входа.', 'AUTH');
      this.session = { access_token: data.access_token, refresh_token: data.refresh_token, user: { id: data.user.id }, expires_at: Date.now() + data.expires_in * 1000 };
      try { this.storage?.setItem(this.sessionKey, JSON.stringify(this.session)); } catch { /* Сессия останется в памяти до перезагрузки. */ }
    }
    forget() { this.session = null; try { this.storage?.removeItem(this.sessionKey); } catch {} }
    restoreSession() {
      if (!this.configured) return false;
      try {
        const saved = JSON.parse(this.storage?.getItem(this.sessionKey) || 'null');
        if (saved && typeof saved.access_token === 'string' && typeof saved.refresh_token === 'string' && saved.user?.id && Number.isFinite(saved.expires_at)) this.session = saved;
      } catch { this.forget(); }
      return this.signedIn;
    }
    async request(path, body, token) {
      if (!this.configured) throw new CloudError('Сначала настрой отдельный проект по инструкции SUPABASE.md.', 'CONFIG');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const headers = { apikey: this.config.publishableKey, 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        const response = await this.fetch(this.config.url + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          if (error.message === 'KD_CONFLICT') throw new CloudError('Данные изменились на другом устройстве. Нажми «Загрузить из облака» и повтори действие.', 'CONFLICT');
          if (error.message === 'KD_FORBIDDEN') throw new CloudError('Этот аккаунт не назначен владельцем приложения. Проверь настройку владельца в SUPABASE.md.', 'FORBIDDEN');
          if (response.status === 401 || response.status === 400 && path.startsWith('/auth/')) throw new CloudError('Не удалось войти или сессия истекла. Проверь email и пароль и войди снова.', 'AUTH');
          throw new CloudError('Облако отклонило запрос. Проверь настройки проекта и SQL по инструкции SUPABASE.md.', 'SERVER');
        }
        return response.status === 204 ? null : await response.json();
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError('Нет ответа от облака. Результат сохранения неизвестен; загрузи данные из облака перед повтором.');
      } finally { clearTimeout(timer); }
    }
    async signIn(email, password) {
      this.forget();
      this.storeSession(await this.request('/auth/v1/token?grant_type=password', { email, password }));
    }
    async token() {
      if (!this.session) throw new CloudError('Войди в личный аккаунт.', 'AUTH');
      if (this.session.expires_at <= Date.now() + 60000) {
        if (!this.refreshing) this.refreshing = (async () => {
          try { this.storeSession(await this.request('/auth/v1/token?grant_type=refresh_token', { refresh_token: this.session.refresh_token })); }
          catch (error) { if (error.code === 'AUTH') this.forget(); throw error; }
          finally { this.refreshing = null; }
        })();
        await this.refreshing;
      }
      return this.session.access_token;
    }
    async rpc(name, body = {}) { return this.request('/rest/v1/rpc/' + name, body, await this.token()); }
    load() { return this.rpc('kd_load'); }
    save(data, revision, importId = null) { return this.rpc('kd_save', { p_data: encode(data), p_revision: revision, p_import_id: importId }); }
    async signOut() {
      try { if (this.session) await this.request('/auth/v1/logout?scope=local', {}, await this.token()); }
      finally { this.forget(); }
    }
  }
  const api = { Client, CloudError, encode, decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.KakDavnoCloud = api;
})();
