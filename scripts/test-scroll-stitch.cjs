// Tests for src/scroll-stitch.js against a synthetic tall page. No dependencies.
// Usage: node scripts/test-scroll-stitch.cjs
const path = require('node:path');
const { ScrollStitcher, HorizontalScrollStitcher, DirectionalScrollStitcher } = require(path.join(__dirname, '..', 'src', 'scroll-stitch.js'));

function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// White page with "text" lines (random glyph pixels), colored blocks, rules and short blank
// gaps; one big blank band [blankFrom, blankTo) for the ambiguity test.
function makePage(W, H, seed, blankFrom, blankTo) {
  const r = rng(seed), data = new Uint8ClampedArray(W * H * 4).fill(255);
  const px = (x, y, c0, c1, c2) => { const i = (y * W + x) * 4; data[i] = c0; data[i + 1] = c1; data[i + 2] = c2; };
  const text = (y0, lines) => {
    for (let l = 0; l < lines; l++) {
      const top = y0 + l * 22 + 4;
      let x = 30 + Math.floor(r() * 80);
      const right = W - 30 - Math.floor(r() * 300);
      while (x < right) {
        const w = 20 + Math.floor(r() * 100);
        for (let y = top; y < top + 14 && y < H; y++) {
          for (let xx = x; xx < Math.min(x + w, right); xx++) if (r() < 0.45) { const g = 30 + Math.floor(r() * 60); px(xx, y, g, g, g + 20); }
        }
        x += w + 8 + Math.floor(r() * 10);
      }
    }
    return lines * 22;
  };
  const block = (y0, h) => {
    const x0 = Math.floor(r() * W / 2), x1 = x0 + 200 + Math.floor(r() * (W / 2 - 200));
    const c = [r() * 255, r() * 255, r() * 255];
    for (let y = y0; y < y0 + h && y < H; y++) {
      for (let x = x0; x < Math.min(x1, W); x++) px(x, y, c[0] + (y - y0) * 0.4 + r() * 30, c[1] + r() * 30, c[2] + (x - x0) * 0.1);
    }
    return h;
  };
  let y = 0;
  const fill = until => {
    while (y < until) {
      const k = r();
      let h;
      if (k < 0.55) h = text(y, 3 + Math.floor(r() * 10));
      else if (k < 0.75) h = block(y, 40 + Math.floor(r() * 160));
      else if (k < 0.85) { for (let x = 20; x < W - 20; x++) { px(x, y, 180, 180, 190); px(x, y + 1, 180, 180, 190); } h = 6; }
      else h = 30 + Math.floor(r() * 90); // short blank gap
      y += h + 8;
    }
  };
  fill(blankFrom);
  y = blankTo;
  fill(H);
  // Blank band must stay blank even if a section above ran into it.
  data.fill(255, blankFrom * W * 4, blankTo * W * 4);
  return { width: W, height: H, data };
}

const HEADER = 60, FOOTER = 40;
function bar(W, rows, seed, base) {
  const r = rng(seed), d = new Uint8ClampedArray(W * rows * 4);
  for (let i = 0; i < d.length; i += 4) { const n = r() < 0.2 ? 80 : 0; d[i] = base[0] + n; d[i + 1] = base[1] + n; d[i + 2] = base[2]; d[i + 3] = 255; }
  return d;
}

// Viewport of height VH at scroll position P; optional sticky header/footer and ±noise.
function frameAt(page, P, VH, { sticky, noise, seed = P } = {}) {
  const W = page.width, rb = W * 4, out = new Uint8ClampedArray(W * VH * 4);
  if (sticky) {
    out.set(sticky.header, 0);
    out.set(page.data.subarray(P * rb, (P + VH - HEADER - FOOTER) * rb), HEADER * rb);
    out.set(sticky.footer, (VH - FOOTER) * rb);
  } else out.set(page.data.subarray(P * rb, (P + VH) * rb));
  if (noise) {
    const r = rng(seed * 7919 + 1);
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] += Math.round((r() * 2 - 1) * noise);
  }
  return { width: W, height: VH, data: out };
}

