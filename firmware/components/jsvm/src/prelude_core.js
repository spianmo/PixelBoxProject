/*
 * prelude_core.js — fw-core JS prelude (在所有 native init 之后执行)
 *
 * 提供纯 JS 实现的标准全局与工具:
 *   - TextEncoder / TextDecoder (UTF-8)
 *   - atob / btoa
 *   - performance.now (包装 native __pxPerfNowMs)
 *   - px.util 纯 JS 部分: b64encode/b64decode/hexEncode/hexDecode/uuid
 *     (crc32/sha256/randomBytes 由 native mod_util 提供)
 *   - px.color 全部 (纯 JS)
 */
(() => {
  'use strict';
  const g = globalThis;

  /* ---------- 工具: BinaryLike → Uint8Array ---------- */
  const toU8 = (data) => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('参数需要 ArrayBuffer 或 Uint8Array');
  };

  /* ---------- TextEncoder / TextDecoder (UTF-8) ---------- */
  class PxTextEncoder {
    encode(input) {
      const s = String(input == null ? '' : input);
      const out = [];
      for (let i = 0; i < s.length; i++) {
        let cp = s.codePointAt(i);
        if (cp > 0xffff) i++; /* 代理对占两个 code unit */
        if (cp < 0x80) {
          out.push(cp);
        } else if (cp < 0x800) {
          out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        } else if (cp < 0x10000) {
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        } else {
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 63),
            0x80 | ((cp >> 6) & 63),
            0x80 | (cp & 63)
          );
        }
      }
      return new Uint8Array(out);
    }
  }

  class PxTextDecoder {
    constructor(label) {
      const l = String(label || 'utf-8').toLowerCase();
      if (l !== 'utf-8' && l !== 'utf8') throw new RangeError('仅支持 utf-8 编码');
    }
    decode(input) {
      if (input == null) return '';
      const u8 = toU8(input);
      let out = '';
      let i = 0;
      const n = u8.length;
      while (i < n) {
        const b = u8[i++];
        let cp;
        if (b < 0x80) {
          cp = b;
        } else if ((b & 0xe0) === 0xc0) {
          cp = ((b & 31) << 6) | (u8[i++] & 63);
        } else if ((b & 0xf0) === 0xe0) {
          cp = ((b & 15) << 12) | ((u8[i++] & 63) << 6) | (u8[i++] & 63);
        } else {
          cp =
            ((b & 7) << 18) |
            ((u8[i++] & 63) << 12) |
            ((u8[i++] & 63) << 6) |
            (u8[i++] & 63);
        }
        /* 简化实现: 非法序列产出替换字符 */
        if (!(cp >= 0) || cp > 0x10ffff || Number.isNaN(cp)) cp = 0xfffd;
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  }

  g.TextEncoder = PxTextEncoder;
  g.TextDecoder = PxTextDecoder;

  /* ---------- atob / btoa ---------- */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64REV = (() => {
    const r = Object.create(null);
    for (let i = 0; i < 64; i++) r[B64[i]] = i;
    return r;
  })();

  g.btoa = function btoa(raw) {
    const s = String(raw);
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const c0 = s.charCodeAt(i);
      const c1 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      const c2 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      if (c0 > 255 || c1 > 255 || c2 > 255)
        throw new RangeError('btoa: 仅接受 Latin-1 字符串');
      out += B64[c0 >> 2];
      out += B64[((c0 & 3) << 4) | (Number.isNaN(c1) ? 0 : c1 >> 4)];
      out += Number.isNaN(c1) ? '=' : B64[((c1 & 15) << 2) | (Number.isNaN(c2) ? 0 : c2 >> 6)];
      out += Number.isNaN(c2) ? '=' : B64[c2 & 63];
    }
    return out;
  };

  g.atob = function atob(b64) {
    const s = String(b64).replace(/[\t\n\r ]/g, '');
    if (s.length % 4 === 1) throw new RangeError('atob: base64 长度非法');
    let out = '';
    for (let i = 0; i < s.length; i += 4) {
      const n0 = B64REV[s[i]];
      const n1 = B64REV[s[i + 1]];
      const p2 = s[i + 2];
      const p3 = s[i + 3];
      if (n0 === undefined || n1 === undefined)
        throw new RangeError('atob: 非法 base64 字符');
      out += String.fromCharCode((n0 << 2) | (n1 >> 4));
      if (p2 !== undefined && p2 !== '=') {
        const n2 = B64REV[p2];
        if (n2 === undefined) throw new RangeError('atob: 非法 base64 字符');
        out += String.fromCharCode(((n1 & 15) << 4) | (n2 >> 2));
        if (p3 !== undefined && p3 !== '=') {
          const n3 = B64REV[p3];
          if (n3 === undefined) throw new RangeError('atob: 非法 base64 字符');
          out += String.fromCharCode(((n2 & 3) << 6) | n3);
        }
      }
    }
    return out;
  };

  /* ---------- performance.now ---------- */
  const hr = g.__pxPerfNowMs;
  delete g.__pxPerfNowMs;
  g.performance = {
    now() {
      return hr();
    },
  };

  /* ---------- px.util 纯 JS 部分 ---------- */
  const util = px.util;

  util.b64encode = (data) => {
    const u8 = toU8(data);
    let s = '';
    /* 分块避免长参数展开 */
    for (let i = 0; i < u8.length; i += 4096) {
      s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 4096)));
    }
    return g.btoa(s);
  };

  util.b64decode = (b64) => {
    const s = g.atob(b64);
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8.buffer;
  };

  const HEX = '0123456789abcdef';
  util.hexEncode = (data) => {
    const u8 = toU8(data);
    let out = '';
    for (let i = 0; i < u8.length; i++) {
      out += HEX[u8[i] >> 4] + HEX[u8[i] & 15];
    }
    return out;
  };

  util.hexDecode = (hex) => {
    const s = String(hex).trim();
    if (s.length % 2 !== 0) throw new RangeError('hexDecode: 长度必须为偶数');
    const u8 = new Uint8Array(s.length / 2);
    for (let i = 0; i < u8.length; i++) {
      const v = parseInt(s.substr(i * 2, 2), 16);
      if (Number.isNaN(v)) throw new RangeError('hexDecode: 非法十六进制字符');
      u8[i] = v;
    }
    return u8.buffer;
  };

  util.uuid = () => {
    /* RFC 4122 v4, 随机源用 native randomBytes */
    const u8 = new Uint8Array(util.randomBytes(16));
    u8[6] = (u8[6] & 0x0f) | 0x40;
    u8[8] = (u8[8] & 0x3f) | 0x80;
    const h = util.hexEncode(u8.buffer);
    return (
      h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
      h.slice(16, 20) + '-' + h.slice(20)
    );
  };

  /* ---------- px.color (全部纯 JS) ---------- */
  const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

  px.color = {
    rgb(r, g2, b) {
      return (clampByte(r) << 16) | (clampByte(g2) << 8) | clampByte(b);
    },
    /** h 0-360, s/v 0-100 */
    hsv(h, s, v) {
      let hh = ((Number(h) % 360) + 360) % 360;
      const ss = Math.min(100, Math.max(0, Number(s))) / 100;
      const vv = Math.min(100, Math.max(0, Number(v))) / 100;
      const c = vv * ss;
      const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
      const m = vv - c;
      let r = 0, g2 = 0, b = 0;
      if (hh < 60) { r = c; g2 = x; }
      else if (hh < 120) { r = x; g2 = c; }
      else if (hh < 180) { g2 = c; b = x; }
      else if (hh < 240) { g2 = x; b = c; }
      else if (hh < 300) { r = x; b = c; }
      else { r = c; b = x; }
      return px.color.rgb(
        Math.round((r + m) * 255),
        Math.round((g2 + m) * 255),
        Math.round((b + m) * 255)
      );
    },
    /** 两色线性插值, t 0-1 */
    lerp(a, b, t) {
      const tt = Math.min(1, Math.max(0, Number(t)));
      const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
      const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
      return px.color.rgb(
        Math.round(ar + (br - ar) * tt),
        Math.round(ag + (bg - ag) * tt),
        Math.round(ab + (bb - ab) * tt)
      );
    },
    BLACK: 0x000000,
    WHITE: 0xffffff,
    RED: 0xff0000,
    GREEN: 0x00ff00,
    BLUE: 0x0000ff,
    YELLOW: 0xffff00,
    CYAN: 0x00ffff,
    MAGENTA: 0xff00ff,
    ORANGE: 0xff8800,
    GRAY: 0x808080,
  };
})();
