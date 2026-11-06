/* app.js — 螢光筆抹除器（純前端版）
 *
 * 全部喺瀏覽器處理，檔案唔會上傳去任何地方。
 * 流程：
 *   白平衡 → 縮圖分析 → 五色系 + RGB 通道約束 → 形態學 → 連通域
 *   → 形狀／色相一致／文字存在過濾 → 合併成螢光筆條
 *   → 紙色場 + 四邊色差修正 + 紙紋噪音 → 抹除
 */

'use strict';

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

const ANALYSIS_MAX = 1600;
const DPI = 150;
const PREVIEW_W = 1200;

const SENS = {
  strict: { s: 78, v: 155, k: 5, hs: 10, minDark: 0.008, maxDark: 0.65 },
  normal: { s: 58, v: 120, k: 7, hs: 16, minDark: 0.008, maxDark: 0.65 },
  loose:  { s: 40, v: 95,  k: 9, hs: 24, minDark: 0.008, maxDark: 0.65 },
};

const HUE_WINDOWS = [[16, 68], [56, 116], [104, 154], [196, 252]];

const FAMILIES = [
  { name: 'orange', test: (r, g, b) => r > 175 && r - g > 25 && g - b > 22 },
  { name: 'yellow', test: (r, g, b) => r > 175 && g > 150 && g - b > 25 && r - b > 35 && (r - g) > -20 && (r - g) < 28 },
  { name: 'green',  test: (r, g, b) => g > 165 && g - r > 18 && g - b > 22 },
  { name: 'cyan',   test: (r, g, b) => b > 165 && g > 155 && g - r > 18 && b - r > 28 },
  { name: 'pink',   test: (r, g, b) => r > 165 && b - g > 16 && r - g > 28 },
];

// ---------------------------------------------------------------------------
// 基本工具
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function percentileChannel(rgba, w, h, ch, pct) {
  const hist = new Uint32Array(256);
  const n = w * h;
  for (let i = 0, j = ch; i < n; i++, j += 4) hist[rgba[j]]++;
  const target = Math.max(1, Math.floor(n * pct / 100));
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [Math.round(h * 255), max === 0 ? 0 : Math.round(d / max * 255), max];
}

function hueDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// 形態學：用前綴和做滑動窗口，O(n)
// ---------------------------------------------------------------------------

function dilateFast(src, w, h, k) {
  if (k <= 1) return src.slice();
  const r = Math.max(1, Math.floor(k / 2));
  const tmp = new Uint8Array(w * h);
  const ps = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    ps[0] = 0;
    for (let x = 0; x < w; x++) ps[x + 1] = ps[x] + src[row + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      tmp[row + x] = (ps[b + 1] - ps[a]) > 0 ? 1 : 0;
    }
  }
  // 垂直
  const pref = new Int32Array((h + 1) * w);
  for (let y = 0; y < h; y++) {
    const base = y * w, next = (y + 1) * w;
    for (let x = 0; x < w; x++) pref[next + x] = pref[base + x] + tmp[base + x];
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    const row = y * w, ra = a * w, rb = (b + 1) * w;
    for (let x = 0; x < w; x++) out[row + x] = (pref[rb + x] - pref[ra + x]) > 0 ? 1 : 0;
  }
  return out;
}

function erodeFast(src, w, h, k) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = src[i] ? 0 : 1;
  const d = dilateFast(inv, w, h, k);
  for (let i = 0; i < w * h; i++) d[i] = d[i] ? 0 : 1;
  return d;
}

function closeMask(m, w, h, k) { return erodeFast(dilateFast(m, w, h, k), w, h, k); }
function openMask(m, w, h, k) { return dilateFast(erodeFast(m, w, h, k), w, h, k); }

function cleanMask(m, w, h, k) {
  let x = closeMask(m, w, h, k);
  x = dilateFast(x, w, h, 3);
  return openMask(x, w, h, 3);
}

// ---------------------------------------------------------------------------
// 連通域（8 連通）
// ---------------------------------------------------------------------------

function connectedComponents(mask, w, h) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = ++next;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = id;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const rr = yy * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = rr + xx;
          if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id, x0, y0, x1: x1 + 1, y1: y1 + 1, area });
  }
  return { labels, comps };
}

// ---------------------------------------------------------------------------
// 白平衡 / HSV / 色系遮罩
// ---------------------------------------------------------------------------