function pageRows(page, from, to) { const rb = page.width * 4; return page.data.subarray(from * rb, to * rb); }
function concat(...parts) {
  const out = new Uint8ClampedArray(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// Returns null when equal within tol (RGB only), else a description of the first mismatch.
function diff(res, expected, W, tol = 0) {
  if (res.data.length !== expected.length) return `height ${res.height} != expected ${expected.length / W / 4}`;
  for (let i = 0; i < expected.length; i++) {
    if (i % 4 !== 3 && Math.abs(res.data[i] - expected[i]) > tol) return `pixel mismatch at row ${Math.floor(i / 4 / W)}`;
  }
  return null;
}

const results = [];
function test(name, fn) {
  const t0 = performance.now();
  let err = null;
  try { err = fn(); } catch (e) { err = e.stack || String(e); }
  results.push(!err);
  console.log(`${err ? 'FAIL' : 'PASS'}  ${name}  (${(performance.now() - t0).toFixed(0)} ms)${err ? `\n      ${err}` : ''}`);
}
function expectStatus(r, status, dy) {
  const ok = Array.isArray(status) ? status.includes(r.status) : r.status === status;
  if (!ok || (dy !== undefined && r.dy !== dy)) throw new Error(`expected ${status}${dy !== undefined ? ` dy=${dy}` : ''}, got ${JSON.stringify(r)}`);
}
function steps(from, to, list) {
  const out = [from];
  for (let i = 0; out[out.length - 1] + list[i % list.length] <= to; i++) out.push(out[out.length - 1] + list[i % list.length]);
  return out;
}

const W = 1200, VH = 800, BLANK_FROM = 3900, BLANK_TO = 5400;
const page = makePage(W, 6000, 42, BLANK_FROM, BLANK_TO);
const STEPS = [37, 120, 300, 512];

function runSteady(opts, positions) {
  const s = new ScrollStitcher();
  positions.forEach((P, i) => expectStatus(s.addFrame(frameAt(page, P, VH, opts)), i ? 'appended' : 'first', i ? P - positions[i - 1] : 0));
  return { s, last: positions[positions.length - 1] };
}

test('1. steady scrolling, dy 37/120/300/512', () => {
  const pos = steps(0, BLANK_FROM - VH - 50, STEPS);
  const { s, last } = runSteady({}, pos);
  return diff(s.result(), pageRows(page, 0, last + VH), W);
});

test('2. sticky header (60) + footer (40)', () => {
  const sticky = { header: bar(W, HEADER, 1, [20, 40, 120]), footer: bar(W, FOOTER, 2, [90, 90, 90]) };
  const pos = steps(0, BLANK_FROM - VH, STEPS);
  const { s, last } = runSteady({ sticky }, pos);
  const content = VH - HEADER - FOOTER;
  return diff(s.result(), concat(sticky.header, pageRows(page, 0, last + content), sticky.footer), W);
});

test('3. duplicate frames / no scroll -> unchanged', () => {
  const s = new ScrollStitcher();
  expectStatus(s.addFrame(frameAt(page, 500, VH)), 'first');
  expectStatus(s.addFrame(frameAt(page, 500, VH)), 'unchanged');
  expectStatus(s.addFrame(frameAt(page, 500, VH, { noise: 3, seed: 1 })), 'unchanged');
  expectStatus(s.addFrame(frameAt(page, 620, VH)), 'appended', 120);
  expectStatus(s.addFrame(frameAt(page, 620, VH)), 'unchanged');
  return diff(s.result(), pageRows(page, 500, 620 + VH), W);
});

test('4. jump past viewport -> lost, then recover', () => {
  const s = new ScrollStitcher();
  expectStatus(s.addFrame(frameAt(page, 1000, VH)), 'first');
  expectStatus(s.addFrame(frameAt(page, 2000, VH)), 'lost');
  expectStatus(s.addFrame(frameAt(page, 2600, VH)), 'lost');
  expectStatus(s.addFrame(frameAt(page, 1400, VH)), 'appended', 400);
  expectStatus(s.addFrame(frameAt(page, 1700, VH)), 'appended', 300);
  return diff(s.result(), pageRows(page, 1000, 1700 + VH), W);
});

test('5. per-pixel noise +-3 still stitches', () => {
  const pos = steps(0, BLANK_FROM - VH - 50, STEPS);
  const s = new ScrollStitcher();
  pos.forEach((P, i) => expectStatus(s.addFrame(frameAt(page, P, VH, { noise: 3 })), i ? 'appended' : 'first', i ? P - pos[i - 1] : 0));
  return diff(s.result(), pageRows(page, 0, pos[pos.length - 1] + VH), W, 3);
});

test('6. scrolling up is ignored, then resume down', () => {
  const s = new ScrollStitcher();
  expectStatus(s.addFrame(frameAt(page, 1000, VH)), 'first');
  expectStatus(s.addFrame(frameAt(page, 1200, VH)), 'appended', 200);
  const up = s.addFrame(frameAt(page, 1100, VH));
  expectStatus(up, 'unchanged');
  if (up.dy !== -100) throw new Error(`expected detected dy -100, got ${up.dy}`);
  expectStatus(s.addFrame(frameAt(page, 900, VH)), 'unchanged');
  expectStatus(s.addFrame(frameAt(page, 1350, VH)), 'appended', 150);
  return diff(s.result(), pageRows(page, 1000, 1350 + VH), W);
});

test('7. maxHeight cap -> full', () => {
  const s = new ScrollStitcher({ maxHeight: 3000 });
  let P = 0, r = s.addFrame(frameAt(page, 0, VH));
  while (r.status !== 'full') {
    P += 300;
    r = s.addFrame(frameAt(page, P, VH));
    if (r.status !== 'appended' && r.status !== 'full') throw new Error(`unexpected ${JSON.stringify(r)}`);
  }
  if (s.height !== 3000 || r.height !== 3000) throw new Error(`height ${s.height}`);
  expectStatus(s.addFrame(frameAt(page, P + 300, VH)), 'full');
  const res = s.result();
  // The footer (rows static in the last pair) sits at the bottom; the content above it is exact.
  const top = 3000 - VH;
  return diff({ data: res.data.subarray(0, top * W * 4) }, pageRows(page, 0, top), W);
});

test('8. frames inside a big blank band never stitch wrong content', () => {
  // a) leaving textured content into the blank band, then scrolling back into range
  const s = new ScrollStitcher();
  expectStatus(s.addFrame(frameAt(page, 3000, VH)), 'first');
  for (const P of [3950, 4100, 4300, 4500]) expectStatus(s.addFrame(frameAt(page, P, VH)), ['lost', 'unchanged']);
  let err = diff(s.result(), pageRows(page, 3000, 3000 + VH), W);
  if (err) return `a: ${err}`;
  expectStatus(s.addFrame(frameAt(page, 3300, VH)), 'appended', 300);
  err = diff(s.result(), pageRows(page, 3000, 3300 + VH), W);
  if (err) return `a2: ${err}`;
  // b) starting fully inside the band and scrolling toward content below it
  const s2 = new ScrollStitcher();
  expectStatus(s2.addFrame(frameAt(page, 4000, VH, { noise: 3 })), 'first');
  for (const P of [4000, 4200, 4400, 4600, 4700, 4750]) {
    const r = s2.addFrame(frameAt(page, P, VH, { noise: 3 }));
    expectStatus(r, ['lost', 'unchanged']);
  }
  err = diff(s2.result(), pageRows(page, 4000, 4000 + VH), W, 3);
  return err && `b: ${err}`;
});

test('9. random scroll fuzz: result is always an exact page slice', () => {
  const r = rng(99), counts = {};
  for (let run = 0; run < 4; run++) {
    const s = new ScrollStitcher(), P0 = Math.floor(r() * 2000);
    let P = P0;
    s.addFrame(frameAt(page, P, VH, { noise: 2, seed: run }));
    for (let i = 0; i < 20; i++) {
      P = Math.max(0, Math.min(page.height - VH, P + Math.floor(r() * 800) - 200));
      const st = s.addFrame(frameAt(page, P, VH, { noise: 2, seed: run * 100 + i })).status;
      counts[st] = (counts[st] || 0) + 1;
    }
    const err = diff(s.result(), pageRows(page, P0, P0 + s.height), W, 2);
    if (err) return `run ${run}: ${err}`;
  }
  console.log(`      statuses: ${JSON.stringify(counts)}`);
});

// Horizontal: a vertical fixture transposed is the same page scrolled sideways, so every
// expected result is just the transposed vertical expectation.
function transposeImg({ width, height, data }) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = (x * height + y) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
  }
  return { width: height, height: width, data: out };
}

