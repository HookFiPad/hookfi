// shared by every page: the nav, small helpers, the API client
export const $ = (id) => document.getElementById(id);
export const NAME = '{{NAME}}', TICKER = '{{TICKER}}', ORIGIN = '{{ORIGIN}}', X_URL = '{{X_URL}}', GH_URL = '{{GH_URL}}';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const short = (a, n = 6) => (a ? a.slice(0, n) + '…' + a.slice(-4) : '');
export const num = (n) => Number(n).toLocaleString('en-US');
export const sig = (n, d = 6) => { const v = Number(n); if (!isFinite(v)) return '—'; if (v === 0) return '0'; return Math.abs(v) >= 1e9 || Math.abs(v) < 1e-6 ? v.toExponential(3) : Number(v.toPrecision(d)).toLocaleString('en-US', { maximumFractionDigits: 8 }); };
export async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined), j = await r.json();
  if (j && j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j;
}
let tt; export function toast(msg, err) { let t = document.querySelector('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.className = 'toast on' + (err ? ' err' : ''); clearTimeout(tt); tt = setTimeout(() => { t.className = 'toast'; }, 3200); }
export const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true));

// the mark: a fish hook with a barb
export const MARK = '<svg viewBox="0 0 24 24" fill="none"><defs><linearGradient id="mk" x1="0" y1="0" x2="24" y2="24"><stop stop-color="#fff"/><stop offset=".5" stop-color="#7dff8a"/><stop offset="1" stop-color="#00c805"/></linearGradient></defs><circle cx="15.5" cy="3.6" r="1.9" stroke="url(#mk)" stroke-width="1.7"/><path d="M15.5 5.6v9.2a5.2 5.2 0 0 1-10.4 0v-3.4l3.4 3.3" stroke="url(#mk)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function nav(active) {
  const links = [['/#products', 'Products'], ['/#decoder', 'Decoder'], ['/hooks', 'Hooks'], ['/launch', 'Launch'], ['/docs', 'Docs'], ['/burn', 'Burn'], ['/#token', TICKER]];
  const el = document.createElement('header'); el.className = 'nav';
  el.innerHTML = '<a class="logo" href="/">' + MARK + NAME + '</a><nav class="links">' + links.map(([h, t]) => '<a href="' + h + '"' + (h === active ? ' class="on"' : '') + '>' + t + '</a>').join('') + '</nav><span class="soc">' + (X_URL !== '#' ? '<a class="ic" href="' + X_URL + '" target="_blank" rel="noopener" aria-label="' + NAME + ' on X" title="X"><svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>' : '') + (GH_URL !== '#' ? '<a class="ic" href="' + GH_URL + '" target="_blank" rel="noopener" aria-label="' + NAME + ' on GitHub" title="GitHub"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg></a>' : '') + '</span><a class="pill lt sm" href="/docs">Start building →</a>';
  document.body.prepend(el);
}
export function foot() {
  const f = document.createElement('footer'); f.className = 'foot';
  f.innerHTML = '<div class="wrap"><span class="logo" style="font-size:17px;margin:0">' + MARK + NAME + '<span class="mut" style="font-weight:400;margin-left:12px">Uniswap v4 hooks on Robinhood Chain.</span></span><span><a href="/docs">Docs</a><a href="/hooks">Hooks</a><a href="/launch">Launch</a><a href="/burn">Burn</a>' + (X_URL !== '#' ? '<a href="' + X_URL + '" target="_blank" rel="noopener">X</a>' : '') + (GH_URL !== '#' ? '<a href="' + GH_URL + '" target="_blank" rel="noopener">GitHub</a>' : '') + '</span></div>';
  document.body.appendChild(f);
}
// word-by-word reveal on scroll
export function reveal() {
  document.querySelectorAll('.rv').forEach((el) => { if (el.dataset.done) return; el.dataset.done = 1;
    const walk = (n) => { if (n.nodeType === 3) { const f = document.createDocumentFragment(); n.textContent.split(/(\s+)/).forEach((w) => { if (/^\s*$/.test(w)) f.appendChild(document.createTextNode(w)); else { const s = document.createElement('span'); s.textContent = w; f.appendChild(s); } }); n.replaceWith(f); } else if (n.nodeType === 1 && n.tagName !== 'EM') [...n.childNodes].forEach(walk); else if (n.tagName === 'EM') { const s = document.createElement('span'); n.replaceWith(s); s.appendChild(n); } };
    [...el.childNodes].forEach(walk); });
  const tick = () => { document.querySelectorAll('.rv').forEach((el) => { const sp = el.querySelectorAll(':scope span'), r = el.getBoundingClientRect(), p = Math.max(0, Math.min(1, (innerHeight * 0.92 - r.top) / (innerHeight * 0.5))); sp.forEach((s, i) => s.classList.toggle('in', i / sp.length < p)); }); };
  addEventListener('scroll', tick, { passive: true }); addEventListener('resize', tick); tick();
}
