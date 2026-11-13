//! calligrapher2 — original procedural calligraphy / handwriting generator.
//!
//! Pure-Rust engine, compiled to `wasm32-unknown-unknown` with the raw C ABI
//! (no wasm-bindgen). It turns a line of text into handwritten-looking strokes:
//!
//!   1. each glyph is an original set of parametric pen strokes in em units,
//!   2. strokes are smoothed (Catmull-Rom) and joined cursively along a baseline,
//!   3. per-run seeded noise adds jitter, slant, baseline wobble and size drift,
//!   4. pen "speed" modulates stroke width for a calligraphic nib weight,
//!   5. the result is emitted as an SVG document (fill = currentColor).
//!
//! Nothing here is derived from any third-party binary, font, or model; the
//! letterforms are hand-authored control polylines.

#![allow(clippy::needless_range_loop)]

use std::f32::consts::PI;

// ---------------------------------------------------------------------------
// Small deterministic RNG (SplitMix64 -> f32 in [0,1)) + value noise.
// ---------------------------------------------------------------------------

struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
    fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }
    fn sym(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

/// Smooth 1-D value noise, used for organic baseline / jitter drift.
fn value_noise(seed: u64, x: f32) -> f32 {
    let xi = x.floor();
    let xf = x - xi;
    let h = |i: f32| -> f32 {
        let n = (i as i64 as u64) ^ seed.wrapping_mul(0x2545_f491_4f6c_dd1d);
        Rng(n).sym()
    };
    let a = h(xi);
    let b = h(xi + 1.0);
    let t = xf * xf * (3.0 - 2.0 * xf); // smoothstep
    a + (b - a) * t
}

// ---------------------------------------------------------------------------
// Geometry primitives.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Pt {
    x: f32,
    y: f32,
}
impl Pt {
    fn new(x: f32, y: f32) -> Self {
        Pt { x, y }
    }
}

struct Stroke {
    pts: Vec<Pt>,
}

struct Glyph {
    strokes: Vec<Stroke>,
    advance: f32,
    entry_y: f32,
    exit_y: f32,
    connects: bool,
}
impl Glyph {
    fn exit_x_hint(&self) -> f32 {
        self.advance * 0.9
    }
}

// Em metrics (y grows upward; converted to SVG at the end).
const X_HEIGHT: f32 = 1.0;
const ASCENDER: f32 = 1.72;
const CAP: f32 = 1.72;
const DESCENDER: f32 = -0.62;

// ---------------------------------------------------------------------------
// Catmull-Rom smoothing: turn a sparse control polyline into a dense curve.
// ---------------------------------------------------------------------------

fn catmull_rom(ctrl: &[Pt], per_seg: usize) -> Vec<Pt> {
    if ctrl.len() < 2 {
        return ctrl.to_vec();
    }
    let mut out = Vec::with_capacity(ctrl.len() * per_seg);
    let n = ctrl.len();
    for i in 0..n - 1 {
        let p0 = ctrl[if i == 0 { 0 } else { i - 1 }];
        let p1 = ctrl[i];
        let p2 = ctrl[i + 1];
        let p3 = ctrl[if i + 2 < n { i + 2 } else { n - 1 }];
        for s in 0..per_seg {
            let t = s as f32 / per_seg as f32;
            let t2 = t * t;
            let t3 = t2 * t;
            let x = 0.5
                * ((2.0 * p1.x)
                    + (-p0.x + p2.x) * t
                    + (2.0 * p0.x - 5.0 * p1.x + 4.0 * p2.x - p3.x) * t2
                    + (-p0.x + 3.0 * p1.x - 3.0 * p2.x + p3.x) * t3);
            let y = 0.5
                * ((2.0 * p1.y)
                    + (-p0.y + p2.y) * t
                    + (2.0 * p0.y - 5.0 * p1.y + 4.0 * p2.y - p3.y) * t2
                    + (-p0.y + 3.0 * p1.y - 3.0 * p2.y + p3.y) * t3);
            out.push(Pt::new(x, y));
        }
    }
    out.push(ctrl[n - 1]);
    out
}

// ---------------------------------------------------------------------------
// Glyph builders. Coordinates are original, authored by hand in em units:
// x advances rightward from 0; baseline y = 0; x-height ~ 1.0.
// ---------------------------------------------------------------------------

fn s(pts: &[(f32, f32)]) -> Stroke {
    Stroke {
        pts: pts.iter().map(|&(x, y)| Pt::new(x, y)).collect(),
    }
}

/// A full/partial ellipse sampled into points (bowls of o,a,c,d,e,g,q...).
fn ell(cx: f32, cy: f32, rx: f32, ry: f32, a0: f32, a1: f32, n: usize) -> Stroke {
    let mut v = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let t = a0 + (a1 - a0) * (i as f32 / n as f32);
        v.push(Pt::new(cx + rx * t.cos(), cy + ry * t.sin()));
    }
    Stroke { pts: v }
}