test('H1. horizontal scrolling with fixed left sidebar + right column', () => {
  const sticky = { header: bar(W, HEADER, 1, [20, 40, 120]), footer: bar(W, FOOTER, 2, [90, 90, 90]) };
  const s = new HorizontalScrollStitcher({ maxWidth: 20000 });
  const pos = steps(0, BLANK_FROM - VH, STEPS);
  pos.forEach((p, i) => expectStatus(s.addFrame(transposeImg(frameAt(page, p, VH, { sticky }))), i ? 'appended' : 'first'));
  const content = VH - HEADER - FOOTER;
  const expected = concat(sticky.header, pageRows(page, 0, pos[pos.length - 1] + content), sticky.footer);
  const res = s.result();
  if (res.height !== W) throw new Error(`height ${res.height} != ${W}`);
  return diff(transposeImg(res), expected, W);
});

test('H2. horizontal: scrolling left is ignored, then resume right', () => {
  const s = new HorizontalScrollStitcher();
  expectStatus(s.addFrame(transposeImg(frameAt(page, 400, VH))), 'first');
  expectStatus(s.addFrame(transposeImg(frameAt(page, 300, VH))), 'unchanged');
  expectStatus(s.addFrame(transposeImg(frameAt(page, 550, VH))), 'appended', 150);
  if (s.length !== VH + 150) throw new Error(`length ${s.length}`);
  return diff(transposeImg(s.result()), pageRows(page, 400, 550 + VH), W);
});

