/*
 * 의존성 없는 QR 코드 생성기 (byte 모드, 버전 1~10).
 * 외부 QR 생성 서비스를 쓰지 않기 때문에 인터넷이 없어도 포스터를 뽑을 수 있다.
 * 반환값: { version, size, mask, modules }  (modules[y][x] === true 이면 검은 칸)
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

// [EC 코드워드/블록, 1그룹 블록수, 1그룹 데이터워드, 2그룹 블록수, 2그룹 데이터워드]
const EC_TABLE = {
  L: [
    [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17], [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12], [28, 4, 15, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
  ],
};

const ALIGN_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

const EC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

// 버전 7 이상에서 쓰는 18비트 버전 정보
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

function genPoly(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function ecCodewords(data, count) {
  const gen = genPoly(count);
  const buf = data.concat(new Array(count).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.slice(data.length);
}

function dataCapacity(version, ec) {
  const [, g1n, g1c, g2n, g2c] = EC_TABLE[ec][version - 1];
  return g1n * g1c + g2n * g2c;
}

function toUtf8(text) {
  return Array.from(new TextEncoder().encode(text));
}

function buildCodewords(bytes, version, ec) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte 모드
  push(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));

  const capacityBits = dataCapacity(version, ec) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < dataCapacity(version, ec); i++) {
    codewords.push(pads[i % 2]);
  }

  // 블록 분할 → EC 계산 → 인터리빙
  const [ecPerBlock, g1n, g1c, g2n, g2c] = EC_TABLE[ec][version - 1];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1n + g2n; i++) {
    const size = i < g1n ? g1c : g2c;
    const block = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(ecCodewords(block, ecPerBlock));
  }

  const result = [];
  const maxData = Math.max(g1c, g2c);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (x, y, value) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = value;
    reserved[y][x] = true;
  };

  // 파인더 패턴 + 분리자
  for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const inRing = (x >= 0 && x <= 6 && (y === 0 || y === 6)) ||
          (y >= 0 && y <= 6 && (x === 0 || x === 6));
        const inCore = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        setFn(ox + x, oy + y, inRing || inCore);
      }
    }
  }

  // 타이밍 패턴
  for (let i = 8; i < size - 8; i++) {
    setFn(i, 6, i % 2 === 0);
    setFn(6, i, i % 2 === 0);
  }

  // 얼라인먼트 패턴
  const centers = ALIGN_CENTERS[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      const nearFinder = (cx <= 8 && cy <= 8) ||
        (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          setFn(cx + dx, cy + dy, on);
        }
      }
    }
  }

  // 포맷 정보 자리 예약 + 항상 검은 모듈
  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) reserved[8][i] = true;
    if (modules[i][8] === null) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  setFn(8, size - 8, true); // dark module

  // 버전 정보 자리 예약
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = i % 3;
      reserved[size - 11 + b][a] = true;
      reserved[a][size - 11 + b] = true;
    }
  }

  return { size, modules, reserved };
}

function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  codewords.forEach((cw) => {
    for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  });

  let index = 0;
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // 타이밍 열 건너뛰기
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        modules[y][x] = index < bits.length ? bits[index] === 1 : false;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatBits(ec, mask) {
  let data = (EC_FORMAT_BITS[ec] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  }
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

function applyFormatAndVersion(matrix, ec, mask, version) {
  const { size, modules } = matrix;
  const bits = formatBits(ec, mask);
  const bit = (i) => ((bits >> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = bit(i);

  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = bit(i);
  modules[size - 8][8] = true;

  if (version >= 7) {
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const on = ((info >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = i % 3;
      modules[size - 11 + b][a] = on;
      modules[a][size - 11 + b] = on;
    }
  }
}

function penalty(modules, size) {
  let score = 0;

  const runScore = (line) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  };
  for (let i = 0; i < size; i++) {
    runScore(modules[i]);
    runScore(modules.map((row) => row[i]));
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y][x];
      if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const rev = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get, start) => {
    let fwd = true;
    let bwd = true;
    for (let i = 0; i < 11; i++) {
      if (get(start + i) !== pattern[i]) fwd = false;
      if (get(start + i) !== rev[i]) bwd = false;
    }
    return fwd || bwd;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => modules[i][k], j)) score += 40;
      if (matches((k) => modules[k][i], j)) score += 40;
    }
  }

  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

export function encodeQR(text, options = {}) {
  const ec = options.ecLevel || 'M';
  if (!EC_TABLE[ec]) throw new Error(`알 수 없는 오류정정 레벨: ${ec}`);
  const bytes = toUtf8(text);

  let version = options.version || 0;
  if (!version) {
    for (let v = 1; v <= 10; v++) {
      const headerBits = 4 + (v <= 9 ? 8 : 16);
      if (headerBits + bytes.length * 8 <= dataCapacity(v, ec) * 8) {
        version = v;
        break;
      }
    }
  }
  if (!version) throw new Error('내용이 너무 길어 QR로 만들 수 없습니다.');

  // 남는 remainder 비트는 placeData 에서 0으로 채워진다.
  const codewords = buildCodewords(bytes, version, ec);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = createMatrix(version);
    placeData(matrix, codewords);
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (!matrix.reserved[y][x] && MASK_FN[mask](x, y)) {
          matrix.modules[y][x] = !matrix.modules[y][x];
        }
      }
    }
    applyFormatAndVersion(matrix, ec, mask, version);
    const score = penalty(matrix.modules, matrix.size);
    if (!best || score < best.score) best = { score, mask, matrix };
  }

  return {
    version,
    mask: best.mask,
    size: best.matrix.size,
    modules: best.matrix.modules.map((row) => row.map(Boolean)),
  };
}

/** QR 코드를 SVG 문자열로 렌더링한다. */
export function qrToSvg(text, { ecLevel = 'M', quietZone = 4, scale = 8, color = '#111111' } = {}) {
  const { modules, size } = encodeQR(text, { ecLevel });
  const total = (size + quietZone * 2) * scale;
  const parts = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      parts.push(`M${(x + quietZone) * scale} ${(y + quietZone) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total}" height="${total}" shape-rendering="crispEdges" role="img" aria-label="QR 코드">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path fill="${color}" d="${parts.join('')}"/></svg>`;
}
