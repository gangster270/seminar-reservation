import { CONFIG, timeSlots, roomById } from './config.js';
import { createStore, hashPin, overlaps } from './store.js';

const store = createStore(CONFIG);
const SLOTS = timeSlots();
const SLOT_COUNT = SLOTS.length - 1;
const SLOT_H = 26;
const PROFILE_KEY = 'meeting_room_profile_v1';
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => new Date(`${s}T00:00:00`);
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const nowMin = () => new Date().getHours() * 60 + new Date().getMinutes();
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const TODAY = fmt(new Date());
const MAX_DATE = fmt(addDays(new Date(), CONFIG.maxAdvanceDays));

const state = {
  year: new Date().getFullYear(),
  month: new Date().getMonth(),
  date: TODAY,
  rows: [],
  room: CONFIG.rooms[0].id,
  cancelId: null,
  loading: false,
};

/* ---------------- 공통 UI ---------------- */

let toastTimer;
function toast(message, kind = '') {
  const el = $('toast');
  el.className = `toast ${kind}`;
  el.textContent = message;
  clearTimeout(toastTimer);
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function setNotice(message) {
  const el = $('notice');
  el.hidden = !message;
  el.textContent = message || '';
}

/* ---------------- 데이터 ---------------- */

async function reload() {
  const from = `${state.year}-${pad(state.month + 1)}-01`;
  const to = fmt(new Date(state.year, state.month + 1, 0));
  state.loading = true;
  try {
    state.rows = await store.list({ from, to });
    setNotice('');
  } catch (err) {
    state.rows = err.cached || [];
    setNotice(
      `예약 목록을 불러오지 못했어요: ${err.message}` +
      (err.cached ? ' (마지막으로 받아둔 내용을 보여주고 있어요)' : ''),
    );
  } finally {
    state.loading = false;
    render();
  }
}

const rowsOn = (date) => state.rows
  .filter((r) => r.date === date)
  .sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room));

const isPastSlot = (date, endTime) =>
  date < TODAY || (date === TODAY && toMin(endTime) <= nowMin());

/* ---------------- 달력 ---------------- */

function renderCalendar() {
  $('calMonth').textContent = `${state.year}년 ${state.month + 1}월`;

  const grid = $('calGrid');
  const first = new Date(state.year, state.month, 1).getDay();
  const last = new Date(state.year, state.month + 1, 0).getDate();

  const html = [
    ...DOW.map((d, i) => `<div class="cal-dow ${i === 0 ? 'sun' : ''}${i === 6 ? 'sat' : ''}">${d}</div>`),
    ...Array.from({ length: first }, () => '<div class="cal-cell empty"></div>'),
  ];

  for (let day = 1; day <= last; day++) {
    const ds = `${state.year}-${pad(state.month + 1)}-${pad(day)}`;
    const dayRows = state.rows.filter((r) => r.date === ds);
    const dots = CONFIG.rooms
      .filter((room) => dayRows.some((r) => r.room === room.id))
      .map((room) => `<i style="background:${room.color}"></i>`)
      .join('');
    const cls = [
      'cal-cell',
      ds === TODAY ? 'today' : '',
      ds === state.date ? 'selected' : '',
    ].join(' ').trim();
    const disabled = ds < TODAY || ds > MAX_DATE ? 'disabled' : '';
    html.push(
      `<button type="button" class="${cls}" data-date="${ds}" ${disabled}>` +
      `<span class="num">${day}</span><span class="cal-dots">${dots}</span></button>`,
    );
  }

  grid.innerHTML = html.join('');

  $('legend').innerHTML = CONFIG.rooms
    .map((r) => `<span><i style="background:${r.color}"></i>${esc(r.name)}` +
      `${r.capacity ? ` · ${r.capacity}인` : ''}</span>`)
    .join('');
}

/* ---------------- 타임라인 ---------------- */