fn lower(c: char) -> Option<Glyph> {
    let g = match c {
        ' ' => Glyph { strokes: vec![], advance: 0.55, entry_y: 0.0, exit_y: 0.0, connects: false },

        'a' => Glyph {
            strokes: vec![
                ell(0.30, 0.45, 0.26, 0.45, 0.35, 2.0 * PI + 0.35, 30),
                s(&[(0.56, 0.90), (0.56, 0.10), (0.70, 0.0), (0.88, 0.18)]),
            ],
            advance: 0.94, entry_y: 0.58, exit_y: 0.18, connects: true,
        },
        'b' => Glyph {
            strokes: vec![s(&[
                (0.10, 0.22), (0.20, 1.20), (0.24, ASCENDER), (0.24, 0.08),
                (0.42, 0.0), (0.62, 0.14), (0.66, 0.40), (0.50, 0.58),
                (0.26, 0.52), (0.48, 0.56), (0.64, 0.52), (0.80, 0.60),
            ])],
            advance: 0.88, entry_y: 0.22, exit_y: 0.54, connects: true,
        },
        'c' => Glyph {
            strokes: vec![s(&[
                (0.60, 0.74), (0.40, 0.96), (0.16, 0.80), (0.10, 0.44),
                (0.28, 0.06), (0.52, 0.04), (0.64, 0.16),
            ])],
            advance: 0.78, entry_y: 0.6, exit_y: 0.14, connects: true,
        },
        'd' => Glyph {
            strokes: vec![
                ell(0.30, 0.45, 0.24, 0.45, 0.4, 2.0 * PI + 0.4, 30),
                s(&[(0.54, ASCENDER), (0.54, 0.10), (0.68, 0.0), (0.86, 0.18)]),
            ],
            advance: 0.90, entry_y: 0.5, exit_y: 0.18, connects: true,
        },
        'e' => Glyph {
            strokes: vec![s(&[
                (0.10, 0.44), (0.56, 0.46), (0.52, 0.78), (0.28, 0.94),
                (0.10, 0.66), (0.18, 0.28), (0.44, 0.04), (0.64, 0.16),
            ])],
            advance: 0.80, entry_y: 0.45, exit_y: 0.16, connects: true,
        },
        'f' => Glyph {
            strokes: vec![
                s(&[(0.50, 1.52), (0.34, 1.70), (0.26, 1.10), (0.24, 0.0),
                    (0.18, DESCENDER), (0.02, -0.52)]),
                s(&[(0.04, 0.96), (0.52, 0.96)]),
            ],
            advance: 0.58, entry_y: 0.5, exit_y: 0.0, connects: false,
        },
        'g' => Glyph {
            strokes: vec![
                ell(0.30, 0.45, 0.24, 0.45, 0.4, 2.0 * PI + 0.4, 30),
                s(&[(0.54, 0.90), (0.54, 0.0), (0.50, DESCENDER), (0.30, -0.60), (0.10, -0.40)]),
            ],
            advance: 0.88, entry_y: 0.5, exit_y: 0.1, connects: false,
        },
        'h' => Glyph {
            strokes: vec![s(&[
                (0.10, 0.22), (0.20, 1.20), (0.24, ASCENDER), (0.24, 0.04),
                (0.28, 0.50), (0.46, 0.90), (0.62, 0.72), (0.62, 0.04),
                (0.78, 0.0), (0.90, 0.18),
            ])],
            advance: 1.00, entry_y: 0.22, exit_y: 0.18, connects: true,
        },
        'i' => Glyph {
            strokes: vec![
                s(&[(0.08, 0.50), (0.22, 0.90), (0.28, 0.10), (0.44, 0.02), (0.60, 0.20)]),
                s(&[(0.29, 1.24), (0.34, 1.28), (0.31, 1.34), (0.26, 1.30)]),
            ],
            advance: 0.60, entry_y: 0.5, exit_y: 0.20, connects: true,
        },
        'j' => Glyph {
            strokes: vec![
                s(&[(0.30, 0.90), (0.30, 0.0), (0.26, DESCENDER), (0.10, -0.60), (-0.04, -0.40)]),
                s(&[(0.32, 1.24), (0.37, 1.28), (0.34, 1.34), (0.29, 1.30)]),
            ],
            advance: 0.56, entry_y: 0.5, exit_y: 0.1, connects: false,
        },
        'k' => Glyph {
            strokes: vec![
                s(&[(0.10, 0.22), (0.20, 1.20), (0.24, ASCENDER), (0.24, 0.02)]),
                s(&[(0.64, 0.82), (0.26, 0.42), (0.44, 0.30), (0.68, 0.02), (0.84, 0.20)]),
            ],
            advance: 0.88, entry_y: 0.22, exit_y: 0.20, connects: true,
        },
        'l' => Glyph {
            strokes: vec![s(&[
                (0.10, 0.30), (0.22, 1.20), (0.30, ASCENDER), (0.30, 0.10),
                (0.44, 0.0), (0.62, 0.20),
            ])],
            advance: 0.66, entry_y: 0.30, exit_y: 0.20, connects: true,
        },
        'm' => Glyph {
            strokes: vec![s(&[
                (0.06, 0.50), (0.10, 0.92), (0.12, 0.06), (0.14, 0.50),
                (0.30, 0.90), (0.44, 0.72), (0.44, 0.06), (0.46, 0.50),
                (0.62, 0.90), (0.76, 0.72), (0.76, 0.04), (0.90, 0.0), (1.02, 0.18),
            ])],
            advance: 1.12, entry_y: 0.50, exit_y: 0.18, connects: true,
        },
        'n' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.50), (0.12, 0.92), (0.14, 0.06), (0.16, 0.50),
                (0.34, 0.90), (0.50, 0.72), (0.50, 0.04), (0.66, 0.0), (0.78, 0.18),
            ])],
            advance: 0.86, entry_y: 0.50, exit_y: 0.18, connects: true,
        },
        'o' => Glyph {
            strokes: vec![
                ell(0.32, 0.50, 0.28, 0.50, 0.55, 2.0 * PI + 0.55, 32),
                s(&[(0.56, 0.62), (0.72, 0.56), (0.86, 0.62)]),
            ],
            advance: 0.86, entry_y: 0.55, exit_y: 0.60, connects: true,
        },
        'p' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.50), (0.14, 0.92), (0.16, DESCENDER), (0.16, 0.55),
                (0.34, 0.95), (0.52, 0.88), (0.62, 0.55), (0.52, 0.20),
                (0.32, 0.10), (0.16, 0.18),
            ])],
            advance: 0.88, entry_y: 0.50, exit_y: 0.20, connects: false,
        },
        'q' => Glyph {
            strokes: vec![
                ell(0.30, 0.50, 0.26, 0.50, 0.5, 2.0 * PI + 0.5, 30),
                s(&[(0.56, 0.95), (0.56, DESCENDER), (0.66, -0.56), (0.82, -0.42)]),
            ],
            advance: 0.90, entry_y: 0.5, exit_y: 0.1, connects: false,
        },
        'r' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.50), (0.12, 0.90), (0.16, 0.04), (0.18, 0.50),
                (0.36, 0.86), (0.54, 0.80), (0.68, 0.90),
            ])],
            advance: 0.70, entry_y: 0.50, exit_y: 0.88, connects: true,
        },
        's' => Glyph {
            strokes: vec![s(&[
                (0.58, 0.82), (0.36, 0.96), (0.14, 0.82), (0.28, 0.56),
                (0.48, 0.46), (0.42, 0.20), (0.20, 0.06), (0.06, 0.22),
            ])],
            advance: 0.64, entry_y: 0.70, exit_y: 0.20, connects: true,
        },
        't' => Glyph {
            strokes: vec![
                s(&[(0.30, 1.40), (0.28, 0.12), (0.42, 0.0), (0.58, 0.20)]),
                s(&[(0.06, 1.00), (0.52, 1.00)]),
            ],
            advance: 0.60, entry_y: 0.55, exit_y: 0.20, connects: true,
        },
        'u' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.90), (0.10, 0.20), (0.26, 0.02), (0.42, 0.14),
                (0.46, 0.90), (0.46, 0.12), (0.62, 0.0), (0.80, 0.20),
            ])],
            advance: 0.88, entry_y: 0.88, exit_y: 0.20, connects: true,
        },
        'v' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.86), (0.12, 0.90), (0.34, 0.04), (0.56, 0.90),
                (0.62, 0.60), (0.78, 0.68),
            ])],
            advance: 0.82, entry_y: 0.86, exit_y: 0.62, connects: true,
        },
        'w' => Glyph {
            strokes: vec![s(&[
                (0.06, 0.90), (0.24, 0.04), (0.40, 0.80), (0.56, 0.04),
                (0.72, 0.90), (0.78, 0.60), (0.94, 0.68),
            ])],
            advance: 1.00, entry_y: 0.90, exit_y: 0.62, connects: true,
        },
        'x' => Glyph {
            strokes: vec![
                s(&[(0.08, 0.84), (0.54, 0.04)]),
                s(&[(0.10, 0.04), (0.56, 0.84)]),
            ],
            advance: 0.66, entry_y: 0.84, exit_y: 0.10, connects: true,
        },
        'y' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.90), (0.10, 0.20), (0.26, 0.02), (0.42, 0.14),
                (0.48, 0.90), (0.46, -0.10), (0.34, DESCENDER), (0.16, -0.58), (0.02, -0.38),
            ])],
            advance: 0.82, entry_y: 0.88, exit_y: 0.1, connects: false,
        },
        'z' => Glyph {
            strokes: vec![s(&[
                (0.08, 0.82), (0.56, 0.86), (0.14, 0.08), (0.62, 0.08),
                (0.56, -0.16), (0.40, -0.26),
            ])],
            advance: 0.72, entry_y: 0.82, exit_y: 0.10, connects: true,
        },

        '.' => Glyph { strokes: vec![s(&[(0.08, 0.10), (0.13, 0.13), (0.11, 0.18), (0.06, 0.15)])],
            advance: 0.32, entry_y: 0.1, exit_y: 0.1, connects: false },
        ',' => Glyph { strokes: vec![s(&[(0.13, 0.14), (0.14, 0.02), (0.05, -0.16)])],
            advance: 0.32, entry_y: 0.1, exit_y: 0.1, connects: false },
        ';' => Glyph { strokes: vec![
            s(&[(0.10, 0.55), (0.14, 0.58), (0.12, 0.63), (0.08, 0.60)]),
            s(&[(0.13, 0.14), (0.14, 0.02), (0.05, -0.16)])],
            advance: 0.34, entry_y: 0.1, exit_y: 0.1, connects: false },
        ':' => Glyph { strokes: vec![
            s(&[(0.10, 0.55), (0.14, 0.58), (0.12, 0.63), (0.08, 0.60)]),
            s(&[(0.08, 0.10), (0.13, 0.13), (0.11, 0.18), (0.06, 0.15)])],
            advance: 0.34, entry_y: 0.1, exit_y: 0.1, connects: false },
        '\'' => Glyph { strokes: vec![s(&[(0.10, ASCENDER), (0.07, 1.30)])],
            advance: 0.28, entry_y: 0.8, exit_y: 0.8, connects: false },
        '"' => Glyph { strokes: vec![
            s(&[(0.08, ASCENDER), (0.05, 1.30)]), s(&[(0.22, ASCENDER), (0.19, 1.30)])],
            advance: 0.40, entry_y: 0.8, exit_y: 0.8, connects: false },
        '!' => Glyph { strokes: vec![
            s(&[(0.12, CAP), (0.09, 0.30)]),
            s(&[(0.07, 0.10), (0.12, 0.13), (0.10, 0.18), (0.05, 0.15)])],
            advance: 0.34, entry_y: 0.5, exit_y: 0.3, connects: false },
        '?' => Glyph { strokes: vec![
            s(&[(0.06, 1.28), (0.20, CAP), (0.42, 1.52), (0.44, 1.18),
                (0.26, 0.90), (0.24, 0.42)]),
            s(&[(0.22, 0.10), (0.27, 0.13), (0.25, 0.18), (0.20, 0.15)])],
            advance: 0.60, entry_y: 0.5, exit_y: 0.3, connects: false },
        '-' => Glyph { strokes: vec![s(&[(0.06, 0.48), (0.52, 0.48)])],
            advance: 0.60, entry_y: 0.48, exit_y: 0.48, connects: false },
        _ => return None,
    };
    Some(g)
}