function whiteBalance(data, w, h) {
  const p = [0, 1, 2].map((ch) => percentileChannel(data, w, h, ch, 99.5));
  const sc = p.map((v) => 255 / Math.max(40, v));
  const out = new Uint8ClampedArray(w * h * 4);
  const n = w * h;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[j] = clamp255(data[j] * sc[0]);
    out[j + 1] = clamp255(data[j + 1] * sc[1]);
    out[j + 2] = clamp255(data[j + 2] * sc[2]);
    out[j + 3] = 255;
  }
  return out;
}

function buildHsv(bal, w, h) {
  const n = w * h;
  const H = new Uint8Array(n), S = new Uint8Array(n), V = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [hh, ss, vv] = rgbToHsv(bal[j], bal[j + 1], bal[j + 2]);
    H[i] = hh; S[i] = ss; V[i] = vv;
  }
  return { H, S, V };
}

function baseColorMask(H, S, V, preset) {
  const n = H.length;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = H[i];
    let ok = false;
    for (let k = 0; k < HUE_WINDOWS.length; k++) {
      if (h >= HUE_WINDOWS[k][0] && h <= HUE_WINDOWS[k][1]) { ok = true; break; }
    }
    if (!ok && h >= 6 && h < 16) ok = true;
    mask[i] = (ok && S[i] >= preset.s && V[i] >= preset.v) ? 1 : 0;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// 螢光筆條
// ---------------------------------------------------------------------------

function findBands(mask, w, h, opts) {
  const { labels, comps } = connectedComponents(mask, w, h);
  const maxArea = opts.maxAreaFrac * w * h;
  const maxH = opts.maxHFrac * h;
  const bands = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0, bh = c.y1 - c.y0;
    if (bw < opts.minW || bh < opts.minH || c.area < opts.minArea) continue;
    if (bw * bh > maxArea || bh > maxH) continue;
    bands.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, w: bw, h: bh, area: c.area });
  }
  return { bands, labels };
}

function bandPasses(band, labels, H, S, V, w, preset) {
  const { x0, y0, x1, y1 } = band;
  const total = (x1 - x0) * (y1 - y0);
  if (total <= 0) return false;
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) if (V[row + x] < 110) dark++;
  }
  const darkFrac = dark / total;
  if (darkFrac < preset.minDark || darkFrac > preset.maxDark) return false;

  const needSat = preset.s + 15;
  let cnt = 0, sinSum = 0, cosSum = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const i = row + x;
      if (!labels[i] || S[i] < needSat) continue;
      const deg = H[i] * 360 / 255;
      sinSum += Math.sin(deg * Math.PI / 180);
      cosSum += Math.cos(deg * Math.PI / 180);
      cnt++;
    }
  }
  if (cnt < 20) {
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = x0; x < x1; x++) {
        const i = row + x;
        if (!labels[i]) continue;
        const deg = H[i] * 360 / 255;
        sinSum += Math.sin(deg * Math.PI / 180);
        cosSum += Math.cos(deg * Math.PI / 180);
        cnt++;
      }
    }
  }
  if (cnt < 16) return false;
  const R = Math.max(1e-6, Math.hypot(sinSum / cnt, cosSum / cnt));
  const stdDeg = Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI;
  if (stdDeg > preset.hs) return false;

  band.hue = (Math.atan2(sinSum, cosSum) * 180 / Math.PI + 360) % 360;
  band.dark = darkFrac;
  return true;
}

function mergeBands(bands, hgap, hueTol) {
  if (bands.length <= 1) return bands;
  bands.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const merged = [];
  for (const b of bands) {
    let placed = false;
    for (const m of merged) {
      const top = Math.max(m.y0, b.y0), bot = Math.min(m.y1, b.y1);
      const overlap = Math.max(0, bot - top);
      const minH = Math.min(m.h, b.h);
      const gap = Math.max(m.x0, b.x0) - Math.min(m.x1, b.x1);
      const dh = (m.hue === undefined || b.hue === undefined) ? 999 : hueDiff(m.hue, b.hue);
      if (minH && overlap / minH >= 0.5 && gap <= hgap && dh <= hueTol) {
        m.x0 = Math.min(m.x0, b.x0); m.y0 = Math.min(m.y0, b.y0);
        m.x1 = Math.max(m.x1, b.x1); m.y1 = Math.max(m.y1, b.y1);
        m.w = m.x1 - m.x0; m.h = m.y1 - m.y0;
        m.area += b.area;
        placed = true;
        break;
      }
    }
    if (!placed) merged.push(Object.assign({}, b));
  }
  return merged;
}

