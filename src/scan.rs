// Scanned-page look, applied to an RGBA pixel buffer (row-major, 4 bytes per pixel).
//
// Runs inside a Web Worker (web/scan-worker.js), so the page never freezes. The order is the
// same as the original canvas pipeline in app.js (finishCanvas), so looks stay the same:
//   blur -> sharpen -> colour (gray / b&w) -> brightness -> contrast -> sepia
//        -> paper tint -> grain (Gaussian) + specks (salt & pepper)
// Tilt, vignette, blemishes and the border stay on the canvas (GPU) in the worker.
// The colour maths follows the CSS Filter Effects definitions, so the result matches what
// ctx.filter produced before.

use crate::Rng;

pub struct ScanOpts {
    pub blur: f32,     // Gaussian sigma in pixels (0 = off)
    pub sharp: f32,    // sharpen amount, same scale as the old JS (k = amount * 0.8)
    pub cspace: u32,   // 0 colour, 1 gray, 2 black & white (gray + strong contrast), 3 = 2 (bilevel is packed later)
    pub bright: f32,   // CSS brightness()
    pub contrast: f32, // CSS contrast()
    pub sepia: f32,    // CSS sepia() amount
    pub tint: f32,     // paper tint: multiply with warm paper at this opacity
    pub grain: f32,    // Gaussian grain, standard deviation in 0..255 levels
    pub specks: f32,   // salt & pepper density (fraction of pixels)
    pub seed: u64,
}

/// Apply the whole pixel pipeline in place.
pub fn process(px: &mut [u8], w: usize, h: usize, o: &ScanOpts) {
    if w == 0 || h == 0 || px.len() < w * h * 4 {
        return;
    }
    let opaque = px.chunks_exact(4).all(|p| p[3] == 255);
    if o.blur >= 0.35 {
        if !opaque { premultiply(px); }
        gaussian_blur(px, w, h, o.blur);
        if !opaque { unpremultiply(px); }
    }
    if o.sharp > 0.0 {
        sharpen(px, w, h, o.sharp * 0.8);
    }
    colour(px, o);
    if o.grain > 0.0 || o.specks > 0.0 {
        grain(px, o);
    }
}

// ---- colour ------------------------------------------------------------------------

#[inline]
fn clamp01(v: f32) -> f32 {
    if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }
}