function runReverse(direction, orient) {
  const sticky = { header: bar(W, HEADER, 1, [20, 40, 120]), footer: bar(W, FOOTER, 2, [90, 90, 90]) };
  const pos = steps(0, BLANK_FROM - VH, STEPS).reverse();   // start low on the page, move back toward the top
  const s = new DirectionalScrollStitcher(direction);
  pos.forEach((p, i) => expectStatus(s.addFrame(orient(frameAt(page, p, VH, { sticky }))), i ? 'appended' : 'first', i ? pos[i - 1] - p : 0));
  // Moving the opposite way is ignored.
  expectStatus(s.addFrame(orient(frameAt(page, pos[pos.length - 1] + 200, VH, { sticky }))), 'unchanged');
  const content = VH - HEADER - FOOTER;
  const expected = concat(sticky.header, pageRows(page, pos[pos.length - 1], pos[0] + content), sticky.footer);
  return diff(orient(s.result()), expected, W);
}

test('U1. scrolling up with sticky header + footer', () => runReverse('up', f => f));
test('L1. scrolling left with fixed sidebar + right column', () => runReverse('left', transposeImg));

test('frame size mismatch throws', () => {
  const s = new ScrollStitcher();
  s.addFrame(frameAt(page, 0, VH));
  try { s.addFrame(frameAt(page, 0, VH - 1)); } catch { return null; }
  return 'no throw';
});

// Timing: 1600x1200 frames, steady scroll with noise, plus unchanged and lost frames.
{
  const TW = 1600, TH = 1200, big = makePage(TW, 9000, 7, 8990, 9000);
  const maxP = 9000 - TH - 20, pos = steps(0, maxP, STEPS), frames = pos.map(P => frameAt(big, P, TH, { noise: 2 }));
  const time = fn => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };
  const s = new ScrollStitcher();
  const t = { appended: [], unchanged: [], lost: [] };
  s.addFrame(frames[0]);
  for (let i = 1; i < pos.length; i++) {
    for (const f of [frames[i], frames[i]]) { // second copy = unchanged
      const [ms, r] = time(() => s.addFrame(f));
      (t[r.status] || (t[r.status] = [])).push(ms);
    }
    if (i % 3 === 0 && pos[i] + 2 * TH <= maxP) { // jump past the viewport = lost
      const [ms, r] = time(() => s.addFrame(frameAt(big, pos[i] + 2 * TH, TH)));
      (t[r.status] || (t[r.status] = [])).push(ms);
    }
  }
  const [rms] = time(() => s.result());
  const stat = a => a.length ? `n=${a.length} mean ${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)} ms, max ${Math.max(...a).toFixed(1)} ms` : 'n=0';
  console.log(`\nTiming 1600x1200 (stitched ${s.height}px):`);
  for (const k of Object.keys(t)) console.log(`  ${k.padEnd(9)} ${stat(t[k])}`);
  console.log(`  result()  ${rms.toFixed(1)} ms`);
}

const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