/// Print-style capitals (cap height = CAP). These do not join cursively.
fn upper(c: char) -> Option<Glyph> {
    let bowl = |cx: f32, cy: f32, rx: f32, ry: f32| ell(cx, cy, rx, ry, 0.0, 2.0 * PI, 36);
    let g = match c {
        'A' => Glyph { strokes: vec![
            s(&[(0.04, 0.0), (0.55, CAP), (1.06, 0.0)]),
            s(&[(0.24, 0.70), (0.86, 0.70)])],
            advance: 1.22, entry_y: 0.0, exit_y: 0.0, connects: false },
        'B' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]),
            s(&[(0.12, CAP), (0.60, 1.68), (0.74, 1.36), (0.56, 1.00), (0.12, 0.94)]),
            s(&[(0.12, 0.94), (0.68, 0.90), (0.84, 0.48), (0.60, 0.04), (0.12, 0.0)])],
            advance: 0.98, entry_y: 0.0, exit_y: 0.0, connects: false },
        'C' => Glyph { strokes: vec![s(&[
            (0.98, 1.34), (0.70, 1.70), (0.30, 1.52), (0.10, 0.86),
            (0.30, 0.18), (0.70, 0.02), (0.98, 0.38)])],
            advance: 1.14, entry_y: 0.0, exit_y: 0.0, connects: false },
        'D' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]),
            s(&[(0.12, CAP), (0.62, 1.68), (0.98, 1.10), (0.98, 0.62),
                (0.62, 0.04), (0.12, 0.0)])],
            advance: 1.12, entry_y: 0.0, exit_y: 0.0, connects: false },
        'E' => Glyph { strokes: vec![
            s(&[(0.84, 1.70), (0.14, 1.70), (0.14, 0.0), (0.84, 0.0)]),
            s(&[(0.14, 0.88), (0.66, 0.88)])],
            advance: 0.96, entry_y: 0.0, exit_y: 0.0, connects: false },
        'F' => Glyph { strokes: vec![
            s(&[(0.84, 1.70), (0.14, 1.70), (0.14, 0.0)]),
            s(&[(0.14, 0.88), (0.64, 0.88)])],
            advance: 0.90, entry_y: 0.0, exit_y: 0.0, connects: false },
        'G' => Glyph { strokes: vec![s(&[
            (0.98, 1.34), (0.70, 1.70), (0.30, 1.52), (0.10, 0.86),
            (0.30, 0.18), (0.72, 0.02), (0.98, 0.34), (0.98, 0.56), (0.62, 0.56)])],
            advance: 1.16, entry_y: 0.0, exit_y: 0.0, connects: false },
        'H' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]), s(&[(0.92, 0.0), (0.92, CAP)]),
            s(&[(0.12, 0.88), (0.92, 0.88)])],
            advance: 1.10, entry_y: 0.0, exit_y: 0.0, connects: false },
        'I' => Glyph { strokes: vec![
            s(&[(0.30, 0.0), (0.30, CAP)]),
            s(&[(0.10, 1.70), (0.50, 1.70)]), s(&[(0.10, 0.0), (0.50, 0.0)])],
            advance: 0.60, entry_y: 0.0, exit_y: 0.0, connects: false },
        'J' => Glyph { strokes: vec![s(&[
            (0.62, CAP), (0.62, 0.40), (0.46, 0.04), (0.22, 0.06), (0.08, 0.36)])],
            advance: 0.78, entry_y: 0.0, exit_y: 0.0, connects: false },
        'K' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]),
            s(&[(0.88, CAP), (0.12, 0.74)]), s(&[(0.36, 0.92), (0.92, 0.0)])],
            advance: 1.04, entry_y: 0.0, exit_y: 0.0, connects: false },
        'L' => Glyph { strokes: vec![s(&[(0.14, CAP), (0.14, 0.0), (0.84, 0.0)])],
            advance: 0.90, entry_y: 0.0, exit_y: 0.0, connects: false },
        'M' => Glyph { strokes: vec![s(&[
            (0.06, 0.0), (0.08, CAP), (0.55, 0.50), (1.02, CAP), (1.04, 0.0)])],
            advance: 1.30, entry_y: 0.0, exit_y: 0.0, connects: false },
        'N' => Glyph { strokes: vec![s(&[
            (0.10, 0.0), (0.10, CAP), (0.92, 0.04), (0.92, CAP)])],
            advance: 1.10, entry_y: 0.0, exit_y: 0.0, connects: false },
        'O' => Glyph { strokes: vec![bowl(0.56, 0.86, 0.50, 0.86)],
            advance: 1.24, entry_y: 0.0, exit_y: 0.0, connects: false },
        'P' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]),
            s(&[(0.12, CAP), (0.66, 1.68), (0.80, 1.30), (0.60, 0.96), (0.12, 0.92)])],
            advance: 0.96, entry_y: 0.0, exit_y: 0.0, connects: false },
        'Q' => Glyph { strokes: vec![
            bowl(0.56, 0.86, 0.50, 0.86),
            s(&[(0.64, 0.50), (1.08, -0.12)])],
            advance: 1.24, entry_y: 0.0, exit_y: 0.0, connects: false },
        'R' => Glyph { strokes: vec![
            s(&[(0.12, 0.0), (0.12, CAP)]),
            s(&[(0.12, CAP), (0.66, 1.68), (0.80, 1.30), (0.60, 0.96), (0.12, 0.92)]),
            s(&[(0.48, 0.92), (0.92, 0.0)])],
            advance: 1.02, entry_y: 0.0, exit_y: 0.0, connects: false },
        'S' => Glyph { strokes: vec![s(&[
            (0.82, 1.48), (0.52, 1.72), (0.20, 1.52), (0.30, 1.12),
            (0.58, 0.92), (0.78, 0.58), (0.60, 0.16), (0.28, 0.02), (0.08, 0.28)])],
            advance: 0.94, entry_y: 0.0, exit_y: 0.0, connects: false },
        'T' => Glyph { strokes: vec![
            s(&[(0.06, 1.70), (0.94, 1.70)]), s(&[(0.50, 1.70), (0.50, 0.0)])],
            advance: 1.00, entry_y: 0.0, exit_y: 0.0, connects: false },
        'U' => Glyph { strokes: vec![s(&[
            (0.10, CAP), (0.10, 0.40), (0.34, 0.04), (0.66, 0.04), (0.90, 0.40), (0.90, CAP)])],
            advance: 1.10, entry_y: 0.0, exit_y: 0.0, connects: false },
        'V' => Glyph { strokes: vec![s(&[(0.04, CAP), (0.50, 0.0), (0.96, CAP)])],
            advance: 1.04, entry_y: 0.0, exit_y: 0.0, connects: false },
        'W' => Glyph { strokes: vec![s(&[
            (0.04, CAP), (0.28, 0.0), (0.52, 1.14), (0.76, 0.0), (1.00, CAP)])],
            advance: 1.28, entry_y: 0.0, exit_y: 0.0, connects: false },
        'X' => Glyph { strokes: vec![
            s(&[(0.06, CAP), (0.92, 0.0)]), s(&[(0.06, 0.0), (0.92, CAP)])],
            advance: 1.02, entry_y: 0.0, exit_y: 0.0, connects: false },
        'Y' => Glyph { strokes: vec![
            s(&[(0.06, CAP), (0.50, 0.86), (0.94, CAP)]), s(&[(0.50, 0.86), (0.50, 0.0)])],
            advance: 1.04, entry_y: 0.0, exit_y: 0.0, connects: false },
        'Z' => Glyph { strokes: vec![s(&[
            (0.08, 1.70), (0.86, 1.70), (0.10, 0.02), (0.90, 0.02)])],
            advance: 1.00, entry_y: 0.0, exit_y: 0.0, connects: false },
        _ => return None,
    };
    Some(g)
}

