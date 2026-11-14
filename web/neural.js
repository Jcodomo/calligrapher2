// neural.js — optional neural handwriting backend for Calligrapher 2.
//
// A faithful in-browser port of the Graves text-conditioned handwriting-synthesis
// RNN (3x LSTM(400) + K=10 attention window + M=20 mixture-density output), matching
// sjvasquez/handwriting-synthesis. Weights are the upstream pretrained checkpoint,
// exported to weights.bin + weights.json.
//
// LICENSING: the pretrained weights derive from a model trained on the IAM On-Line
// Handwriting Database (academic / non-commercial terms) and the upstream MIT-less
// project by GirkovArpa. This engine is OFF by default and must NOT be enabled on a
// public/commercial deployment without clearing those terms. The procedural engine
// (lib.rs / wasm) remains the default and the only thing the public build ships.
//
// Output: an array of stroke polylines in the same coordinate convention the
// renderer expects, so calligrapher2's features (nib weight, ink, paper, export,
// animation) apply on top unchanged.

// The model's fixed alphabet (index 0 is the null/unknown slot).
export const ALPHABET = [
  '\x00', ' ', '!', '"', '#', "'", '(', ')', ',', '-', '.',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';',
  '?', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
  'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'W', 'Y',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
  'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x',
  'y', 'z',
];
const ALPHA_INDEX = new Map(ALPHABET.map((c, i) => [c, i]));
const ALPHA_N = ALPHABET.length; // 77

const LSTM = 400;
const K_ATTN = 10;   // attention mixture components
const M_OUT = 20;    // output mixture components
const OUT_UNITS = 6 * M_OUT + 1; // 121

// ---------------------------------------------------------------------------
// tiny math helpers
// ---------------------------------------------------------------------------
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const softplus = (x) => (x > 20 ? x : Math.log1p(Math.exp(x)));

// z = x * W + b, where W is row-major [inN, outN], x is length inN, out length outN.
function dense(x, W, b, inN, outN) {
  const out = new Float32Array(outN);
  if (b) out.set(b);
  for (let i = 0; i < inN; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const base = i * outN;
    for (let o = 0; o < outN; o++) out[o] += xi * W[base + o];
  }
  return out;
}

// One step of a TF LSTMCell. kernel [in+H, 4H] gate order [i, j, f, o], forget_bias 1.
function lstmStep(xin, h, c, kernel, bias, H) {
  const inN = xin.length;
  const concatN = inN + H;
  const cat = new Float32Array(concatN);
  cat.set(xin, 0);
  cat.set(h, inN);
  const z = dense(cat, kernel, bias, concatN, 4 * H); // [i, j, f, o] blocks of H
  const nh = new Float32Array(H);
  const nc = new Float32Array(H);
  for (let k = 0; k < H; k++) {
    const i = sigmoid(z[k]);
    const j = Math.tanh(z[H + k]);
    const f = sigmoid(z[2 * H + k] + 1.0); // + forget_bias
    const o = sigmoid(z[3 * H + k]);
    const cc = c[k] * f + i * j;
    nc[k] = cc;
    nh[k] = o * Math.tanh(cc);
  }
  return [nh, nc];
}

// ---------------------------------------------------------------------------
// seeded RNG + samplers
// ---------------------------------------------------------------------------
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  // xorshift32
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function gauss(rng) {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function categorical(pis, rng) {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < pis.length; i++) { acc += pis[i]; if (r <= acc) return i; }
  return pis.length - 1;
}

// ---------------------------------------------------------------------------
// weight container — resolved from the exported manifest
// ---------------------------------------------------------------------------
class Weights {
  constructor(manifest, buffer) {
    this.m = manifest;
    this.buf = buffer;
    this._cache = new Map();
  }
  has(name) { return !!this.m.vars[name]; }
  get(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const v = this.m.vars[name];
    if (!v) throw new Error('missing weight: ' + name);
    const arr = new Float32Array(this.buf, v.offset, v.count);
    this._cache.set(name, arr);
    return arr;
  }
  // find a var by exact name, else by a predicate over [name, shape]
  find(pred) {
    for (const name of this.m.order) {
      if (pred(name, this.m.vars[name].shape)) return name;
    }
    return null;
  }
}

