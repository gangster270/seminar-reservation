/*
 * 회의실 예약 시스템 설정 파일.
 * 회의실 이름, 운영 시간, 저장 방식은 모두 이 파일만 고치면 된다.
 */

export const CONFIG = {
  /** 화면 상단에 표시되는 이름 */
  title: '회의실 예약',
  subtitle: '부서 공용 회의실 온라인 예약',

  /** 회의실 목록. 개수를 늘리거나 줄여도 화면이 자동으로 맞춰진다. */
  rooms: [
    { id: 'A', name: '제1회의실', capacity: 12, color: '#3182f6' },
    { id: 'B', name: '제2회의실', capacity: 6, color: '#8b5cf6' },
  ],

  /** 운영 시간 (24시간제) 과 예약 단위(분) */
  openHour: 8,
  closeHour: 20,
  slotMinutes: 30,

  /** 오늘로부터 며칠 뒤까지 예약할 수 있는지 */
  maxAdvanceDays: 180,

  /**
   * 저장 방식
   *  - 'local'  : 브라우저에만 저장. 기기마다 내용이 달라서 시험용으로만 쓴다.
   *  - 'sheets' : Google Apps Script + 스프레드시트에 저장. 모든 부서가 같은 내용을 본다.
   * 'sheets' 로 바꿀 때는 apps-script/Code.gs 를 배포하고 받은 /exec 주소를 url 에 넣는다.
   */
  backend: {
    mode: 'local',
    url: '',
  },

  /** 다른 사람이 만든 예약도 취소할 수 있는 관리자 비밀번호 (local 모드 전용) */
  adminPin: '0000',
};

/** 예약 화면에 뜨는 시간 목록을 만든다. (예: 08:00, 08:30 …) */
export function timeSlots() {
  const list = [];
  const total = (CONFIG.closeHour - CONFIG.openHour) * 60;
  for (let m = 0; m <= total; m += CONFIG.slotMinutes) {
    const minutes = CONFIG.openHour * 60 + m;
    list.push(
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
    );
  }
  return list;
}

export const roomById = (id) => CONFIG.rooms.find((r) => r.id === id) || CONFIG.rooms[0];
