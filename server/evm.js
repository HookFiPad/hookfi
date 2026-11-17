// Small EVM toolkit: keccak, checksum addresses, an ABI encoder/decoder and a JSON-RPC client. No framework.
import { keccak_256 } from '@noble/hashes/sha3';

export const hex = (b) => Buffer.from(b).toString('hex');
export const bytes = (h) => Buffer.from(String(h).replace(/^0x/, ''), 'hex');
export const keccak = (h) => '0x' + hex(keccak_256(typeof h === 'string' ? bytes(h) : h));
export const selector = (sig) => '0x' + hex(keccak_256(Buffer.from(sig))).slice(0, 8);
export const topic = (sig) => '0x' + hex(keccak_256(Buffer.from(sig)));

export function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, ''), h = hex(keccak_256(Buffer.from(a)));
  let out = '0x'; for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i]; return out;
}

// ---- ABI ----
// A type is 'uint' | 'int' | 'address' | 'bool' | 'bytes32' | 'bytes' | { tuple: [types] } | { array: type }
const W = (n) => { let v = BigInt(n); if (v < 0n) v += 1n << 256n; return v.toString(16).padStart(64, '0'); };
const dyn = (t) => t === 'bytes' || (typeof t === 'object' && (t.array ? true : t.tuple.some(dyn)));
function enc(t, v) {
  if (t === 'uint' || t === 'int') return W(v);
  if (t === 'address') return String(v).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  if (t === 'bool') return W(v ? 1 : 0);
  if (t === 'bytes32') return String(v).replace(/^0x/, '').padEnd(64, '0');
  if (t === 'bytes') { const h = String(v).replace(/^0x/, ''); return W(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0'); }
  if (t.tuple) return encTuple(t.tuple, v);
  if (t.array) return W(v.length) + encTuple(v.map(() => t.array), v);
  throw new Error('abi: unknown type');
}
function encTuple(types, vals) {
  const parts = types.map((t, i) => enc(t, vals[i])); let headLen = types.reduce((n, t) => n + (dyn(t) ? 32 : staticSize(t)), 0), head = '', tail = '';
  types.forEach((t, i) => { if (dyn(t)) { head += W(headLen + tail.length / 2); tail += parts[i]; } else head += parts[i]; });
  return head + tail;
}
const staticSize = (t) => (typeof t === 'object' && t.tuple ? t.tuple.reduce((n, x) => n + staticSize(x), 0) : 32);
export const encode = (types, vals) => '0x' + encTuple(types, vals);
export const call = (sig, types = [], vals = []) => selector(sig) + encTuple(types, vals);

// decode a flat list of static words
export const words = (h) => { const s = String(h).replace(/^0x/, ''); const out = []; for (let i = 0; i + 64 <= s.length; i += 64) out.push(s.slice(i, i + 64)); return out; };
export const toUint = (w) => BigInt('0x' + (w || '0'));
export const toInt = (w, bits = 256) => { let v = BigInt('0x' + (w || '0')) & ((1n << BigInt(bits)) - 1n); if (v >> BigInt(bits - 1)) v -= 1n << BigInt(bits); return v; };
export const toAddr = (w) => checksum('0x' + w.slice(24));
// an ABI string returned as the only value (or a bytes32, as a few old tokens do)
export function toString(h) {
  const s = String(h || '').replace(/^0x/, ''); if (!s) return null;
  try {
    if (s.length === 64) return Buffer.from(s, 'hex').toString('utf8').replace(/\0+$/, '') || null;
    const off = Number(toUint(s.slice(0, 64))) * 2, len = Number(toUint(s.slice(off, off + 64)));
    if (len > 256) return null; return Buffer.from(s.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
  } catch { return null; }
}

// ---- decimals ----
export function parseUnits(str, dec) {
  const s = String(str).trim(); if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amount must be a decimal string like "0.01"');
  const [i, f = ''] = s.split('.'); if (f.length > dec) throw new Error('amount has more than ' + dec + ' decimal places');
  return BigInt(i) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
}
export function formatUnits(v, dec) {
  const n = BigInt(v), neg = n < 0n, a = neg ? -n : n, base = 10n ** BigInt(dec), i = a / base, f = (a % base).toString().padStart(dec, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + i + (f ? '.' + f : '');
}

// ---- JSON-RPC ----
export function rpcClient(url) {
  let id = 0, active = 0, coolUntil = 0; const waiting = [];
  // at most four requests in flight; a 429 pauses every request for a moment, then retries
  const slot = () => new Promise((go) => { const run = () => { active++; go(); }; active < 4 ? run() : waiting.push(run); });
  const done = () => { active--; const n = waiting.shift(); if (n) n(); };
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  // a token bucket sized for the public endpoint: every call in a batch counts
  const RATE = Number(process.env.RPC_RATE || 30), CAP = 60; let tokensLeft = CAP, last = Date.now();
  const spend = async (n) => { for (;;) { const now = Date.now(); tokensLeft = Math.min(CAP, tokensLeft + ((now - last) / 1000) * RATE); last = now; if (tokensLeft >= n) { tokensLeft -= n; return; } await sleep(Math.ceil(((n - tokensLeft) / RATE) * 1000) + 5); } };
  const post = async (body, tries = 7) => {
    await slot();
    try {
      await spend(Math.min(CAP, Array.isArray(body) ? body.length : 1));
      for (let k = 0; ; k++) {
        if (coolUntil > Date.now()) await sleep(coolUntil - Date.now());
        try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
          if (r.status === 429) { coolUntil = Date.now() + Math.min(8000, 600 * 2 ** k); throw new Error('rpc http 429'); }
          // some endpoints answer a refused call (an archive range, say) with a 4xx and a JSON-RPC error body: that is an answer, not an outage
          if (!r.ok) { const j = await r.json().catch(() => null); if (j && (j.error || Array.isArray(j))) return j; throw new Error('rpc http ' + r.status); } return await r.json(); }
        catch (e) { if (k + 1 >= tries) throw e; await sleep(300 * (k + 1)); }
      }
    } finally { done(); }
  };
  const one = async (method, params = []) => { const j = await post({ jsonrpc: '2.0', id: ++id, method, params }); if (j.error) { const e = new Error(j.error.message || 'rpc error'); e.data = j.error.data; e.rpc = true; throw e; } return j.result; };
  // many calls in one request; each result is { result } or { error }
  const batch = async (calls) => {
    const out = [];
    for (let i = 0; i < calls.length; i += 40) {
      const part = calls.slice(i, i + 40).map(([method, params]) => ({ jsonrpc: '2.0', id: ++id, method, params }));
      const j = await post(part); const by = new Map((Array.isArray(j) ? j : [j]).map((x) => [x.id, x]));
      for (const p of part) out.push(by.get(p.id) || { error: { message: 'no response' } });
    }
    return out;
  };
  const ethCall = (to, data, extra = {}) => one('eth_call', [{ to, data, ...extra }, 'latest']);
  return { one, batch, ethCall };
}