function coalesceBands(bands) {
  if (bands.length <= 1) return bands;
  let items = bands.map((b) => Object.assign({}, b));
  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    const used = new Array(items.length).fill(false);
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue;
      const a = items[i];
      for (let j = i + 1; j < items.length; j++) {
        if (used[j]) continue;
        const b = items[j];
        const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
        const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
        if (ix1 <= ix0 || iy1 <= iy0) continue;
        const inter = (ix1 - ix0) * (iy1 - iy0);
        const aa = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
        const ab = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
        if (inter / Math.min(aa, ab) >= 0.6) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          a.w = a.x1 - a.x0; a.h = a.y1 - a.y0;
          a.area += b.area;
          used[j] = true;
          changed = true;
        }
      }
      out.push(a);
    }
    items = out;
  }
  return items;
}

// ---------------------------------------------------------------------------
// 分析一張圖
// ---------------------------------------------------------------------------

function analyze(img, sensKey) {
  const preset = SENS[sensKey];
  const scale = Math.min(1, ANALYSIS_MAX / Math.max(img.width, img.height));
  let small = img;
  if (scale < 1) {
    const aw = Math.max(1, Math.round(img.width * scale));
    const ah = Math.max(1, Math.round(img.height * scale));
    const src = makeCanvas(img.width, img.height);
    src.getContext('2d').putImageData(img, 0, 0);
    const dst = makeCanvas(aw, ah);
    const c = dst.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, aw, ah);
    small = c.getImageData(0, 0, aw, ah);
  }
  const aw = small.width, ah = small.height;
  const n = aw * ah;
  const bal = whiteBalance(small.data, aw, ah);
  const { H, S, V } = buildHsv(bal, aw, ah);
  const base = baseColorMask(H, S, V, preset);

  const r = new Uint8ClampedArray(n), g = new Uint8ClampedArray(n), b = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = bal[j]; g[i] = bal[j + 1]; b[i] = bal[j + 2]; }

  const k = Math.max(3, Math.round(preset.k * Math.max(1, Math.min(aw, ah) / 1100)));
  const opts = {
    minW: Math.max(6, Math.round(8 * k / 7)),
    minH: Math.max(3, Math.round(3 * k / 7)),
    minArea: Math.max(30, 25 * k),
    maxAreaFrac: 0.55, maxHFrac: 0.10,
  };

  const maskAll = new Uint8Array(n);
  let bands = [];
  for (const fam of FAMILIES) {
    const famMask = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (base[i] && fam.test(r[i], g[i], b[i])) { famMask[i] = 1; any = true; }
    }
    if (!any) continue;
    const rawFam = famMask.slice();
    const cleaned = cleanMask(famMask, aw, ah, k);
    let count = 0;
    for (let i = 0; i < n; i++) if (cleaned[i]) count++;
    if (count < 30) continue;
    for (let i = 0; i < n; i++) if (cleaned[i]) maskAll[i] = 1;
    const { bands: raw, labels } = findBands(cleaned, aw, ah, opts);
    const passed = raw.filter((bd) => bandPasses(bd, labels, H, S, V, aw, preset));
    // 收緊外框：只計原始顏色像素，避免形態學膨脹食到旁邊嘅字
    for (const bd of passed) {
      let tx0 = bd.x1, ty0 = bd.y1, tx1 = bd.x0, ty1 = bd.y0;
      for (let y = bd.y0; y < bd.y1; y++) {
        const row = y * aw;
        for (let x = bd.x0; x < bd.x1; x++) {
          if (!rawFam[row + x]) continue;
          if (x < tx0) tx0 = x;
          if (x > tx1) tx1 = x;
          if (y < ty0) ty0 = y;
          if (y > ty1) ty1 = y;
        }
      }
      if (tx1 >= tx0 && ty1 >= ty0) {
        bd.x0 = Math.max(0, tx0 - 1); bd.y0 = Math.max(0, ty0 - 1);
        bd.x1 = Math.min(aw, tx1 + 2); bd.y1 = Math.min(ah, ty1 + 2);
        bd.w = bd.x1 - bd.x0; bd.h = bd.y1 - bd.y0;
      }
    }
    bands = bands.concat(mergeBands(passed, 10, 14));
  }
  bands = coalesceBands(bands);

  if (bands.length) {
    const looseMask = baseColorMask(H, S, V, SENS.loose);
    const near = dilateFast(maskAll, aw, ah, 41);
    for (let i = 0; i < n; i++) if (looseMask[i] && near[i]) maskAll[i] = 1;
  }
  const looseBase = baseColorMask(H, S, V, SENS.loose);
  const tint = new Uint8Array(n);
  for (const fam of FAMILIES) {
    for (let i = 0; i < n; i++) {
      if (looseBase[i] && fam.test(r[i], g[i], b[i])) tint[i] = 1;
    }
  }
  if (!bands.length && sensKey !== 'loose') {
    // 自動再試一次寬鬆模式（減少漏字）
    const retry = analyze(img, 'loose');
    return { mask: retry.mask, tint: retry.tint, bands: retry.bands,
             aw: retry.aw, ah: retry.ah, scale: retry.scale, retried: true };
  }
  return { mask: maskAll, tint, bands, aw, ah, scale };
}