// Resolve the concrete variable names from the checkpoint. The names use TF scopes;
// we order the three LSTM cells deterministically and locate the two dense layers
// by their distinctive output sizes (attention -> 30, gmm -> 121).
function resolveGraph(w) {
  const sameShape = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  // LSTM kernels: shape [*, 1600]; biases [1600]. Order by variable name (lstm_cell, _1, _2).
  const lstmKernels = w.m.order
    .filter((n) => { const s = w.m.vars[n].shape; return s.length === 2 && s[1] === 4 * LSTM && /kernel|weights/i.test(n); })
    .sort();
  const lstmBiases = w.m.order
    .filter((n) => { const s = w.m.vars[n].shape; return s.length === 1 && s[0] === 4 * LSTM && /bias/i.test(n); })
    .sort();
  // dense attention: weights [*, 30]
  const attW = w.find((n, s) => s.length === 2 && s[1] === 3 * K_ATTN && /attention/i.test(n) && /weight|kernel/i.test(n));
  const attB = w.find((n, s) => s.length === 1 && s[0] === 3 * K_ATTN && /attention/i.test(n) && /bias/i.test(n));
  // dense gmm: weights [400, 121] — prefer the cell's gmm (input dim 400), not the time-distributed one
  const gmmW = w.find((n, s) => s.length === 2 && s[0] === LSTM && s[1] === OUT_UNITS && /gmm/i.test(n) && /weight|kernel/i.test(n));
  const gmmB = w.find((n, s) => s.length === 1 && s[0] === OUT_UNITS && /gmm/i.test(n) && /bias/i.test(n));
  if (lstmKernels.length < 3 || !attW || !gmmW) {
    throw new Error('could not resolve model graph from weights.json — check variable names:\n' + w.m.order.join('\n'));
  }
  return {
    lstm: [0, 1, 2].map((i) => ({ kernel: w.get(lstmKernels[i]), bias: w.get(lstmBiases[i]) })),
    att: { W: w.get(attW), b: w.get(attB) },
    gmm: { W: w.get(gmmW), b: w.get(gmmB) },
    _names: { lstmKernels, lstmBiases, attW, attB, gmmW, gmmB },
  };
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------
export class NeuralHand {
  constructor(graph) { this.g = graph; }

  static async load(baseUrl = './model/') {
    const [mjson, bbin] = await Promise.all([
      fetch(baseUrl + 'weights.json').then((r) => { if (!r.ok) throw new Error('weights.json not found'); return r.json(); }),
      fetch(baseUrl + 'weights.bin').then((r) => { if (!r.ok) throw new Error('weights.bin not found'); return r.arrayBuffer(); }),
    ]);
    const w = new Weights(mjson, bbin);
    return new NeuralHand(resolveGraph(w));
  }

  // Sample stroke offsets [dx,dy,eos] for one line of text.
  sample(text, { bias = 0.75, seed = 1, maxSteps = null } = {}) {
    const g = this.g;
    // encode chars (+ trailing null, as upstream encode_ascii does)
    const cs = [];
    for (const ch of text) cs.push(ALPHA_INDEX.get(ch) ?? 0);
    cs.push(0);
    const C = cs.length;
    const steps = maxSteps ?? 40 * text.length + 20;
    const rng = makeRng(seed);

    // state
    let h1 = new Float32Array(LSTM), c1 = new Float32Array(LSTM);
    let h2 = new Float32Array(LSTM), c2 = new Float32Array(LSTM);
    let h3 = new Float32Array(LSTM), c3 = new Float32Array(LSTM);
    let kappa = new Float32Array(K_ATTN);
    let wnd = new Float32Array(ALPHA_N); // attention window (one-hot weighted)
    let inp = Float32Array.of(0, 0, 1);  // initial input [x,y,eos]

    const out = [];
    for (let t = 0; t < steps; t++) {
      // lstm 1: input [w, inp]
      const s1in = new Float32Array(ALPHA_N + 3);
      s1in.set(wnd, 0); s1in.set(inp, ALPHA_N);
      [h1, c1] = lstmStep(s1in, h1, c1, g.lstm[0].kernel, g.lstm[0].bias, LSTM);

      // attention: dense([w, inp, h1] -> 30)
      const ain = new Float32Array(ALPHA_N + 3 + LSTM);
      ain.set(wnd, 0); ain.set(inp, ALPHA_N); ain.set(h1, ALPHA_N + 3);
      const ap = dense(ain, g.att.W, g.att.b, ain.length, 3 * K_ATTN);
      // softplus, split [alpha, beta, kappa]
      const alpha = new Float32Array(K_ATTN), beta = new Float32Array(K_ATTN), dk = new Float32Array(K_ATTN);
      for (let k = 0; k < K_ATTN; k++) {
        alpha[k] = softplus(ap[k]);
        beta[k] = Math.max(softplus(ap[K_ATTN + k]), 0.01);
        dk[k] = softplus(ap[2 * K_ATTN + k]);
        kappa[k] = kappa[k] + dk[k] / 25.0;
      }
      // phi over char positions, window = sum_u phi_u * onehot(cs[u])
      const newW = new Float32Array(ALPHA_N);
      let phiArgmax = 0, phiMax = -Infinity;
      for (let u = 0; u < C; u++) {
        let phi = 0;
        for (let k = 0; k < K_ATTN; k++) {
          const d = kappa[k] - u;
          phi += alpha[k] * Math.exp(-(d * d) / beta[k]); // upstream: exp(-(kappa-u)^2 / beta)
        }
        if (phi > phiMax) { phiMax = phi; phiArgmax = u; }
        newW[cs[u]] += phi; // attention_values are one-hot(cs[u])
      }
      wnd = newW;

      // lstm 2: [inp, h1, w]
      const s2in = new Float32Array(3 + LSTM + ALPHA_N);
      s2in.set(inp, 0); s2in.set(h1, 3); s2in.set(wnd, 3 + LSTM);
      [h2, c2] = lstmStep(s2in, h2, c2, g.lstm[1].kernel, g.lstm[1].bias, LSTM);

      // lstm 3: [inp, h2, w]
      const s3in = new Float32Array(3 + LSTM + ALPHA_N);
      s3in.set(inp, 0); s3in.set(h2, 3); s3in.set(wnd, 3 + LSTM);
      [h3, c3] = lstmStep(s3in, h3, c3, g.lstm[2].kernel, g.lstm[2].bias, LSTM);

      // output MDN: dense(h3 -> 121)
      const p = dense(h3, g.gmm.W, g.gmm.b, LSTM, OUT_UNITS);
      // split [pis(20), sigmas(40), rhos(20), mus(40), es(1)]
      const pis = new Float32Array(M_OUT);
      let o = 0;
      for (let k = 0; k < M_OUT; k++) pis[k] = p[o++] * (1 + bias);
      const sig = new Float32Array(2 * M_OUT);
      for (let k = 0; k < 2 * M_OUT; k++) sig[k] = p[o++];
      const rho = new Float32Array(M_OUT);
      for (let k = 0; k < M_OUT; k++) rho[k] = Math.tanh(p[o++]);
      const mu = new Float32Array(2 * M_OUT);
      for (let k = 0; k < 2 * M_OUT; k++) mu[k] = p[o++];
      const es = sigmoid(p[o++]);

      // softmax(pis) with bias already applied (sharpening)
      let mx = -Infinity;
      for (let k = 0; k < M_OUT; k++) if (pis[k] > mx) mx = pis[k];
      let sum = 0;
      for (let k = 0; k < M_OUT; k++) { pis[k] = Math.exp(pis[k] - mx); sum += pis[k]; }
      for (let k = 0; k < M_OUT; k++) pis[k] /= sum;

      // pick a component and sample a bivariate normal; sigmas = exp(sigma - bias)
      const idx = categorical(pis, rng);
      const s1 = Math.max(Math.exp(sig[idx] - bias), 1e-4);
      const s2 = Math.max(Math.exp(sig[M_OUT + idx] - bias), 1e-4);
      const r = rho[idx];
      const z1 = gauss(rng), z2 = gauss(rng);
      const dx = mu[idx] + s1 * z1;
      const dy = mu[M_OUT + idx] + s2 * (r * z1 + Math.sqrt(1 - r * r) * z2);
      const eos = rng() < es ? 1 : 0;

      out.push([dx, dy, eos]);
      inp = Float32Array.of(dx, dy, eos);

      // termination: attention past the final char
      if (phiArgmax >= C - 1 && eos === 1) break;
      if (phiArgmax >= C) break;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// offsets -> coordinates -> stroke polylines, matching upstream post-processing.
// ---------------------------------------------------------------------------

// Savitzky-Golay smoothing (window 7, polyorder 3) coefficients for the midpoint.
const SAVGOL7 = [-2 / 21, 3 / 21, 6 / 21, 7 / 21, 6 / 21, 3 / 21, -2 / 21];
function savgol(a) {
  const n = a.length;
  if (n < 7) return a.slice();
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -3; k <= 3; k++) {
      let j = i + k;
      if (j < 0) j = 0; else if (j >= n) j = n - 1; // 'nearest'
      acc += SAVGOL7[k + 3] * a[j];
    }
    out[i] = acc;
  }
  return out;
}

// Least-squares deslant (align): remove global slope, subtract offset.
function align(xs, ys) {
  const n = xs.length;
  let sx = 0, sxx = 0, sy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sxx += xs[i] * xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; }
  const det = n * sxx - sx * sx || 1;
  const offset = (sxx * sy - sx * sxy) / det;
  const slope = (n * sxy - sx * sy) / det;
  const theta = Math.atan(slope);
  const ct = Math.cos(theta), st = Math.sin(theta);
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    xs[i] = x * ct + y * st;          // [x y] . [[cos,-sin],[sin,cos]]
    ys[i] = x * -st + y * ct - offset;
  }
}