function renderTimeline() {
  const d = parseDate(state.date);
  $('dayTitle').textContent =
    `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;

  const dayRows = rowsOn(state.date);
  $('daySummary').textContent = dayRows.length
    ? `${dayRows.length}건 예약됨 · 빈 칸을 누르면 바로 예약할 수 있어요`
    : '예약이 없어요 · 빈 칸을 누르면 바로 예약할 수 있어요';

  const cols = `52px repeat(${CONFIG.rooms.length}, minmax(0, 1fr))`;
  const head = $('tlHead');
  const body = $('tlBody');
  head.style.gridTemplateColumns = cols;
  body.style.gridTemplateColumns = cols;

  head.innerHTML = '<div></div>' + CONFIG.rooms
    .map((r) => `<div class="tl-room" style="color:${r.color}">${esc(r.name)}</div>`)
    .join('');

  const height = SLOT_COUNT * SLOT_H;
  const openMin = toMin(SLOTS[0]);

  const axis = SLOTS
    .map((t, i) => (toMin(t) % 60 === 0
      ? `<span style="top:${i * SLOT_H}px">${t}</span>`
      : ''))
    .join('');

  const columns = CONFIG.rooms.map((room) => {
    const booked = dayRows.filter((r) => r.room === room.id);

    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => {
      const start = SLOTS[i];
      const end = SLOTS[i + 1];
      const taken = booked.some((r) => r.start < end && r.end > start);
      const disabled = taken || isPastSlot(state.date, end);
      const hourLine = toMin(start) % 60 === 0 ? ' hour' : '';
      return `<button type="button" class="tl-slot${hourLine}" style="top:${i * SLOT_H}px;height:${SLOT_H}px"` +
        ` data-room="${room.id}" data-start="${start}" ${disabled ? 'disabled' : ''}` +
        ` aria-label="${esc(room.name)} ${start} 예약"></button>`;
    }).join('');

    const blocks = booked.map((r) => {
      const top = ((toMin(r.start) - openMin) / CONFIG.slotMinutes) * SLOT_H;
      const h = Math.max(((toMin(r.end) - toMin(r.start)) / CONFIG.slotMinutes) * SLOT_H - 2, 18);
      return `<button type="button" class="tl-block" data-id="${r.id}"` +
        ` style="top:${top + 1}px;height:${h}px;background:${room.color}">` +
        `<b>${esc(r.dept)}</b><small>${r.start}~${r.end} ${esc(r.person)}</small></button>`;
    }).join('');

    return `<div class="tl-col" style="height:${height}px">${slots}${blocks}</div>`;
  }).join('');

  body.innerHTML = `<div class="tl-axis" style="height:${height}px">${axis}</div>${columns}`;
}

/* ---------------- 목록 ---------------- */

function renderList() {
  const d = parseDate(state.date);
  $('listTitle').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 예약 내역`;

  const dayRows = rowsOn(state.date);
  const list = $('resList');

  if (!dayRows.length) {
    list.innerHTML = '<div class="empty"><span class="big">📭</span>이 날은 아직 예약이 없어요</div>';
    return;
  }

  list.innerHTML = dayRows.map((r) => {
    const room = roomById(r.room);
    const sub = [room.name, r.person, r.purpose, r.contact].filter(Boolean).join(' · ');
    return `<div class="res-item">` +
      `<div class="res-bar" style="background:${room.color}"></div>` +
      `<div class="res-main"><div class="res-title">${esc(r.dept)}</div>` +
      `<div class="res-sub">${esc(sub)}</div></div>` +
      `<div class="res-time">${r.start}~${r.end}</div>` +
      `<button type="button" class="res-cancel" data-id="${r.id}" aria-label="예약 취소">` +
      `<svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>` +
      `</button></div>`;
  }).join('');
}

function render() {
  renderCalendar();
  renderTimeline();
  renderList();
}

/* ---------------- 예약 폼 ---------------- */

function fillTimeSelects() {
  $('fStart').innerHTML = SLOTS.slice(0, -1).map((t) => `<option>${t}</option>`).join('');
  $('fEnd').innerHTML = SLOTS.slice(1).map((t) => `<option>${t}</option>`).join('');
}

