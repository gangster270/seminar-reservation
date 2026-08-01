/**
 * 회의실 예약 - Google Apps Script 백엔드
 *
 * 이 파일을 스프레드시트에 연결된 Apps Script 프로젝트에 붙여넣고
 * "배포 > 새 배포 > 웹 앱" 으로 배포하면, 모든 부서가 같은 예약 내용을 보게 된다.
 *   - 실행 계정      : 나
 *   - 액세스 권한    : 모든 사용자
 * 배포 후 받은 https://script.google.com/macros/s/.../exec 주소를
 * assets/config.js 의 backend.url 에 넣고 backend.mode 를 'sheets' 로 바꾸면 끝.
 */

var SHEET_NAME = 'reservations';
var HEADERS = ['id', 'room', 'date', 'start', 'end', 'dept', 'person', 'purpose', 'contact', 'pinHash', 'createdAt'];
var PIN_SALT = 'meeting-room-reservation:';

/* ------------------------------------------------------------------ */
/* 요청 처리                                                            */
/* ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if ((params.action || 'list') !== 'list') throw new Error('알 수 없는 요청입니다.');
    return jsonOut_({ ok: true, data: listReservations_(params.from, params.to) });
  } catch (err) {
    return jsonOut_({ ok: false, error: errorText_(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'create') {
      return jsonOut_({ ok: true, data: createReservation_(body.reservation) });
    }
    if (body.action === 'cancel') {
      cancelReservation_(body.id, body.pinHash);
      return jsonOut_({ ok: true, data: null });
    }
    throw new Error('알 수 없는 요청입니다.');
  } catch (err) {
    return jsonOut_({ ok: false, error: errorText_(err) });
  }
}

/* ------------------------------------------------------------------ */
/* 기능                                                                 */
/* ------------------------------------------------------------------ */

function listReservations_(from, to) {
  var rows = readAll_();
  return rows
    .filter(function (r) {
      return (!from || r.date >= from) && (!to || r.date <= to);
    })
    .map(function (r) {
      // 비밀번호 해시는 절대 밖으로 내보내지 않는다.
      return {
        id: r.id, room: r.room, date: r.date, start: r.start, end: r.end,
        dept: r.dept, person: r.person, purpose: r.purpose, contact: r.contact,
        createdAt: r.createdAt,
      };
    });
}

function createReservation_(input) {
  if (!input) throw new Error('예약 내용이 비어 있습니다.');
  var row = {
    id: Utilities.getUuid().slice(0, 12),
    room: String(input.room || '').trim(),
    date: String(input.date || '').trim(),
    start: String(input.start || '').trim(),
    end: String(input.end || '').trim(),
    dept: String(input.dept || '').trim(),
    person: String(input.person || '').trim(),
    purpose: String(input.purpose || '').trim(),
    contact: String(input.contact || '').trim(),
    pinHash: String(input.pinHash || '').trim(),
    createdAt: new Date().toISOString(),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  if (!/^\d{2}:\d{2}$/.test(row.start) || !/^\d{2}:\d{2}$/.test(row.end)) {
    throw new Error('시간 형식이 올바르지 않습니다.');
  }
  if (row.start >= row.end) throw new Error('종료 시간은 시작 시간보다 늦어야 합니다.');
  if (!row.room) throw new Error('회의실을 선택해주세요.');
  if (!row.dept) throw new Error('부서명을 입력해주세요.');
  if (!row.person) throw new Error('예약자 이름을 입력해주세요.');
  if (!row.pinHash) throw new Error('취소 비밀번호가 필요합니다.');

  // 두 사람이 같은 시간에 동시에 누르는 경우를 막는다.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var clash = readAll_().some(function (r) {
      return r.room === row.room && r.date === row.date && r.start < row.end && r.end > row.start;
    });
    if (clash) throw new Error('같은 시간에 이미 예약이 있어요.');

    var sheet = getSheet_();
    sheet.appendRow(HEADERS.map(function (key) { return row[key]; }));
  } finally {
    lock.releaseLock();
  }

  delete row.pinHash;
  return row;
}

function cancelReservation_(id, pinHash) {
  if (!id) throw new Error('취소할 예약을 찾을 수 없습니다.');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][0]) !== String(id)) continue;
      var stored = String(values[i][HEADERS.indexOf('pinHash')]);
      if (stored !== String(pinHash) && String(pinHash) !== adminPinHash_()) {
        throw new Error('비밀번호가 맞지 않아요.');
      }
      sheet.deleteRow(i + 1);
      return;
    }
    throw new Error('이미 취소된 예약이에요.');
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 시트 다루기                                                          */
/* ------------------------------------------------------------------ */

function getSheet_() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = book.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 날짜/시간이 숫자로 바뀌지 않도록 전체를 텍스트 서식으로 둔다.
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
  }
  return sheet;
}

function readAll_() {
  var values = getSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    var row = {};
    for (var c = 0; c < HEADERS.length; c++) {
      row[HEADERS[c]] = normalize_(HEADERS[c], values[i][c]);
    }
    out.push(row);
  }
  return out;
}

/** 시트가 값을 날짜형으로 바꿔버린 경우에도 문자열로 되돌린다. */
function normalize_(key, value) {
  if (value instanceof Date) {
    var tz = Session.getScriptTimeZone();
    if (key === 'date') return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
    if (key === 'start' || key === 'end') return Utilities.formatDate(value, tz, 'HH:mm');
    return Utilities.formatDate(value, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return value === null || value === undefined ? '' : String(value);
}

/* ------------------------------------------------------------------ */
/* 도우미                                                              */
/* ------------------------------------------------------------------ */

/**
 * 관리자 비밀번호. 스크립트 속성에 ADMIN_PIN 을 넣어두면
 * 그 번호로 누구의 예약이든 취소할 수 있다. (프로젝트 설정 > 스크립트 속성)
 */
function adminPinHash_() {
  var pin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  if (!pin) return '';
  return sha256_(PIN_SALT + pin);
}

function sha256_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1);
  }).join('');
}

function jsonOut_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorText_(err) {
  return (err && err.message) ? err.message : String(err);
}

/** 시트를 미리 만들어 두고 싶을 때 편집기에서 한 번 실행한다. */
function setup() {
  getSheet_();
  SpreadsheetApp.getActiveSpreadsheet().toast('reservations 시트를 준비했습니다.');
}