/// Digits, print style on the cap grid.
fn digit(c: char) -> Option<Glyph> {
    let g = match c {
        '0' => Glyph { strokes: vec![ell(0.42, 0.86, 0.34, 0.86, 0.0, 2.0 * PI, 34)],
            advance: 0.92, entry_y: 0.0, exit_y: 0.0, connects: false },
        '1' => Glyph { strokes: vec![s(&[(0.14, 1.36), (0.42, CAP), (0.42, 0.0)]),
            s(&[(0.16, 0.0), (0.68, 0.0)])],
            advance: 0.74, entry_y: 0.0, exit_y: 0.0, connects: false },
        '2' => Glyph { strokes: vec![s(&[
            (0.10, 1.34), (0.34, CAP), (0.68, 1.56), (0.60, 1.06),
            (0.12, 0.44), (0.08, 0.0), (0.74, 0.0)])],
            advance: 0.84, entry_y: 0.0, exit_y: 0.0, connects: false },
        '3' => Glyph { strokes: vec![s(&[
            (0.10, 1.48), (0.42, CAP), (0.70, 1.44), (0.40, 0.98),
            (0.72, 0.60), (0.48, 0.04), (0.12, 0.20)])],
            advance: 0.84, entry_y: 0.0, exit_y: 0.0, connects: false },
        '4' => Glyph { strokes: vec![s(&[(0.58, 0.0), (0.58, CAP), (0.08, 0.52), (0.80, 0.52)])],
            advance: 0.88, entry_y: 0.0, exit_y: 0.0, connects: false },
        '5' => Glyph { strokes: vec![s(&[
            (0.70, CAP), (0.18, CAP), (0.14, 0.96), (0.46, 1.04),
            (0.72, 0.66), (0.50, 0.04), (0.12, 0.18)])],
            advance: 0.84, entry_y: 0.0, exit_y: 0.0, connects: false },
        '6' => Glyph { strokes: vec![s(&[
            (0.66, 1.60), (0.34, CAP), (0.12, 1.10), (0.10, 0.40),
            (0.34, 0.02), (0.64, 0.14), (0.70, 0.46), (0.48, 0.70), (0.14, 0.58)])],
            advance: 0.86, entry_y: 0.0, exit_y: 0.0, connects: false },
        '7' => Glyph { strokes: vec![s(&[(0.08, CAP), (0.80, CAP), (0.36, 0.0)])],
            advance: 0.84, entry_y: 0.0, exit_y: 0.0, connects: false },
        '8' => Glyph { strokes: vec![
            ell(0.42, 1.28, 0.30, 0.44, 0.0, 2.0 * PI, 26),
            ell(0.42, 0.42, 0.36, 0.44, 0.0, 2.0 * PI, 26)],
            advance: 0.88, entry_y: 0.0, exit_y: 0.0, connects: false },
        '9' => Glyph { strokes: vec![s(&[
            (0.66, 1.26), (0.40, 1.70), (0.14, 1.46), (0.18, 1.08),
            (0.50, 0.96), (0.70, 1.30), (0.66, 0.60), (0.40, 0.04), (0.14, 0.14)])],
            advance: 0.86, entry_y: 0.0, exit_y: 0.0, connects: false },
        _ => return None,
    };
    Some(g)
}