function renderRoomSeg() {
  $('roomSeg').innerHTML = CONFIG.rooms.map((r) => (
    `<button type="button" data-room="${r.id}" aria-pressed="${r.id === state.room}">` +
    `<i style="background:${r.color}"></i>${esc(r.name)}` +
    `${r.capacity ? ` (${r.capacity}인)` : ''}</button>`
  )).join('');
}

function nextSlotFrom(minute) {
  const found = SLOTS.slice(0, -1).find((t) => toMin(t) >= minute);
  return found || SLOTS[0];
}

function openForm({ room, date, start } = {}) {
  const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
  state.room = room || state.room;
  renderRoomSeg();

  $('fDate').min = TODAY;
  $('fDate').max = MAX_DATE;
  $('fDate').value = date || state.date;

  const defaultStart = start
    || (($('fDate').value === TODAY) ? nextSlotFrom(nowMin()) : SLOTS[0]);
  $('fStart').value = defaultStart;
  syncEnd();

  $('fDept').value = profile.dept || '';
  $('fPerson').value = profile.person || '';
  $('fContact').value = profile.contact || '';
  $('fPurpose').value = '';
  $('fPin').value = '';

  $('deptList').innerHTML = [...new Set(state.rows.map((r) => r.dept))]
    .filter(Boolean)
    .map((d) => `<option value="${esc(d)}"></option>`)
    .join('');

  $('formOverlay').classList.add('show');
}

function syncEnd() {
  const start = $('fStart').value;
  const end = $('fEnd');
  if (end.value <= start) {
    const idx = SLOTS.indexOf(start);
    end.value = SLOTS[Math.min(idx + 1, SLOTS.length - 1)];
  }
}

function closeForm() {
  $('formOverlay').classList.remove('show');
}