function upscaleMask(mask, aw, ah, w, h) {
  const src = makeCanvas(aw, ah);
  const simg = src.getContext('2d').createImageData(aw, ah);
  for (let i = 0; i < aw * ah; i++) {
    const v = mask[i] ? 255 : 0;
    simg.data[i * 4] = v; simg.data[i * 4 + 1] = v; simg.data[i * 4 + 2] = v;
    simg.data[i * 4 + 3] = 255;
  }
  src.getContext('2d').putImageData(simg, 0, 0);
  const dst = makeCanvas(w, h);
  const c = dst.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(src, 0, 0, w, h);
  const data = c.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * 4] > 127 ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// 紙色場
// ---------------------------------------------------------------------------

function buildPaperField(rgba, mask, w, h, cell) {
  cell = Math.max(10, Math.round(cell));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh * 3);
  const valid = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * cell, x1 = Math.min(w, x0 + cell);
      const y0 = gy * cell, y1 = Math.min(h, y0 + cell);
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
      let cnt = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          if (mask[i]) continue;
          const j = i * 4;
          const rr = rgba[j], gg = rgba[j + 1], bb = rgba[j + 2];
          if (Math.max(rr, gg, bb) < 110) continue;
          hist[0][rr]++; hist[1][gg]++; hist[2][bb]++;
          cnt++;
        }
      }
      const gi = gy * gw + gx;
      if (cnt >= 3) {
        for (let ch = 0; ch < 3; ch++) {
          let acc = 0;
          const half = cnt / 2;
          for (let v = 0; v < 256; v++) {
            acc += hist[ch][v];
            if (acc >= half) { grid[gi * 3 + ch] = v; break; }
          }
        }
        valid[gi] = 1;
      }
    }
  }

  // 填補空洞
  let known = new Uint8Array(valid);
  for (let iter = 0; iter < 500; iter++) {
    let any = false;
    const nextKnown = new Uint8Array(known);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const gi = gy * gw + gx;
        if (known[gi]) continue;
        let sr = 0, sg = 0, sb = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const yy = gy + dy, xx = gx + dx;
            if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
            const q = yy * gw + xx;
            if (!known[q]) continue;
            sr += grid[q * 3]; sg += grid[q * 3 + 1]; sb += grid[q * 3 + 2];
            c++;
          }
        }
        if (c) {
          grid[gi * 3] = sr / c; grid[gi * 3 + 1] = sg / c; grid[gi * 3 + 2] = sb / c;
          nextKnown[gi] = 1;
          any = true;
        }
      }
    }
    known = nextKnown;
    if (!any) break;
  }

  // 平滑
  for (let pass = 0; pass < 2; pass++) {
    const cp = new Float32Array(grid);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let sr = 0, sg = 0, sb = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = gy + dy, xx = gx + dx;
            if (yy < 0 || yy >= gh || xx < 0 || xx >= gw) continue;
            const q = (yy * gw + xx) * 3;
            sr += cp[q]; sg += cp[q + 1]; sb += cp[q + 2];
            c++;
          }
        }
        grid[(gy * gw + gx) * 3] = sr / c;
        grid[(gy * gw + gx) * 3 + 1] = sg / c;
        grid[(gy * gw + gx) * 3 + 2] = sb / c;
      }
    }
  }

  // 雙線性放大
  const gcanvas = makeCanvas(gw, gh);
  const gctx = gcanvas.getContext('2d');
  const gimg = gctx.createImageData(gw, gh);
  for (let i = 0; i < gw * gh; i++) {
    gimg.data[i * 4] = grid[i * 3];
    gimg.data[i * 4 + 1] = grid[i * 3 + 1];
    gimg.data[i * 4 + 2] = grid[i * 3 + 2];
    gimg.data[i * 4 + 3] = 255;
  }
  gctx.putImageData(gimg, 0, 0);
  const full = makeCanvas(w, h);
  const fctx = full.getContext('2d');
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(gcanvas, 0, 0, w, h);
  return fctx.getImageData(0, 0, w, h).data;
}