/// Original flowing cursive capitals (used for signatures / cursive-caps mode).
/// Mostly single-stroke forms that connect into the following letter.
fn upper_cursive(c: char) -> Option<Glyph> {
    let h = ASCENDER;
    let g = match c {
        'A' => Glyph { strokes: vec![s(&[
            (0.05, 0.10), (0.33, 1.55), (0.45, h), (0.50, 0.12),
            (0.30, 0.44), (0.52, 0.40), (0.74, 0.12), (0.92, 0.30)])],
            advance: 1.00, entry_y: 0.10, exit_y: 0.30, connects: true },
        'B' => Glyph { strokes: vec![s(&[
            (0.16, 0.06), (0.12, 1.3), (0.22, h), (0.52, 1.62), (0.40, 1.22),
            (0.22, 1.0), (0.60, 0.86), (0.68, 0.48), (0.42, 0.08), (0.16, 0.14),
            (0.5, 0.10), (0.74, 0.24)])],
            advance: 0.92, entry_y: 0.06, exit_y: 0.24, connects: true },
        'C' => Glyph { strokes: vec![s(&[
            (0.60, 1.30), (0.78, 1.60), (0.52, 1.64), (0.24, 1.42),
            (0.12, 0.80), (0.32, 0.14), (0.66, 0.08), (0.88, 0.32)])],
            advance: 0.92, entry_y: 0.6, exit_y: 0.14, connects: true },
        'D' => Glyph { strokes: vec![s(&[
            (0.14, 0.06), (0.10, 1.3), (0.2, h), (0.3, 1.5), (0.22, 0.1),
            (0.5, 0.06), (0.86, 0.5), (0.86, 1.02), (0.5, 1.5), (0.26, 1.46),
            (0.5, 0.10), (0.74, 0.24)])],
            advance: 1.0, entry_y: 0.06, exit_y: 0.24, connects: true },
        'E' => Glyph { strokes: vec![s(&[
            (0.80, 1.5), (0.5, 1.62), (0.22, 1.42), (0.40, 1.16), (0.18, 0.94),
            (0.44, 0.84), (0.16, 0.5), (0.3, 0.12), (0.66, 0.06), (0.86, 0.3)])],
            advance: 0.9, entry_y: 0.5, exit_y: 0.14, connects: true },
        'F' => Glyph { strokes: vec![
            s(&[(0.84, 1.55), (0.42, 1.62), (0.30, 1.2), (0.26, 0.0), (0.08, 0.38)]),
            s(&[(0.08, 1.0), (0.62, 0.98)])],
            advance: 0.78, entry_y: 0.5, exit_y: 0.0, connects: false },
        'G' => Glyph { strokes: vec![s(&[
            (0.88, 1.38), (0.56, 1.62), (0.24, 1.42), (0.14, 0.8), (0.34, 0.14),
            (0.66, 0.08), (0.84, 0.36), (0.80, 0.62), (0.52, 0.60)])],
            advance: 0.98, entry_y: 0.6, exit_y: 0.6, connects: true },
        'H' => Glyph { strokes: vec![
            s(&[(0.06, 0.06), (0.18, 1.5), (0.30, h), (0.22, 0.08), (0.26, 0.82),
                (0.64, 0.92), (0.70, 1.5), (0.80, h), (0.68, 0.06), (0.86, 0.24)])],
            advance: 1.0, entry_y: 0.06, exit_y: 0.24, connects: true },
        'I' => Glyph { strokes: vec![s(&[
            (0.52, h), (0.30, 1.52), (0.46, 1.0), (0.34, 0.2),
            (0.5, 0.06), (0.18, 0.1), (0.46, 0.22)])],
            advance: 0.6, entry_y: 0.4, exit_y: 0.22, connects: true },
        'J' => Glyph { strokes: vec![s(&[
            (0.66, h), (0.42, 1.52), (0.58, 1.0), (0.52, 0.0),
            (0.36, DESCENDER), (0.14, -0.5), (0.0, -0.2)])],
            advance: 0.62, entry_y: 0.5, exit_y: 0.1, connects: false },
        'K' => Glyph { strokes: vec![
            s(&[(0.08, 0.08), (0.2, 1.5), (0.32, h), (0.24, 0.06)]),
            s(&[(0.76, 1.5), (0.30, 0.68), (0.5, 0.58), (0.70, 0.06), (0.88, 0.26)])],
            advance: 0.92, entry_y: 0.08, exit_y: 0.26, connects: true },
        'L' => Glyph { strokes: vec![s(&[
            (0.56, 1.5), (0.26, 1.34), (0.38, 0.92), (0.22, 0.1), (0.14, 0.4),
            (0.30, 0.16), (0.56, 0.06), (0.86, 0.16)])],
            advance: 0.88, entry_y: 0.5, exit_y: 0.16, connects: true },
        'M' => Glyph { strokes: vec![s(&[
            (0.04, 0.06), (0.04, 0.9), (0.12, 1.55), (0.20, h), (0.20, 0.1),
            (0.38, 1.3), (0.5, 1.34), (0.50, 0.12), (0.60, 1.3), (0.74, 1.5),
            (0.82, h), (0.80, 0.06), (0.94, 0.22)])],
            advance: 1.1, entry_y: 0.06, exit_y: 0.22, connects: true },
        'N' => Glyph { strokes: vec![s(&[
            (0.04, 0.06), (0.06, 1.5), (0.16, h), (0.18, 0.12), (0.62, 1.4),
            (0.72, 1.5), (0.74, 0.1), (0.80, 1.4), (0.94, 1.4)])],
            advance: 1.02, entry_y: 0.06, exit_y: 1.4, connects: false },
        'O' => Glyph { strokes: vec![s(&[
            (0.64, 1.56), (0.34, 1.52), (0.14, 1.04), (0.2, 0.34), (0.5, 0.05),
            (0.82, 0.34), (0.88, 1.0), (0.64, 1.46), (0.42, 1.5), (0.56, 1.22)])],
            advance: 1.0, entry_y: 0.5, exit_y: 1.2, connects: false },
        'P' => Glyph { strokes: vec![s(&[
            (0.08, 0.06), (0.18, 1.5), (0.28, h), (0.24, 0.08), (0.28, 1.3),
            (0.66, 1.4), (0.76, 1.04), (0.4, 0.84), (0.2, 0.9)])],
            advance: 0.88, entry_y: 0.06, exit_y: 0.9, connects: false },
        'Q' => Glyph { strokes: vec![
            s(&[(0.64, 1.56), (0.34, 1.52), (0.14, 1.04), (0.2, 0.34), (0.5, 0.05),
                (0.82, 0.34), (0.86, 1.0), (0.6, 1.46), (0.4, 1.5)]),
            s(&[(0.56, 0.42), (0.9, 0.0), (1.02, 0.22)])],
            advance: 1.02, entry_y: 0.5, exit_y: 0.2, connects: true },
        'R' => Glyph { strokes: vec![s(&[
            (0.08, 0.06), (0.18, 1.5), (0.28, h), (0.24, 0.08), (0.28, 1.3),
            (0.66, 1.4), (0.74, 1.06), (0.38, 0.86), (0.26, 0.86),
            (0.56, 0.6), (0.80, 0.1), (0.96, 0.28)])],
            advance: 0.96, entry_y: 0.06, exit_y: 0.28, connects: true },
        'S' => Glyph { strokes: vec![s(&[
            (0.76, 1.3), (0.58, 1.6), (0.3, 1.58), (0.22, 1.26), (0.5, 1.0),
            (0.62, 0.58), (0.56, 0.18), (0.3, 0.04), (0.1, 0.2), (0.16, 0.44)])],
            advance: 0.8, entry_y: 0.6, exit_y: 0.4, connects: true },
        'T' => Glyph { strokes: vec![
            s(&[(0.2, 1.46), (0.42, 1.6), (0.62, 1.52), (0.84, 1.6)]),
            s(&[(0.52, 1.56), (0.42, 0.3), (0.3, 0.04), (0.12, 0.18)])],
            advance: 0.86, entry_y: 0.6, exit_y: 0.2, connects: true },
        'U' => Glyph { strokes: vec![s(&[
            (0.06, 1.5), (0.1, 0.4), (0.3, 0.04), (0.5, 0.18), (0.56, 1.5),
            (0.56, 0.12), (0.72, 0.0), (0.9, 0.2)])],
            advance: 0.94, entry_y: 1.5, exit_y: 0.2, connects: true },
        'V' => Glyph { strokes: vec![s(&[
            (0.04, 1.44), (0.1, 1.56), (0.44, 0.06), (0.74, 1.5),
            (0.8, 1.56), (0.78, 1.3)])],
            advance: 0.86, entry_y: 1.44, exit_y: 1.3, connects: false },
        'W' => Glyph { strokes: vec![s(&[
            (0.04, 1.5), (0.2, 0.06), (0.36, 1.26), (0.52, 0.06),
            (0.68, 1.26), (0.84, 0.06), (0.98, 1.5)])],
            advance: 1.08, entry_y: 1.5, exit_y: 1.5, connects: false },
        'X' => Glyph { strokes: vec![
            s(&[(0.08, 1.46), (0.18, 1.56), (0.84, 0.06)]),
            s(&[(0.82, 1.5), (0.14, 0.06), (0.02, 0.2)])],
            advance: 0.92, entry_y: 1.46, exit_y: 0.1, connects: false },
        'Y' => Glyph { strokes: vec![s(&[
            (0.08, 1.48), (0.12, 1.56), (0.46, 0.72), (0.52, 1.5), (0.5, 0.0),
            (0.36, DESCENDER), (0.14, -0.5), (0.02, -0.18)])],
            advance: 0.86, entry_y: 1.48, exit_y: 0.1, connects: false },
        'Z' => Glyph { strokes: vec![s(&[
            (0.1, 1.38), (0.3, 1.6), (0.6, 1.5), (0.2, 0.1), (0.52, 0.16),
            (0.48, DESCENDER), (0.3, -0.42), (0.14, -0.3)])],
            advance: 0.78, entry_y: 0.6, exit_y: 0.1, connects: false },
        _ => return None,
    };
    Some(g)
}

