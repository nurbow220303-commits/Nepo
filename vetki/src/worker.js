import { DurableObject } from 'cloudflare:workers';
import { generateVapid, sendPush } from './push.js';

const ACCOUNTS = ['ru', 'kz'];
const MAX_FAILS = 8;
const LOCK_MS = 30 * 60 * 1000;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vetki:' + text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Время веток — по Казахстану (UTC+5).
export function postTs(deck, p) {
  const date = p.date || addDays(deck.start, p.day - 1);
  return Date.parse(`${date}T${p.time}:00+05:00`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.STORE.get(env.STORE.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class Store extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const st = this.ctx.storage;

    try {
      if (path === '/api/status' && method === 'GET') {
        return json({ hasPin: !!(await st.get('pinHash')) });
      }

      if (path === '/api/setup' && method === 'POST') {
        if (await st.get('pinHash')) return json({ error: 'PIN уже задан' }, 409);
        const { pin } = await request.json();
        if (!/^\d{4,8}$/.test(String(pin || ''))) return json({ error: 'PIN — от 4 до 8 цифр' }, 400);
        await st.put('pinHash', await sha(pin));
        await st.put('origin', url.origin);
        return json({ ok: true });
      }

      // Всё ниже — только с верным PIN.
      const lock = (await st.get('lock')) || { fails: 0, until: 0 };
      if (lock.until > Date.now()) return json({ error: 'Слишком много попыток. Подождите 30 минут.' }, 429);
      const pinHash = await st.get('pinHash');
      const given = request.headers.get('x-pin') || '';
      if (!pinHash || !given || (await sha(given)) !== pinHash) {
        lock.fails += 1;
        if (lock.fails >= MAX_FAILS) { lock.until = Date.now() + LOCK_MS; lock.fails = 0; }
        await st.put('lock', lock);
        return json({ error: 'Неверный PIN' }, 401);
      }
      if (lock.fails) await st.put('lock', { fails: 0, until: 0 });

      if (path === '/api/login' && method === 'POST') return json({ ok: true });

      if (path === '/api/state' && method === 'GET') {
        const decks = {};
        for (const acc of ACCOUNTS) { const d = await st.get('deck:' + acc); if (d) decks[acc] = d; }
        const subs = (await st.get('subs')) || [];
        return json({ decks, pushDevices: subs.length });
      }

      const deckMatch = path.match(/^\/api\/deck\/(ru|kz)$/);
      if (deckMatch && method === 'PUT') {
        const text = await request.text();
        if (text.length > 1_500_000) return json({ error: 'Слишком большой объём' }, 413);
        const deck = JSON.parse(text);
        if (!deck || !Array.isArray(deck.posts) || !/^\d{4}-\d{2}-\d{2}$/.test(deck.start || '')) return json({ error: 'Неверные данные' }, 400);
        await st.put('deck:' + deckMatch[1], deck);
        await this.schedule();
        return json({ ok: true });
      }

      if (path === '/api/vapid' && method === 'GET') {
        return json({ publicKey: (await this.vapid()).pub });
      }

      if (path === '/api/subscribe' && method === 'POST') {
        const sub = await request.json();
        if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return json({ error: 'Неверная подписка' }, 400);
        }
        let subs = (await st.get('subs')) || [];
        subs = subs.filter(s => s.endpoint !== sub.endpoint);
        subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: Date.now() });
        if (subs.length > 10) subs = subs.slice(-10);
        await st.put('subs', subs);
        await st.put('origin', url.origin);
        return json({ ok: true, devices: subs.length });
      }

      if (path === '/api/test' && method === 'POST') {
        const res = await this.notifyAll({ title: 'Ветки', body: 'Уведомления работают. Так придёт напоминание о каждой ветке.', url: '/', tag: 'test' });
        return json(res);
      }

      return json({ error: 'Не найдено' }, 404);
    } catch (e) {
      return json({ error: 'Ошибка сервера', detail: String(e && e.message || e) }, 500);
    }
  }

  async vapid() {
    let v = await this.ctx.storage.get('vapid');
    if (!v) { v = await generateVapid(); await this.ctx.storage.put('vapid', v); }
    return v;
  }

  async loadDecks() {
    const decks = {};
    for (const acc of ACCOUNTS) { const d = await this.ctx.storage.get('deck:' + acc); if (d) decks[acc] = d; }
    return decks;
  }

  // Ставит будильник на ближайшую сохранённую ветку, о которой ещё не напоминали.
  async schedule() {
    const decks = await this.loadDecks();
    const notified = (await this.ctx.storage.get('notified')) || {};
    const now = Date.now();
    let next = null;
    for (const [acc, d] of Object.entries(decks)) {
      for (const p of d.posts) {
        if (p.status !== 'saved') continue;
        const ts = postTs(d, p);
        if (Number.isNaN(ts) || ts < now - 60 * 60 * 1000) continue;
        if (notified[`${acc}:${p.id}:${ts}`]) continue;
        if (next === null || ts < next) next = ts;
      }
    }
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  async alarm() {
    const decks = await this.loadDecks();
    const notified = (await this.ctx.storage.get('notified')) || {};
    const now = Date.now();
    for (const [acc, d] of Object.entries(decks)) {
      for (const p of d.posts) {
        if (p.status !== 'saved') continue;
        const ts = postTs(d, p);
        const key = `${acc}:${p.id}:${ts}`;
        if (notified[key] || ts > now + 30 * 1000 || ts < now - 60 * 60 * 1000) continue;
        const preview = p.text.replace(/\s+/g, ' ').slice(0, 120);
        await this.notifyAll({
          title: `Пора публиковать · ${p.time}`,
          body: `${acc.toUpperCase()} · ${p.type}: ${preview}`,
          url: `/#${acc}:${p.id}`,
          tag: key,
        });
        notified[key] = now;
      }
    }
    for (const k of Object.keys(notified)) if (notified[k] < now - 14 * 24 * 3600 * 1000) delete notified[k];
    await this.ctx.storage.put('notified', notified);
    await this.schedule();
  }

  async notifyAll(data) {
    const subs = (await this.ctx.storage.get('subs')) || [];
    if (!subs.length) return { sent: 0, devices: 0 };
    const vapid = await this.vapid();
    const subject = (await this.ctx.storage.get('origin')) || 'https://vetki.workers.dev';
    const keep = [];
    let sent = 0;
    for (const s of subs) {
      try {
        const status = await sendPush(s, data, vapid, subject);
        if (status === 404 || status === 410) continue; // подписка больше не действует
        if (status >= 200 && status < 300) sent++;
        keep.push(s);
      } catch (e) {
        keep.push(s);
      }
    }
    if (keep.length !== subs.length) await this.ctx.storage.put('subs', keep);
    return { sent, devices: keep.length };
  }
}