// ---------------------------------------------------------------------------
// 抹除
// ---------------------------------------------------------------------------

/** 用紙色場填一個 mask 區域；bbox 用嚟同四邊紙色對齊 + 估紙紋噪音 */
function fillRegionMask(out, img, paper, region, ringBox, fillBox, W, rng) {
  const { x0, y0, x1, y1 } = ringBox;
  const br = 10;
  const rx0 = Math.max(0, x0 - br), rx1 = Math.min(W, x1 + br);
  const ry0 = Math.max(0, y0 - br), ry1 = Math.min(img.height, y1 + br);
  let sr = 0, sg = 0, sb = 0, pr = 0, pg = 0, pb = 0, n = 0;
  let nR = 0, nG = 0, nB = 0;
  for (let y = ry0; y < ry1; y++) {
    if (y >= y0 && y < y1) continue;
    const row = y * W;
    for (let x = rx0; x < rx1; x++) {
      const i = row + x;
      if (region[i]) continue;
      const j = i * 4;
      sr += img.data[j]; sg += img.data[j + 1]; sb += img.data[j + 2];
      pr += paper[j]; pg += paper[j + 1]; pb += paper[j + 2];
      nR += Math.abs(img.data[j] - paper[j]);
      nG += Math.abs(img.data[j + 1] - paper[j + 1]);
      nB += Math.abs(img.data[j + 2] - paper[j + 2]);
      n++;
    }
  }
  let oR = 0, oG = 0, oB = 0;
  if (n >= 40) { oR = sr / n - pr / n; oG = sg / n - pg / n; oB = sb / n - pb / n; }
  const sigma = n ? 1.4826 * ((nR + nG + nB) / (n * 3)) : 0;

  const fy0 = Math.max(0, fillBox.y0), fy1 = Math.min(img.height, fillBox.y1);
  const fx0 = Math.max(0, fillBox.x0), fx1 = Math.min(W, fillBox.x1);
  for (let y = fy0; y < fy1; y++) {
    const row = y * W;
    for (let x = fx0; x < fx1; x++) {
      const i = row + x;
      if (!region[i]) continue;
      const j = i * 4;
      let rr = paper[j] + oR, gg = paper[j + 1] + oG, bb = paper[j + 2] + oB;
      if (sigma > 0.2) {
        rr += gauss(rng) * sigma; gg += gauss(rng) * sigma; bb += gauss(rng) * sigma;
      }
      out[j] = clamp255(rr);
      out[j + 1] = clamp255(gg);
      out[j + 2] = clamp255(bb);
    }
  }
}