fn glyph_any(c: char, cursive_caps: bool) -> Option<Glyph> {
    lower(c)
        .or_else(|| if cursive_caps { upper_cursive(c) } else { None })
        .or_else(|| upper(c))
        .or_else(|| digit(c))
}

// ---------------------------------------------------------------------------
// Rendering parameters coming from JS.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Params {
    width: f32,
    height: f32,
    font_px: f32,
    slant_deg: f32,
    variation: f32,
    weight: f32,
    contrast: f32,
    spacing: f32,
    line_spacing: f32,
    align: f32,   // 0 = left, 0.5 = centre, 1.0 = right
    tilt: f32,    // per-letter random rotation amount (0..1)
    vary: f32,    // per-letter size/shape variation (0..1)
    inkflow: f32, // along-stroke pressure modulation (0..1)
    natural: f32, // per-word baseline / start drift (0..1)
    caps_cursive: bool, // use flowing cursive capitals
    seed: u64,
}

struct RibbonStroke {
    pts: Vec<Pt>,
    line: u32,
}

fn build_strokes(text: &str, p: &Params) -> (Vec<RibbonStroke>, f32, f32) {
    let margin = 0.6;
    let max_w_em = (p.width / p.font_px).max(4.0) - margin * 2.0;
    let line_h = p.line_spacing * 2.55;

    let mut out: Vec<RibbonStroke> = Vec::new();
    let mut pen_x = margin;
    let mut pen_y = margin + ASCENDER;
    let mut max_x = 0.0f32;
    let mut cur_line: u32 = 0;

    for raw_line in text.split('\n') {
        let words: Vec<&str> = raw_line.split(' ').collect();
        let mut first_word = true;

        for (wi, word) in words.iter().enumerate() {
            let mut w_adv = 0.0;
            for ch in word.chars() {
                if let Some(g) = glyph_any(ch, p.caps_cursive) {
                    w_adv += g.advance + p.spacing;
                }
            }
            if !first_word && pen_x + w_adv > margin + max_w_em {
                pen_x = margin;
                pen_y += line_h;
                cur_line += 1;
            }
            first_word = false;

            let mut prev_exit: Option<(f32, f32)> = None;
            let mut prev_connects = false;

            for ch in word.chars() {
                let g = match glyph_any(ch, p.caps_cursive) {
                    Some(g) => g,
                    None => continue,
                };
                let gx = pen_x;
                let vn = value_noise(p.seed ^ 0x51, gx * 3.1);
                let size_jitter = 1.0 + (p.variation * 0.05 + p.vary * 0.10) * vn;
                let base_off = p.variation * 0.045 * value_noise(p.seed ^ 0x99, gx * 2.3)
                    + p.natural * 0.12 * value_noise(p.seed ^ 0xA1, gx * 0.6);
                let tilt_ang = (p.tilt * 0.22 + p.vary * 0.05) * value_noise(p.seed ^ 0x77, gx * 4.7);
                let shape_jit = p.variation + p.vary * 0.6;

                if let (Some((px, py)), true) = (prev_exit, prev_connects && g.connects) {
                    let ex = gx;
                    let ey = g.entry_y;
                    // cursive valley: dip toward the baseline between letters
                    let dip = (py.min(ey) - 0.14).max(-0.05);
                    let conn = vec![
                        Pt::new(px, py),
                        Pt::new(px + (ex - px) * 0.35, dip + 0.05),
                        Pt::new(px + (ex - px) * 0.65, dip + 0.05),
                        Pt::new(ex, ey),
                    ];
                    let cxf = Xf { size: 1.0, base_off, rot: 0.0, pivot: 0.0 };
                    out.push(RibbonStroke {
                        pts: finalize(&catmull_rom(&conn, 8), gx, pen_y, &cxf, p.variation, p),
                        line: cur_line,
                    });
                }

                let xf = Xf { size: size_jitter, base_off, rot: tilt_ang, pivot: g.advance * 0.5 };
                for st in &g.strokes {
                    let dense = catmull_rom(&st.pts, 12);
                    out.push(RibbonStroke {
                        pts: finalize(&dense, gx, pen_y, &xf, shape_jit, p),
                        line: cur_line,
                    });
                }

                prev_exit = Some((gx + g.exit_x_hint(), g.exit_y));
                prev_connects = g.connects;
                pen_x += (g.advance + p.spacing) * size_jitter;
                max_x = max_x.max(pen_x);
            }

            if wi + 1 < words.len() {
                pen_x += 0.55 + p.spacing;
            }
        }
        pen_x = margin;
        pen_y += line_h;
        cur_line += 1;
    }

    // Horizontal alignment: shift each line by its free right-hand space.
    if p.align > 1e-3 {
        let content_right = margin + max_w_em;
        let max_line = out.iter().map(|r| r.line).max().unwrap_or(0);
        for ln in 0..=max_line {
            let mut line_max = f32::MIN;
            for r in &out {
                if r.line == ln {
                    for q in &r.pts {
                        line_max = line_max.max(q.x);
                    }
                }
            }
            if line_max <= f32::MIN {
                continue;
            }
            let shift = (content_right - line_max).max(0.0) * p.align;
            if shift > 0.0 {
                for r in &mut out {
                    if r.line == ln {
                        for q in &mut r.pts {
                            q.x += shift;
                        }
                    }
                }
            }
        }
    }

    let total_h = pen_y + (-DESCENDER) + margin - line_h + ASCENDER * 0.2;
    (out, max_x.max(pen_x) + margin, total_h.max(ASCENDER + 1.0))
}