// Turn sampled offsets into polylines in em units (x-height ~ 1), y up.
// Returns { strokes: [[{x,y}...]...], width, height }.
export function offsetsToStrokes(offsets, { scale = 1.5 } = {}) {
  // cumulative coords
  const n = offsets.length;
  const X = new Float64Array(n), Y = new Float64Array(n), E = new Uint8Array(n);
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += offsets[i][0] * scale;
    cy += offsets[i][1] * scale;
    X[i] = cx; Y[i] = cy; E[i] = offsets[i][2];
  }
  // split into strokes at eos, denoise each, collect
  const strokes = [];
  let start = 0;
  const segs = [];
  for (let i = 0; i < n; i++) if (E[i] === 1) { segs.push([start, i + 1]); start = i + 1; }
  if (start < n) segs.push([start, n]);
  // denoise per stroke, then align across all points
  const ax = [], ay = [], owner = [];
  for (const [a, b] of segs) {
    if (b - a <= 0) continue;
    const sx = savgol(X.slice(a, b));
    const sy = savgol(Y.slice(a, b));
    const idx = strokes.length;
    const pts = [];
    for (let i = 0; i < sx.length; i++) { pts.push({ x: sx[i], y: sy[i] }); ax.push(sx[i]); ay.push(sy[i]); owner.push(idx); }
    strokes.push(pts);
  }
  if (ax.length) {
    const fx = Float64Array.from(ax), fy = Float64Array.from(ay);
    align(fx, fy);
    // model space has y growing downward; flip to y-up (em convention)
    let j = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pts of strokes) for (const p of pts) {
      p.x = fx[j]; p.y = -fy[j]; j++;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    // normalise so baseline-ish sits at 0 and scale to x-height ~1 using stroke stats
    const h = maxY - minY || 1;
    const k = 1.0 / (h * 0.5);
    for (const pts of strokes) for (const p of pts) { p.x = (p.x - minX) * k; p.y = (p.y - minY) * k; }
    return { strokes, width: (maxX - minX) * k, height: (maxY - minY) * k };
  }
  return { strokes, width: 0, height: 0 };
}
