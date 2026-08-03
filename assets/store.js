/*
 * 예약 데이터 저장소.
 *  - LocalStore  : 브라우저(localStorage). 시험용.
 *  - SheetsStore : Google Apps Script 웹앱 → 구글 스프레드시트. 모든 사람이 같은 내용을 본다.
 * 두 저장소가 같은 함수(list/create/cancel)를 제공하므로 화면 코드는 어느 쪽이든 동일하게 쓴다.
 */

const LOCAL_KEY = 'meeting_room_reservations_v1';
const CACHE_KEY = 'meeting_room_cache_v1';
const PIN_SALT = 'meeting-room-reservation:';

/** 비밀번호를 그대로 저장하지 않도록 해시로 바꾼다. */
export async function hashPin(pin) {
  const text = PIN_SALT + pin;
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // 보안 컨텍스트가 아닐 때(파일로 직접 열었을 때)를 위한 최소한의 대비책.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return `fallback${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export const overlaps = (a, b) => a.room === b.room && a.date === b.date && a.start < b.end && a.end > b.start;

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const inRange = (r, from, to) => (!from || r.date >= from) && (!to || r.date <= to);

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
  } catch {
    return [];
  }
}

function createLocalStore(config) {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    } catch {
      return [];
    }
  };
  const write = (rows) => localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));

  return {
    mode: 'local',
    shared: false,
    label: '이 기기에만 저장 (시험 모드)',

    async list({ from, to } = {}) {
      return read().filter((r) => inRange(r, from, to));
    },

    async create(input) {
      const rows = read();
      if (rows.some((r) => overlaps(r, input))) {
        throw new Error('같은 시간에 이미 예약이 있어요.');
      }
      const row = { ...input, id: uid(), createdAt: new Date().toISOString() };
      rows.push(row);
      write(rows);
      return row;
    },

    async cancel(id, pin) {
      const rows = read();
      const target = rows.find((r) => r.id === id);
      if (!target) throw new Error('이미 취소된 예약이에요.');
      const pinHash = await hashPin(pin);
      const adminHash = await hashPin(config.adminPin);
      if (target.pinHash !== pinHash && pinHash !== adminHash) {
        throw new Error('비밀번호가 맞지 않아요.');
      }
      write(rows.filter((r) => r.id !== id));
    },
  };
}

function createSheetsStore(config) {
  const base = config.backend.url.trim();

  async function call(payload) {
    const res = await fetch(base, {
      method: 'POST',
      // text/plain 이어야 Apps Script 로 갈 때 사전요청(preflight)이 생기지 않는다.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`서버 응답 오류 (${res.status})`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '요청을 처리하지 못했어요.');
    return json.data;
  }

  return {
    mode: 'sheets',
    shared: true,
    label: '공유 서버 연결됨',

    async list({ from, to } = {}) {
      const url = new URL(base);
      url.searchParams.set('action', 'list');
      if (from) url.searchParams.set('from', from);
      if (to) url.searchParams.set('to', to);
      try {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`서버 응답 오류 (${res.status})`);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || '목록을 불러오지 못했어요.');
        localStorage.setItem(CACHE_KEY, JSON.stringify(json.data));
        return json.data;
      } catch (err) {
        const cached = readCache().filter((r) => inRange(r, from, to));
        if (cached.length) {
          err.cached = cached;
        }
        throw err;
      }
    },

    create(input) {
      return call({ action: 'create', reservation: input });
    },

    async cancel(id, pin) {
      await call({ action: 'cancel', id, pinHash: await hashPin(pin) });
    },
  };
}

export function createStore(config) {
  if (config.backend.mode === 'sheets' && config.backend.url.trim()) {
    return createSheetsStore(config);
  }
  return createLocalStore(config);
}