fn colour(px: &mut [u8], o: &ScanOpts) {
    // Build one 3x3 matrix + offset per CSS step and apply them in order (clamping between
    // steps, as browsers do). Steps that are identities are skipped.
    let gray = o.cspace >= 1;
    let bw = o.cspace >= 2;
    let s = clamp01(o.sepia);
    let u = 1.0 - s;
    let sep = [
        [0.393 + 0.607 * u, 0.769 - 0.769 * u, 0.189 - 0.189 * u],
        [0.349 - 0.349 * u, 0.686 + 0.314 * u, 0.168 - 0.168 * u],
        [0.272 - 0.272 * u, 0.534 - 0.534 * u, 0.131 + 0.869 * u],
    ];
    let paper = [1.0f32, 244.0 / 255.0, 196.0 / 255.0];
    let t = clamp01(o.tint);
    let tint = [1.0 - t + t * paper[0], 1.0 - t + t * paper[1], 1.0 - t + t * paper[2]];
    let do_bc = (o.bright - 1.0).abs() > 1e-4 || (o.contrast - 1.0).abs() > 1e-4;
    let do_sep = s > 1e-4;
    let do_tint = t > 1e-4;
    if !gray && !do_bc && !do_sep && !do_tint {
        return;
    }
    // Fast paths: every step except sepia-on-colour works channel by channel, so the whole
    // chain collapses into per-channel 256-entry lookup tables (exactly the same results).
    let step = |v: f32, ch: usize, from_gray: bool| -> f32 {
        let mut x = v;
        if from_gray && bw { x = clamp01(clamp01((x - 0.5) * 2.2 + 0.5) * 1.05); }
        if do_bc { x = clamp01((clamp01(x * o.bright) - 0.5) * o.contrast + 0.5); }
        let _ = ch;
        x
    };
    if gray || !do_sep {
        let mut lut = [[0u8; 256]; 3];
        for v in 0..256 {
            let x = step(v as f32 / 255.0, 0, gray);
            for ch in 0..3 {
                let mut y = x;
                if do_sep {
                    // input is gray (r = g = b = x): the sepia row reduces to x * (row sum)
                    y = clamp01(x * (sep[ch][0] + sep[ch][1] + sep[ch][2]));
                }
                if do_tint { y *= tint[ch]; }
                lut[ch][v] = (y * 255.0 + 0.5) as u8;
            }
        }
        for p in px.chunks_exact_mut(4) {
            if p[3] == 0 { continue; }
            if gray {
                let l = ((0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) + 0.5) as usize;
                let l = l.min(255);
                p[0] = lut[0][l]; p[1] = lut[1][l]; p[2] = lut[2][l];
            } else {
                p[0] = lut[0][p[0] as usize]; p[1] = lut[1][p[1] as usize]; p[2] = lut[2][p[2] as usize];
            }
        }
        return;
    }
    // Colour + sepia: brightness/contrast as a lookup table, the sepia matrix in fixed point
    // (1/4096), then the paper tint as one more per-channel table. Clamped between steps.
    let mut bc = [0u8; 256];
    for v in 0..256 { bc[v] = (step(v as f32 / 255.0, 0, false) * 255.0 + 0.5) as u8; }
    let m: [[i32; 3]; 3] = core::array::from_fn(|i| core::array::from_fn(|j| (sep[i][j] * 4096.0).round() as i32));
    let mut tl = [[0u8; 256]; 3];
    for ch in 0..3 { for v in 0..256 { tl[ch][v] = if do_tint { (v as f32 * tint[ch] + 0.5) as u8 } else { v as u8 }; } }
    for p in px.chunks_exact_mut(4) {
        if p[3] == 0 { continue; }
        let (r, g, b) = (bc[p[0] as usize] as i32, bc[p[1] as usize] as i32, bc[p[2] as usize] as i32);
        for ch in 0..3 {
            let v = ((m[ch][0] * r + m[ch][1] * g + m[ch][2] * b + 2048) >> 12).clamp(0, 255) as usize;
            p[ch] = tl[ch][v];
        }
    }
}

// ---- grain -------------------------------------------------------------------------

fn grain(px: &mut [u8], o: &ScanOpts) {
    // A table of standard-normal samples (Box-Muller once), indexed by a fast RNG: realistic
    // sensor grain (like ImageMagick's Gaussian noise) without per-pixel ln/cos.
    const N: usize = 4096;
    let mut rng = Rng(o.seed ^ 0x5ca1_ab1e_d00d_f00d);
    let mut table = [0f32; N];
    let mut i = 0;
    while i < N {
        let u1 = rng.unit().max(1e-7);
        let u2 = rng.unit();
        let m = (-2.0 * u1.ln()).sqrt();
        table[i] = m * (2.0 * core::f32::consts::PI * u2).cos();
        if i + 1 < N { table[i + 1] = m * (2.0 * core::f32::consts::PI * u2).sin(); }
        i += 2;
    }
    let sd = o.grain;
    let delta: Vec<i32> = table.iter().map(|g| (g * sd).round() as i32).collect(); // pre-scaled, integer
    let speck = (o.specks.clamp(0.0, 0.5) * 16_777_216.0) as u32; // threshold on a 24-bit draw
    let mut x = (o.seed as u32) | 1;
    for p in px.chunks_exact_mut(4) {
        if p[3] == 0 { continue; }
        // xorshift32: cheap per-pixel randomness
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if speck > 0 && (x >> 8) < speck {
            let v = if x & 1 == 0 { 255 } else { 0 };
            p[0] = v; p[1] = v; p[2] = v;
            continue;
        }
        if sd > 0.0 {
            let d = delta[(x as usize >> 4) & (N - 1)]; // same delta on R, G, B: luminance grain
            p[0] = (p[0] as i32 + d).clamp(0, 255) as u8;
            p[1] = (p[1] as i32 + d).clamp(0, 255) as u8;
            p[2] = (p[2] as i32 + d).clamp(0, 255) as u8;
        }
    }
}