function processPixels(img, sensKey, mode, exactBands) {
  const t0 = performance.now();
  const analyzed = analyze(img, sensKey);
  const { bands, aw, ah, scale } = analyzed;
  const W = img.width, H = img.height;
  const out = new Uint8ClampedArray(img.data);

  if (!bands.length && !(exactBands && exactBands.length)) {
    return { out, bands: [], elapsed: performance.now() - t0 };
  }

  const maskFull = upscaleMask(analyzed.mask, aw, ah, W, H);
  const tintFull = upscaleMask(analyzed.tint, aw, ah, W, H);
  const inv = 1 / scale;
  let scaled;
  if (exactBands && exactBands.length) {
    // PDF 螢光筆註解：用 quadPoints 做精準範圍（唔會食到旁邊嘅字）
    scaled = exactBands.map((r) => ({
      x0: Math.max(0, Math.floor(r.x0)),
      y0: Math.max(0, Math.floor(r.y0)),
      x1: Math.min(W, Math.ceil(r.x1)),
      y1: Math.min(H, Math.ceil(r.y1)),
    }));
  } else {
    scaled = bands.map((bd) => ({
      x0: Math.max(0, Math.floor(bd.x0 * inv)),
      y0: Math.max(0, Math.floor(bd.y0 * inv)),
      x1: Math.min(W, Math.ceil(bd.x1 * inv)),
      y1: Math.min(H, Math.ceil(bd.y1 * inv)),
    }));
  }

  if (mode === 'erase') {
    const paper = buildPaperField(img.data, maskFull, W, H, 24 * scale);
    const tintFull = upscaleMask(analyzed.tint, aw, ah, W, H);
    const rng = makeRng(1234);

    // 建立「筆觸封閉邊界」：筆觸 + 邊界內嘅文字/空隙（唔係長方形）
    const region = new Uint8Array(W * H);
    if (exactBands && exactBands.length) {
      for (const bd of scaled) {
        const x0 = Math.max(0, bd.x0), x1 = Math.min(W, bd.x1);
        const y0 = Math.max(0, bd.y0), y1 = Math.min(H, bd.y1);
        for (let y = y0; y < y1; y++) {
          const row = y * W;
          for (let x = x0; x < x1; x++) region[row + x] = 1;
        }
        // 註解外觀嘅凸出邊緣（cap）都抹走
        const ex0 = Math.max(0, x0 - 8), ex1 = Math.min(W, x1 + 8);
        const ey0 = Math.max(0, y0 - 4), ey1 = Math.min(H, y1 + 4);
        for (let y = ey0; y < ey1; y++) {
          const row = y * W;
          for (let x = ex0; x < ex1; x++) if (tintFull[row + x]) region[row + x] = 1;
        }
      }
    } else {
      for (const bd of scaled) {
        const x0 = Math.max(0, bd.x0 - 4), x1 = Math.min(W, bd.x1 + 4);
        const y0 = Math.max(0, bd.y0 - 4), y1 = Math.min(H, bd.y1 + 4);
        const w = x1 - x0, h = y1 - y0;
        if (w <= 2 || h <= 2) continue;
        // 1) 先將筆觸少少閉合，避免淡色邊緣有缺口令洪水漏出去
        const local = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
          const srow = (y + y0) * W;
          for (let x = 0; x < w; x++) local[y * w + x] = tintFull[srow + x0 + x] ? 1 : 0;
        }
        const closed = dilateFast(erodeFast(dilateFast(local, w, h, 3), w, h, 3), w, h, 3);
        // 2) 由邊界洪水填充，搵出「被筆觸圍住」嘅區域
        const outside = new Uint8Array(w * h);
        const stack = [];
        for (let x = 0; x < w; x++) {
          if (!closed[x]) { outside[x] = 1; stack.push(x); }
          const b = (h - 1) * w + x;
          if (!closed[b]) { outside[b] = 1; stack.push(b); }
        }
        for (let y = 0; y < h; y++) {
          if (!closed[y * w]) { outside[y * w] = 1; stack.push(y * w); }
          const b = y * w + w - 1;
          if (!closed[b]) { outside[b] = 1; stack.push(b); }
        }
        while (stack.length) {
          const p = stack.pop();
          const px = p % w, py = (p - px) / w;
          const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (const [dx, dy] of nb) {
            const nx = px + dx, ny = py + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const q = ny * w + nx;
            if (closed[q] || outside[q]) continue;
            outside[q] = 1;
            stack.push(q);
          }
        }
        // 3) 邊界內：筆觸 + 洞（文字）全部填
        for (let y = 0; y < h; y++) {
          const srow = (y + y0) * W;
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (!outside[i]) region[srow + x0 + x] = 1;
          }
        }
      }
    }

    // 4) 邊緣羽化（1-2px），再用紙色場 + 局部色差 + 紙紋填滿
    const alpha = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) alpha[i] = region[i] ? 255 : 0;
    for (let pass = 0; pass < 2; pass++) {
      const cp = new Uint8Array(alpha);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          let sum = 0, n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              sum += cp[yy * W + xx]; n++;
            }
          }
          alpha[i] = sum / n;
        }
      }
    }

    // 5) 局部色差：由邊界外 3–24px、真係似紙色嘅像素校正紙色場
    const d1 = dilateFast(region, W, H, 5);
    const d2 = dilateFast(region, W, H, 49);
    let sr = 0, sg = 0, sb = 0, pr = 0, pg = 0, pb = 0, n = 0;
    for (let i = 0; i < W * H; i++) {
      if (!d2[i] || d1[i]) continue;
      const j = i * 4;
      const dr = img.data[j] - paper[j];
      const dg = img.data[j + 1] - paper[j + 1];
      const db = img.data[j + 2] - paper[j + 2];
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 18) continue; // 似筆觸／字就跳過
      sr += dr; sg += dg; sb += db;
      n++;
    }
    let oR = 0, oG = 0, oB = 0;
    if (n >= 60) { oR = sr / n; oG = sg / n; oB = sb / n; }

    // 6) 紙紋噪音
    let nR = 0, nG = 0, nB = 0, nn = 0;
    for (let i = 0; i < W * H; i += 3) {
      if (region[i]) continue;
      const j = i * 4;
      nR += Math.abs(img.data[j] - paper[j]);
      nG += Math.abs(img.data[j + 1] - paper[j + 1]);
      nB += Math.abs(img.data[j + 2] - paper[j + 2]);
      nn++;
    }
    const sigma = nn ? 1.4826 * ((nR + nG + nB) / (nn * 3)) : 0;

    for (let i = 0; i < W * H; i++) {
      const a = alpha[i] / 255;
      if (a <= 0) continue;
      const j = i * 4;
      let rr = paper[j] + oR, gg = paper[j + 1] + oG, bb = paper[j + 2] + oB;
      if (sigma > 0.2) {
        rr += gauss(rng) * sigma; gg += gauss(rng) * sigma; bb += gauss(rng) * sigma;
      }
      out[j] = clamp255(img.data[j] * (1 - a) + rr * a);
      out[j + 1] = clamp255(img.data[j + 1] * (1 - a) + gg * a);
      out[j + 2] = clamp255(img.data[j + 2] * (1 - a) + bb * a);
    }
  } else {
    // 只抹字、保留螢光底色  } else {
    // 只抹字、保留螢光底色  } else {
    // 只抹字、保留螢光底色  } else {
    // 只抹字、保留螢光底色
    const useExact = !!(exactBands && exactBands.length);
    const textMask = useExact ? maskFull : dilateFast(tintFull, W, H, 5);
    for (const bd of scaled) {
      const { x0, y0, x1, y1 } = bd;
      const bw = x1 - x0, bh = y1 - y0;
      if (bw <= 0 || bh <= 0) continue;
      const colR = new Float32Array(bw), colG = new Float32Array(bw), colB = new Float32Array(bw);
      const colLum = new Float32Array(bw);
      for (let cx = 0; cx < bw; cx++) {
        const x = x0 + cx;
        let best = -1, br2 = 220, bg2 = 220, bb2 = 220;
        for (let y = y0; y < y1; y++) {
          const i = y * W + x;
          if (!useExact && !textMask[i]) continue;
          const j = i * 4;
          const mx = Math.max(img.data[j], img.data[j + 1], img.data[j + 2]);
          const mn = Math.min(img.data[j], img.data[j + 1], img.data[j + 2]);
          const score = (mx - mn) * mx / 255;
          if (score > best) { best = score; br2 = img.data[j]; bg2 = img.data[j + 1]; bb2 = img.data[j + 2]; }
        }
        colR[cx] = br2; colG[cx] = bg2; colB[cx] = bb2;
        colLum[cx] = br2 * 0.299 + bg2 * 0.587 + bb2 * 0.114;
      }
      for (let y = y0; y < y1; y++) {
        const row = y * W;
        for (let x = x0; x < x1; x++) {
          const i = row + x;
          if (!useExact && !textMask[i]) continue;
          const j = i * 4;
          const lum = img.data[j] * 0.299 + img.data[j + 1] * 0.587 + img.data[j + 2] * 0.114;
          const cx = x - x0;
          if (lum < colLum[cx] * 0.93) {
            out[j] = colR[cx]; out[j + 1] = colG[cx]; out[j + 2] = colB[cx];
          }
        }
      }
    }
  }

  return { out, bands: scaled, elapsed: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// 影像 → canvas
// ---------------------------------------------------------------------------

function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name) ||
    /image\/(heic|heif)/i.test(file.type || '');
}