async function submitForm(event) {
  event.preventDefault();

  const draft = {
    room: state.room,
    date: $('fDate').value,
    start: $('fStart').value,
    end: $('fEnd').value,
    dept: $('fDept').value.trim(),
    person: $('fPerson').value.trim(),
    purpose: $('fPurpose').value.trim(),
    contact: $('fContact').value.trim(),
  };
  const pin = $('fPin').value.trim();

  if (!draft.date) return toast('날짜를 선택해주세요', 'error');
  if (draft.date < TODAY) return toast('지난 날짜는 예약할 수 없어요', 'error');
  if (draft.date > MAX_DATE) return toast(`${CONFIG.maxAdvanceDays}일 뒤까지만 예약할 수 있어요`, 'error');
  if (draft.start >= draft.end) return toast('종료 시간은 시작 시간보다 늦어야 해요', 'error');
  if (draft.date === TODAY && toMin(draft.end) <= nowMin()) {
    return toast('이미 지난 시간이에요', 'error');
  }
  if (!draft.dept) return toast('부서명을 입력해주세요', 'error');
  if (!draft.person) return toast('예약자 이름을 입력해주세요', 'error');
  if (!/^\d{4}$/.test(pin)) return toast('취소 비밀번호는 숫자 4자리로 입력해주세요', 'error');
  if (state.rows.some((r) => overlaps(r, draft))) {
    return toast('같은 시간에 이미 예약이 있어요', 'error');
  }

  const button = $('btnFormSubmit');
  button.disabled = true;
  button.textContent = '저장 중…';
  try {
    draft.pinHash = await hashPin(pin);
    await store.create(draft);
    localStorage.setItem(PROFILE_KEY, JSON.stringify({
      dept: draft.dept, person: draft.person, contact: draft.contact,
    }));
    closeForm();
    state.date = draft.date;
    const d = parseDate(draft.date);
    state.year = d.getFullYear();
    state.month = d.getMonth();
    await reload();
    toast('예약이 완료되었어요', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '예약하기';
  }
}

/* ---------------- 예약 취소 ---------------- */

function openCancel(id) {
  const r = state.rows.find((x) => x.id === id);
  if (!r) return;
  state.cancelId = id;
  const room = roomById(r.room);
  $('cancelSummary').innerHTML =
    `<b>${esc(room.name)}</b><br>${r.date} ${r.start}~${r.end}<br>` +
    `${esc(r.dept)} · ${esc(r.person)}${r.purpose ? `<br>${esc(r.purpose)}` : ''}`;
  $('cPin').value = '';
  $('cancelOverlay').classList.add('show');
}

function closeCancel() {
  $('cancelOverlay').classList.remove('show');
  state.cancelId = null;
}

async function confirmCancel() {
  const pin = $('cPin').value.trim();
  if (!pin) return toast('비밀번호를 입력해주세요', 'error');

  const button = $('btnConfirmCancel');
  button.disabled = true;
  try {
    await store.cancel(state.cancelId, pin);
    closeCancel();
    await reload();
    toast('예약이 취소되었어요');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------------- CSV 내보내기 ---------------- */

function exportCsv() {
  if (!state.rows.length) return toast('내보낼 예약이 없어요', 'error');
  const head = ['날짜', '회의실', '시작', '종료', '부서', '예약자', '목적', '연락처'];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = [...state.rows]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
    .map((r) => [r.date, roomById(r.room).name, r.start, r.end, r.dept, r.person, r.purpose, r.contact]
      .map(cell).join(','));

  const blob = new Blob([`﻿${[head.map(cell).join(','), ...body].join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `회의실예약_${state.year}-${pad(state.month + 1)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------------- 이벤트 ---------------- */

function moveMonth(delta) {
  const d = new Date(state.year, state.month + delta, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  const firstOfMonth = fmt(d);
  state.date = firstOfMonth < TODAY && fmt(new Date(state.year, state.month + 1, 0)) >= TODAY
    ? TODAY
    : firstOfMonth;
  reload();
}

function init() {
  document.title = CONFIG.title;
  $('appTitle').textContent = CONFIG.title;
  $('appSubtitle').textContent = CONFIG.subtitle;
  const badge = $('storageBadge');
  badge.textContent = store.label;
  badge.classList.toggle('shared', store.shared);

  fillTimeSelects();
  renderRoomSeg();

  $('btnPrev').onclick = () => moveMonth(-1);
  $('btnNext').onclick = () => moveMonth(1);
  $('btnToday').onclick = () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    state.date = TODAY;
    reload();
  };

  $('calGrid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cal-cell[data-date]');
    if (!cell || cell.disabled) return;
    state.date = cell.dataset.date;
    render();
  });

  $('tlBody').addEventListener('click', (e) => {
    const block = e.target.closest('.tl-block');
    if (block) return openCancel(block.dataset.id);
    const slot = e.target.closest('.tl-slot');
    if (slot && !slot.disabled) {
      openForm({ room: slot.dataset.room, date: state.date, start: slot.dataset.start });
    }
  });

  $('resList').addEventListener('click', (e) => {
    const button = e.target.closest('.res-cancel');
    if (button) openCancel(button.dataset.id);
  });

  $('roomSeg').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-room]');
    if (!button) return;
    state.room = button.dataset.room;
    renderRoomSeg();
  });

  $('btnNew').onclick = () => openForm({ date: state.date });
  $('btnFormCancel').onclick = closeForm;
  $('bookForm').addEventListener('submit', submitForm);
  $('fStart').addEventListener('change', syncEnd);
  $('formOverlay').addEventListener('click', (e) => {
    if (e.target === $('formOverlay')) closeForm();
  });

  $('btnKeep').onclick = closeCancel;
  $('btnConfirmCancel').onclick = confirmCancel;
  $('cancelOverlay').addEventListener('click', (e) => {
    if (e.target === $('cancelOverlay')) closeCancel();
  });

  $('btnExport').onclick = exportCsv;

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeForm();
    closeCancel();
  });

  reload();
}

init();