// ---- sharpen (same kernel as the old JS: 4-neighbour Laplacian) --------------------

fn sharpen(px: &mut [u8], w: usize, h: usize, k: f32) {
    if w < 3 || h < 3 { return; }
    // Keep only the previous and current source rows (not a copy of the whole page), and use
    // fixed-point maths: k in 1/256 steps.
    let row = w * 4;
    let kf = (k * 256.0).round() as i32;
    let mut prev = px[0..row].to_vec();
    let mut cur = px[row..2 * row].to_vec();
    for y in 1..h - 1 {
        let next = &px[(y + 1) * row..(y + 2) * row];
        let next_copy = next.to_vec();
        let out = &mut px[y * row..(y + 1) * row];
        for x in 1..w - 1 {
            let i = x * 4;
            for c in 0..3 {
                let v = cur[i + c] as i32;
                let lap = 4 * v - cur[i - 4 + c] as i32 - cur[i + 4 + c] as i32 - prev[i + c] as i32 - next_copy[i + c] as i32;
                out[i + c] = (v + ((kf * lap) >> 8)).clamp(0, 255) as u8;
            }
        }
        prev = std::mem::replace(&mut cur, next_copy);
    }
}

// ---- Gaussian blur: three box blurs (separable, O(1) per pixel) ---------------------

fn box_sizes(sigma: f32, n: usize) -> Vec<usize> {
    let w_ideal = ((12.0 * sigma * sigma / n as f32) + 1.0).sqrt();
    let mut wl = w_ideal.floor() as i32;
    if wl % 2 == 0 { wl -= 1; }
    if wl < 1 { wl = 1; }
    let wu = wl + 2;
    let m_ideal = (12.0 * sigma * sigma - (n as i32 * wl * wl) as f32 - (4 * n as i32 * wl) as f32 - (3 * n as i32) as f32) / (-4 * wl - 4) as f32;
    let m = m_ideal.round().max(0.0) as usize;
    (0..n).map(|i| if i < m { wl as usize } else { wu as usize }).collect()
}

fn gaussian_blur(px: &mut [u8], w: usize, h: usize, sigma: f32) {
    let mut tmp = vec![0u8; px.len()];
    let mut acc = vec![0u32; w * 4];
    for size in box_sizes(sigma, 3) {
        let r = (size - 1) / 2;
        if r == 0 { continue; }
        box_h(px, &mut tmp, w, h, r);
        box_v(&tmp, px, w, h, r, &mut acc);
    }
}

// Horizontal box blur: one sweep per row, all four channels together (sequential memory).
fn box_h(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize) {
    let div = (2 * r + 1) as u32;
    let inv = (65536 + div / 2) / div; // divide by multiplying (sum <= 255*div, so sum*inv fits u32)
    let last = w - 1;
    for y in 0..h {
        let row = &src[y * w * 4..(y + 1) * w * 4];
        let out = &mut dst[y * w * 4..(y + 1) * w * 4];
        let mut a = [0u32; 4];
        // window centred on x = 0, clamped at the left edge
        for k in 0..=(2 * r) {
            let xx = if k < r { 0 } else { (k - r).min(last) };
            for c in 0..4 { a[c] += row[xx * 4 + c] as u32; }
        }
        for x in 0..w {
            for c in 0..4 { out[x * 4 + c] = ((a[c] * inv + 32768) >> 16).min(255) as u8; }
            let add = (x + r + 1).min(last);
            let sub = x.saturating_sub(r);
            for c in 0..4 { a[c] = a[c] + row[add * 4 + c] as u32 - row[sub * 4 + c] as u32; }
        }
    }
}

