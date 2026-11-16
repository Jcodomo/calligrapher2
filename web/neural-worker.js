// neural-worker.js — runs the Graves RNN off the main thread so the UI stays
// responsive while it samples. Loads the model once, then answers sample requests.
// `prime` (optional) is a sample of someone's handwriting to write in their style.
import { NeuralHand, offsetsToStrokes } from './neural.js?v=2';

let hand = null;

self.onmessage = async (e) => {
  const { id, lines, bias, seed, baseUrl, prime } = e.data;
  try {
    if (!hand) {
      self.postMessage({ type: 'status', msg: 'loading' });
      hand = await NeuralHand.load(baseUrl || './model/');
      self.postMessage({ type: 'status', msg: 'ready' });
    }
    const out = [];
    for (const lt of lines) {
      if (!lt || lt.trim() === '') { out.push({ strokes: [], width: 0, height: 0 }); continue; }
      out.push(offsetsToStrokes(hand.sample(lt, { bias, seed, prime: prime || null })));
    }
    self.postMessage({ id, type: 'result', lines: out });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String((err && err.message) || err) });
  }
};