/// Per-letter placement transform.
struct Xf {
    size: f32,
    base_off: f32,
    rot: f32,    // radians, rotation about the glyph's own centre
    pivot: f32,  // glyph-space x of the rotation pivot
}

/// Transform a glyph-space polyline into page em-space.
fn finalize(pts: &[Pt], ox: f32, baseline: f32, xf: &Xf, jitter: f32, p: &Params) -> Vec<Pt> {
    let slant = (p.slant_deg * PI / 180.0).tan();
    let (sr, cr) = xf.rot.sin_cos();
    let mut out = Vec::with_capacity(pts.len());
    for (i, q) in pts.iter().enumerate() {
        // per-letter rotation about (pivot, x-height/2)
        let rx = q.x - xf.pivot;
        let ry = q.y - 0.45;
        let mut x = (rx * cr - ry * sr + xf.pivot) * xf.size;
        let mut y = (rx * sr + ry * cr + 0.45) * xf.size;
        let t = i as f32 * 0.35 + ox * 5.0;
        x += jitter * 0.018 * value_noise(p.seed ^ 0x1234, t);
        y += jitter * 0.018 * value_noise(p.seed ^ 0x5678, t + 10.0);
        x += y * slant;
        let px = ox + x;
        let py = baseline - (y + xf.base_off);
        out.push(Pt::new(px, py));
    }
    out
}

// ---------------------------------------------------------------------------
// Variable-width ribbon -> SVG filled path.
// ---------------------------------------------------------------------------