// Vertical box blur: running sums per column, walked row by row (cache-friendly).
fn box_v(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, acc: &mut [u32]) {
    let div = (2 * r + 1) as u32;
    let inv = (65536 + div / 2) / div;
    let rowlen = w * 4;
    let last = h - 1;
    let row = |y: usize| &src[y * rowlen..(y + 1) * rowlen];
    acc.iter_mut().for_each(|v| *v = 0);
    for k in 0..=(2 * r) {
        let yy = if k < r { 0 } else { (k - r).min(last) };
        for (a, &v) in acc.iter_mut().zip(row(yy)) { *a += v as u32; }
    }
    for y in 0..h {
        let out = &mut dst[y * rowlen..(y + 1) * rowlen];
        for (o, &a) in out.iter_mut().zip(acc.iter()) { *o = ((a * inv + 32768) >> 16).min(255) as u8; }
        let add = row((y + r + 1).min(last));
        let sub = row(y.saturating_sub(r));
        for i in 0..rowlen { acc[i] = acc[i] + add[i] as u32 - sub[i] as u32; }
    }
}

fn premultiply(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        for c in 0..3 { p[c] = ((p[c] as u32 * a + 127) / 255) as u8; }
    }
}
fn unpremultiply(px: &mut [u8]) {
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a == 0 || a == 255 { continue; }
        for c in 0..3 { p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8; }
    }
}

// ---- true black & white: 1 bit per pixel, rows padded to whole bytes ----------------
// 1 = white, 0 = black (PDF DeviceGray with BitsPerComponent 1, no Decode array).
pub fn pack_bilevel(px: &[u8], w: usize, h: usize, threshold: u32) -> Vec<u8> {
    let stride = (w + 7) / 8;
    let mut out = vec![0u8; stride * h];
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let a = px[i + 3] as u32;
            // see-through counts as white paper
            let l = (54 * px[i] as u32 + 183 * px[i + 1] as u32 + 19 * px[i + 2] as u32) >> 8;
            let l = (l * a + 255 * (255 - a)) / 255;
            if l >= threshold { out[y * stride + x / 8] |= 0x80 >> (x & 7); }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn opts() -> ScanOpts {
        ScanOpts { blur: 0.0, sharp: 0.0, cspace: 0, bright: 1.0, contrast: 1.0, sepia: 0.0, tint: 0.0, grain: 0.0, specks: 0.0, seed: 7 }
    }
    #[test]
    fn identity_leaves_pixels() {
        let mut px = vec![10, 20, 30, 255, 200, 100, 50, 255];
        let before = px.clone();
        process(&mut px, 2, 1, &opts());
        assert_eq!(px, before);
    }
    #[test]
    fn gray_is_luma() {
        let mut px = vec![255, 0, 0, 255];
        process(&mut px, 1, 1, &ScanOpts { cspace: 1, ..opts() });
        assert_eq!(px[0], px[1]);
        assert_eq!(px[0], (0.2126f32 * 255.0 + 0.5) as u8);
    }
    #[test]
    fn blur_keeps_flat_colour() {
        let mut px = vec![128u8; 16 * 16 * 4];
        for p in px.chunks_exact_mut(4) { p[3] = 255; }
        process(&mut px, 16, 16, &ScanOpts { blur: 2.0, ..opts() });
        assert!(px.chunks_exact(4).all(|p| p[0] == 128));
    }
    #[test]
    fn bilevel_packs_bits() {
        let px = vec![255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(pack_bilevel(&px, 3, 1, 128), vec![0b1010_0000]);
    }
    #[test]
    fn grain_is_deterministic_per_seed() {
        let mut a = vec![128u8; 64 * 4];
        for p in a.chunks_exact_mut(4) { p[3] = 255; }
        let mut b = a.clone();
        let o = ScanOpts { grain: 6.0, specks: 0.01, ..opts() };
        process(&mut a, 8, 8, &o);
        process(&mut b, 8, 8, &o);
        assert_eq!(a, b);
    }
}
