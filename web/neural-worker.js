// neural-worker.js — runs the Graves RNN off the main thread so the UI stays
// responsive while it samples. Loads the model once, then answers sample requests.
import { NeuralHand, offsetsToStrokes } from './neural.js?v=1';

let hand = null;

self.onmessage = async (e) => {
  const { id, lines, bias, seed, baseUrl } = e.data;
  try {
    if (!hand) {
      self.postMessage({ type: 'status', msg: 'loading' });
      hand = await NeuralHand.load(baseUrl || './model/');
      self.postMessage({ type: 'status', msg: 'ready' });
    }
    const out = [];
    for (const lt of lines) {
      if (!lt || lt.trim() === '') { out.push({ strokes: [], width: 0, height: 0 }); continue; }
      out.push(offsetsToStrokes(hand.sample(lt, { bias, seed })));
    }
    self.postMessage({ id, type: 'result', lines: out });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String((err && err.message) || err) });
  }
};