async function decodeToBitmap(file) {
  if (isHeicFile(file)) {
    if (typeof heic2any === 'undefined') {
      throw new Error('HEIC 解碼器未載入，請重新整理頁面再試。');
    }
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    return await createImageBitmap(blob);
  }
  return await createImageBitmap(file);
}

async function imageFileToCanvas(file) {
  const bmp = await decodeToBitmap(file);
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return c;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function previewDataUrl(sourceCanvas) {
  const scale = Math.min(1, PREVIEW_W / sourceCanvas.width);
  const c = makeCanvas(sourceCanvas.width * scale, sourceCanvas.height * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function processImageFile(file, mode, sens) {
  const srcCanvas = await imageFileToCanvas(file);
  const img = srcCanvas.getContext('2d').getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const res = processPixels(img, sens, mode);

  const outCanvas = makeCanvas(srcCanvas.width, srcCanvas.height);
  outCanvas.getContext('2d').putImageData(new ImageData(res.out, srcCanvas.width, srcCanvas.height), 0, 0);
  const heic = isHeicFile(file);
  const isJpg = /\.jpe?g$/i.test(file.name);
  const toJpeg = heic || isJpg;
  const type = toJpeg ? 'image/jpeg' : 'image/png';
  const blob = await canvasToBlob(outCanvas, type, toJpeg ? 0.93 : undefined);

  return {
    blob,
    ext: toJpeg ? '.jpg' : '.png',
    convertedFromHeic: heic,
    beforeUrl: previewDataUrl(srcCanvas),
    afterUrl: previewDataUrl(outCanvas),
    stats: {
      kind: 'image', pages: 1, bands: res.bands.length,
      elapsed: res.elapsed / 1000, width: srcCanvas.width, height: srcCanvas.height,
      mode, sens, rasterized: 0, pages_touched: res.bands.length ? 1 : 0,
    },
  };
}

async function processPdfFile(file, mode, sens, onProgress) {
  const t0 = performance.now();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];

  for (let pno = 1; pno <= pdf.numPages; pno++) {
    if (onProgress) onProgress(pno, pdf.numPages);
    const page = await pdf.getPage(pno);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: DPI / 72 });
    const canvas = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let exactBands = null;
    try {
      const anns = await page.getAnnotations();
      const rects = [];
      for (const a of anns) {
        if (a.subtype !== 'Highlight' || !a.quadPoints) continue;
        let pts = a.quadPoints;
        if (Array.isArray(pts) && Array.isArray(pts[0])) pts = pts.flat();
        if (!Array.isArray(pts)) continue;
        // quadPoints 可能係 [{x,y}...] 或扁平數字
        const points = [];
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          if (p && typeof p.x === 'number') points.push(p);
          else if (typeof p === 'number' && i + 1 < pts.length) {
            points.push({ x: pts[i], y: pts[i + 1] });
            i++;
          }
        }
        for (let i = 0; i + 3 < points.length; i += 4) {
          let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
          for (let k = 0; k < 4; k++) {
            const [vx, vy] = viewport.convertToViewportPoint(points[i + k].x, points[i + k].y);
            if (vx < x0) x0 = vx; if (vx > x1) x1 = vx;
            if (vy < y0) y0 = vy; if (vy > y1) y1 = vy;
          }
          if (x1 > x0 && y1 > y0) rects.push({ x0, y0, x1, y1 });
        }
      }
      if (rects.length) exactBands = rects;
    } catch (e) { /* 冇註解就照用顏色偵測 */ }
    const res = processPixels(img, sens, mode, exactBands);
    const outCanvas = makeCanvas(canvas.width, canvas.height);
    outCanvas.getContext('2d').putImageData(new ImageData(res.out, canvas.width, canvas.height), 0, 0);
    const blob = await canvasToBlob(outCanvas, 'image/jpeg', 0.9);
    pages.push({
      blob, width: base.width, height: base.height,
      beforeUrl: previewDataUrl(canvas), afterUrl: previewDataUrl(outCanvas),
      bands: res.bands.length,
    });
    page.cleanup();
  }
  pdf.destroy();

  const { PDFDocument } = PDFLib;
  const outPdf = await PDFDocument.create();
  for (const p of pages) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const img = await outPdf.embedJpg(bytes);
    const page = outPdf.addPage([p.width, p.height]);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
  }
  const pdfBytes = await outPdf.save();
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });

  const totalBands = pages.reduce((a, p) => a + p.bands, 0);
  const touched = pages.filter((p) => p.bands > 0).length;
  const best = pages.reduce((a, p) => (p.bands > a.bands ? p : a), pages[0]);

  return {
    blob,
    ext: '.pdf',
    beforeUrl: best.beforeUrl,
    afterUrl: best.afterUrl,
    stats: {
      kind: 'pdf', pages: pdf.numPages, bands: totalBands,
      elapsed: (performance.now() - t0) / 1000, mode, sens,
      rasterized: pdf.numPages, pages_touched: touched,
    },
  };
}