fn stroke_to_path(rs: &RibbonStroke, p: &Params) -> String {
    let pts = &rs.pts;
    if pts.len() < 2 {
        return String::new();
    }
    let n = pts.len();
    let mut sp = Vec::with_capacity(n);
    for i in 0..n {
        let a = pts[i.saturating_sub(1)];
        let b = pts[(i + 1).min(n - 1)];
        sp.push(((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt());
    }
    let smax = sp.iter().cloned().fold(1e-4, f32::max);
    let mut widths = Vec::with_capacity(n);
    for i in 0..n {
        let fast = (sp[i] / smax).clamp(0.0, 1.0);
        let mut w = p.weight * (1.0 - p.contrast * 0.6 * fast);
        if p.inkflow > 0.0 {
            // slowly varying pen pressure along the stroke
            let press = 1.0 + p.inkflow * 0.40 * value_noise(p.seed ^ 0xBEEF, i as f32 * 0.25);
            // taper the very start and end, like a pen lifting on/off the page
            let edge = (i.min(n - 1 - i) as f32 / (n as f32 * 0.14).max(1.0)).clamp(0.0, 1.0);
            let taper = 1.0 - p.inkflow * 0.70 * (1.0 - edge);
            w *= press * taper;
        }
        widths.push(w.max(p.weight * 0.22));
    }
    let mut left = Vec::with_capacity(n);
    let mut right = Vec::with_capacity(n);
    for i in 0..n {
        let a = pts[i.saturating_sub(1)];
        let b = pts[(i + 1).min(n - 1)];
        let mut dx = b.x - a.x;
        let mut dy = b.y - a.y;
        let len = (dx * dx + dy * dy).sqrt().max(1e-5);
        dx /= len;
        dy /= len;
        let (nx, ny) = (-dy, dx);
        let hw = widths[i] * 0.5;
        left.push(Pt::new(pts[i].x + nx * hw, pts[i].y + ny * hw));
        right.push(Pt::new(pts[i].x - nx * hw, pts[i].y - ny * hw));
    }
    let mut d = String::with_capacity(n * 16);
    d.push_str(&format!("M{:.2} {:.2}", left[0].x, left[0].y));
    for q in &left[1..] {
        d.push_str(&format!("L{:.2} {:.2}", q.x, q.y));
    }
    for q in right.iter().rev() {
        d.push_str(&format!("L{:.2} {:.2}", q.x, q.y));
    }
    d.push('Z');
    d
}

fn render_svg(text: &str, p: &Params) -> String {
    let (strokes, _w_em, h_em) = build_strokes(text, p);
    let h_px = (h_em * p.font_px).max(p.font_px * 2.0).ceil();
    let mut body = String::new();
    for rs in &strokes {
        let scaled = RibbonStroke {
            pts: rs.pts.iter().map(|q| Pt::new(q.x * p.font_px, q.y * p.font_px)).collect(),
            line: rs.line,
        };
        let path = stroke_to_path(&scaled, p);
        if !path.is_empty() {
            body.push_str("<path d=\"");
            body.push_str(&path);
            body.push_str("\"/>");
        }
    }
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.0}\" height=\"{h:.0}\" \
         viewBox=\"0 0 {w:.0} {h:.0}\" fill=\"currentColor\" stroke=\"none\"><g>{body}</g></svg>",
        w = p.width,
        h = h_px,
        body = body
    )
}

// ---------------------------------------------------------------------------
// WASM C ABI. Strings cross the boundary via linear memory. The result buffer
// is a leaked boxed slice; its address/length are kept in scalar statics
// (no references to `static mut`, so the ABI stays warning-clean).
// ---------------------------------------------------------------------------

static mut RES_PTR: *const u8 = core::ptr::null();
static mut RES_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn alloc(size: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(size.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, size: usize) {
    unsafe {
        drop(Vec::from_raw_parts(ptr, 0, size.max(1)));
    }
}

#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn generate(
    text_ptr: *const u8,
    text_len: usize,
    width: f32,
    height: f32,
    font_px: f32,
    slant_deg: f32,
    variation: f32,
    weight: f32,
    contrast: f32,
    spacing: f32,
    line_spacing: f32,
    align: f32,
    tilt: f32,
    vary: f32,
    inkflow: f32,
    natural: f32,
    caps_cursive: f32,
    seed_lo: u32,
    seed_hi: u32,
) -> usize {
    let text = unsafe {
        let slice = std::slice::from_raw_parts(text_ptr, text_len);
        String::from_utf8_lossy(slice).into_owned()
    };
    let p = Params {
        width,
        height,
        font_px,
        slant_deg,
        variation,
        weight,
        contrast,
        spacing,
        line_spacing,
        align,
        tilt,
        vary,
        inkflow,
        natural,
        caps_cursive: caps_cursive > 0.5,
        seed: ((seed_hi as u64) << 32) | seed_lo as u64,
    };
    let bytes = render_svg(&text, &p).into_bytes().into_boxed_slice();
    let len = bytes.len();
    let ptr = Box::into_raw(bytes) as *const u8;
    unsafe {
        let old = RES_PTR;
        let old_len = RES_LEN;
        if !old.is_null() {
            drop(Box::from_raw(core::slice::from_raw_parts_mut(old as *mut u8, old_len)));
        }
        RES_PTR = ptr;
        RES_LEN = len;
    }
    len
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    unsafe { RES_PTR }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dp() -> Params {
        Params {
            width: 800.0, height: 300.0, font_px: 60.0, slant_deg: 8.0,
            variation: 0.5, weight: 3.5, contrast: 0.6, spacing: 0.04,
            line_spacing: 1.0, align: 0.0, tilt: 0.0, vary: 0.0,
            inkflow: 0.0, natural: 0.0, caps_cursive: false, seed: 42,
        }
    }
    #[test]
    fn renders_svg() {
        let svg = render_svg("hello world", &dp());
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("<path"));
        assert!(svg.ends_with("</svg>"));
    }
    #[test]
    fn empty_is_valid() {
        assert!(render_svg("", &dp()).starts_with("<svg"));
    }
    #[test]
    fn deterministic() {
        assert_eq!(render_svg("abc", &dp()), render_svg("abc", &dp()));
    }
    #[test]
    fn full_alphabet_has_glyphs() {
        for c in 'a'..='z' {
            assert!(lower(c).is_some(), "missing lower {c}");
        }
        for c in 'A'..='Z' {
            assert!(upper(c).is_some(), "missing upper {c}");
        }
        for c in '0'..='9' {
            assert!(digit(c).is_some(), "missing digit {c}");
        }
    }
}
