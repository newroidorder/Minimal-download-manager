'use strict';

// "Add batch download": http://site/img*.jpg with * from 1 to 20 (optionally
// zero-padded) or from a to z.

const MAX = 10_000;

function expand(pattern, from, to, width = 0) {
  if (typeof pattern !== 'string' || !pattern.includes('*')) throw new Error('the address must contain *');
  const letters = /^[a-z]$/i.test(String(from)) && /^[a-z]$/i.test(String(to));
  const values = [];
  if (letters) {
    let a = String(from).charCodeAt(0), b = String(to).charCodeAt(0);
    if (String(from).toLowerCase() === String(from) !== (String(to).toLowerCase() === String(to))) throw new Error('use the same letter case for both ends');
    const step = a <= b ? 1 : -1;
    for (; step > 0 ? a <= b : a >= b; a += step) values.push(String.fromCharCode(a));
  } else {
    const a = Number.parseInt(from, 10), b = Number.parseInt(to, 10);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) throw new Error('use numbers (0 or more) or single letters');
    if (Math.abs(b - a) + 1 > MAX) throw new Error(`at most ${MAX} files`);
    const step = a <= b ? 1 : -1;
    for (let n = a; step > 0 ? n <= b : n >= b; n += step) values.push(String(n).padStart(width || 0, '0'));
  }
  return values.map(v => pattern.split('*').join(v));
}

module.exports = { expand };
