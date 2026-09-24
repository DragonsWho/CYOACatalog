// Field diagnostics for "the site lags on Firefox mobile": toggle suspected-expensive effects on a
// real phone without devtools. `?perf=nonoise,noblur,fps` (any subset) is remembered in
// localStorage; `?perf=off` clears it. Classes on <html> are matched in index.css.
const KEY = 'perf_flags';
const KNOWN = ['nonoise', 'noblur', 'fps'];

export function initPerfFlags(): void {
  let flags: string[] = [];
  try {
    const q = new URLSearchParams(window.location.search).get('perf');
    if (q !== null) {
      flags = q === 'off' ? [] : q.split(',').filter(f => KNOWN.includes(f));
      if (flags.length) localStorage.setItem(KEY, flags.join(','));
      else localStorage.removeItem(KEY);
    } else {
      flags = (localStorage.getItem(KEY) || '').split(',').filter(f => KNOWN.includes(f));
    }
  } catch { /* storage blocked: URL-only */ }
  for (const f of flags) document.documentElement.classList.add(`perf-${f}`);
  if (flags.includes('fps')) startFpsMeter(flags);
}

// rAF-rate meter: on Firefox Android a choked compositor back-pressures rAF, so this tracks felt fps.
function startFpsMeter(flags: string[]): void {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:4px;bottom:4px;z-index:2147483647;pointer-events:none;'
    + 'font:12px monospace;color:#0f0;background:#000;padding:2px 5px;border-radius:3px';
  document.body.appendChild(el);
  const label = flags.filter(f => f !== 'fps').join(',') || 'default';
  let frames = 0, worst = 0, last = performance.now(), windowStart = last;
  const step = (now: number) => {
    worst = Math.max(worst, now - last);
    last = now;
    frames++;
    if (now - windowStart >= 1000) {
      el.textContent = `${Math.round(frames * 1000 / (now - windowStart))} fps · worst ${Math.round(worst)}ms · ${label}`;
      frames = 0; worst = 0; windowStart = now;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
