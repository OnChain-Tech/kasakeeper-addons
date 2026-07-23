// KasaKeeper — brand motion "The Look-Around" (12s loop), ported from the design
// project's eye-scene.jsx (Claude Design, mark 5B). The eye scans for work, finds
// a drip and a leaf, ticks them off, keeps watch. Vanilla rAF port, dark-adapted.
// Reduced-motion: renders the static mark + tagline instead.
const EyeScene = (() => {
  const E = {
    easeInQuad: p => p * p,
    easeOutQuad: p => p * (2 - p),
    easeInOutQuad: p => (p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
    easeInOutSine: p => -(Math.cos(Math.PI * p) - 1) / 2,
    easeInOutCubic: p => (p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    easeOutCubic: p => 1 - Math.pow(1 - p, 3),
    easeOutBack: p => { const c = 1.70158; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); },
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const interp = (ts, vs, ease) => t => {
    if (t <= ts[0]) return vs[0];
    if (t >= ts[ts.length - 1]) return vs[vs.length - 1];
    let i = 1; while (ts[i] < t) i++;
    const p = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
    return vs[i - 1] + (vs[i] - vs[i - 1]) * ease(p);
  };

  // ── timing channels (verbatim from eye-scene.jsx) ──
  const irisX = interp(
    [0, 1.95, 2.08, 2.35, 2.55, 3.85, 4.25, 4.75, 4.98, 5.15, 6.15, 6.5, 7.05, 7.22, 7.38, 7.66, 7.86, 8.24, 8.4, 8.56, 8.78, 8.98],
    [0, 0, 1.6, -7.3, -6.4, -6.4, 0, 0, 7.3, 6.4, 6.4, 0, 0, -6.2, -5.5, -5.5, 0, 0, 6.2, 5.5, 5.5, 0], E.easeInOutCubic);
  const irisY = interp(
    [0, 1.95, 2.35, 3.85, 4.25, 4.75, 4.98, 5.6, 6.15, 6.5, 7.05, 7.22, 7.66, 7.86, 8.2, 8.44, 8.78, 8.98],
    [0, 0, 2.2, 2.2, 0, 0, -3.2, 1.6, 1.6, 0, 0, 0.8, 0.8, -4.4, -4.4, 0.8, 0.8, 0], E.easeInOutCubic);
  const squint = interp(
    [0, 2.6, 2.95, 3.3, 3.45, 5.6, 5.85, 6.0, 10.2, 10.9, 11.4, 11.85],
    [0, 0, 0.34, 0.34, 0, 0, 0.3, 0, 0, 0.24, 0.24, 0], E.easeInOutSine);
  const bounce = interp([0, 8.98, 9.2, 9.45, 9.7], [1, 1, 1.06, 0.985, 1], E.easeInOutSine);
  const BLINKS = [0.55, 3.42, 5.98, 9.02, 9.3];
  const blinkAmt = t => { let v = 0; for (const t0 of BLINKS) { const p = t - t0;
    if (p >= 0 && p < 0.26) v += p < 0.11 ? E.easeOutQuad(p / 0.11) : 1 - E.easeInOutQuad((p - 0.11) / 0.15); } return v; };
  const dropY = interp([1.7, 2.12, 2.3, 2.44, 2.55, 2.66], [-40, 566, 526, 566, 550, 566], E.easeInOutSine);
  const dropSq = interp([0, 2.06, 2.12, 2.2, 2.4, 2.44, 2.5], [1, 1, 0.7, 1, 0.86, 1, 1], E.easeInOutSine);
  const leafY = interp([4.45, 5.55, 5.68, 5.78], [-36, 564, 550, 564], E.easeInOutSine);
  const leafAmp = interp([0, 5.45, 5.75], [1, 1, 0], E.easeInOutSine);

  // dark-theme palette (scene was authored ink-on-paper; we keep iris = accent)
  const C = { ink: 'var(--text)', muted: 'var(--muted)', floor: 'var(--surface2)', leaf: '#7fa65a', shadow: '232,240,234' };

  function build(host) {
    host.innerHTML = `
    <div class="eye-stage"><div class="eye-inner">
      <div class="ef" style="position:absolute;left:0;right:0;top:580;bottom:0;background:${C.floor}"></div>
      <div class="esh" style="position:absolute;top:588;height:26;border-radius:50%;background:rgba(${C.shadow},.07)"></div>
      <svg class="eeye" viewBox="0 0 48 48" style="position:absolute;left:460px;top:120px;width:360px;height:360px;transform-origin:50% 62%">
        <path class="eroof" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
        <path class="elid" fill="none" stroke="${C.ink}" stroke-width="4" stroke-linecap="round"></path>
        <ellipse class="eiris" rx="4.6" fill="var(--accent)"></ellipse>
      </svg>
      <div class="edropsh" style="position:absolute;left:281px;top:578px;width:38px;height:10px;border-radius:50%"></div>
      <svg class="edrop" viewBox="0 0 28 34" style="position:absolute;left:286px;width:28px;height:34px;transform-origin:50% 100%">
        <path d="M14 2 L22.5 15 L5.5 15 Z" fill="var(--accent)"></path><circle cx="14" cy="21" r="11" fill="var(--accent)"></circle>
      </svg>
      <div class="eleafsh" style="position:absolute;left:963px;top:578px;width:44px;height:10px;border-radius:50%"></div>
      <svg class="eleaf" viewBox="0 0 44 24" style="position:absolute;width:44px;height:24px">
        <ellipse cx="19" cy="12" rx="16" ry="7.5" fill="${C.leaf}"></ellipse>
        <path d="M34 12 L41 12" stroke="${C.leaf}" stroke-width="3" stroke-linecap="round"></path>
      </svg>
      <div class="epop1 epop" style="left:300px;top:540px"></div>
      <div class="epop2 epop" style="left:985px;top:540px"></div>
      <div class="ewonder" style="position:absolute;left:812px;font-size:52px;font-weight:600;color:${C.muted};transform-origin:50% 100%">?</div>
      <div class="ecard" style="position:absolute;left:0;right:0;text-align:center">
        <div style="font-size:38px;font-weight:600;letter-spacing:-.02em;color:${C.ink}">KasaKeeper</div>
        <div style="font-size:18px;color:${C.muted};margin-top:6px">All kept. Watching on.</div>
      </div>
    </div></div>`;
    host.querySelectorAll('.epop').forEach(p => { p.style.cssText += ';position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#F4F1EA;font-size:22px;font-weight:700'; p.textContent = '✓'; });
    return host.querySelector('.eye-stage');
  }

  const active = [];
  function mount(host) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      host.innerHTML = `<div class="eye-static"><svg viewBox="0 0 48 48"><use href="#kk-mark"/></svg><div>Keeping watch.</div></div>`;
      return;
    }
    const stage = build(host);
    const inner = stage.querySelector('.eye-inner');
    const q = s => stage.querySelector(s);
    const el = { sh: q('.esh'), eye: q('.eeye'), roof: q('.eroof'), lid: q('.elid'), iris: q('.eiris'),
      dropsh: q('.edropsh'), drop: q('.edrop'), leafsh: q('.eleafsh'), leaf: q('.eleaf'),
      pop1: q('.epop1'), pop2: q('.epop2'), wonder: q('.ewonder'), card: q('.ecard') };
    const ro = new ResizeObserver(() => { inner.style.transform = `scale(${stage.offsetWidth / 1280})`; });
    ro.observe(stage);
    const t0 = performance.now();
    const win = (t, a, b) => t >= a && t < b;
    function pop(elm, t, s) { // CheckPop: pop in, rise, fade, at start-time s
      const p = E.easeOutBack(clamp((t - s) / 0.28, 0, 1));
      const r = clamp((t - s - 0.45) / 0.7, 0, 1);
      elm.style.transform = `translateY(${-46 * E.easeOutCubic(r)}px) scale(${p})`;
      elm.style.opacity = 1 - E.easeInQuad(r);
    }
    function frame(now) {
      const t = ((now - t0) / 1000) % 12;
      const lid = clamp(blinkAmt(t) + squint(t), 0, 1);
      const ix = irisX(t), iy = irisY(t) + 0.35 * Math.sin(t * 2.1), s = bounce(t);
      el.roof.setAttribute('d', `M8 ${25 + 0.8 * lid} L24 ${11 + 2.4 * lid} L40 ${25 + 0.8 * lid}`);
      el.lid.setAttribute('d', `M12.5 ${28 - 1.0 * lid} Q24 ${38.5 - 4.5 * lid} 35.5 ${28 - 1.0 * lid}`);
      el.iris.setAttribute('cx', 24 + ix); el.iris.setAttribute('cy', 24 + iy);
      el.iris.setAttribute('ry', Math.max(0.001, 4.6 * (1 - 0.9 * lid)));
      el.eye.style.transform = `rotate(${ix * 0.45}deg) scale(${s})`;
      el.sh.style.left = (640 - 130 * s) + 'px'; el.sh.style.width = (260 * s) + 'px';
      // droplet
      if (win(t, 1.62, 3.46)) { const y = dropY(t), jig = t > 2.66 ? 7 * Math.sin((t - 2.66) * 9) * Math.exp(-(t - 2.66) * 1.8) : 0;
        el.drop.style.display = 'block'; el.dropsh.style.display = 'block';
        el.drop.style.top = (y - 17) + 'px'; el.drop.style.transform = `scaleY(${dropSq(t)}) rotate(${jig}deg)`;
        el.dropsh.style.background = `rgba(${C.shadow},${clamp((y - 380) / 186, 0, 1) * 0.13})`;
      } else { el.drop.style.display = 'none'; el.dropsh.style.display = 'none'; }
      // leaf
      if (win(t, 4.35, 6.05)) { const y = leafY(t), amp = leafAmp(t);
        el.leaf.style.display = 'block'; el.leafsh.style.display = 'block';
        el.leaf.style.left = (985 + 30 * Math.sin(t * 3.6) * amp - 22) + 'px'; el.leaf.style.top = (y - 12) + 'px';
        el.leaf.style.transform = `rotate(${14 * Math.sin(t * 3.6 + 0.8) * amp - 6 * (1 - amp)}deg)`;
        el.leafsh.style.background = `rgba(${C.shadow},${clamp((y - 380) / 186, 0, 1) * 0.13})`;
      } else { el.leaf.style.display = 'none'; el.leafsh.style.display = 'none'; }
      // ticks
      if (win(t, 3.46, 4.8)) { el.pop1.style.display = 'flex'; pop(el.pop1, t, 3.5); } else el.pop1.style.display = 'none';
      if (win(t, 6.02, 7.35)) { el.pop2.style.display = 'flex'; pop(el.pop2, t, 6.06); } else el.pop2.style.display = 'none';
      // wonder ?
      if (win(t, 7.3, 9.02)) { const inP = E.easeOutBack(clamp((t - 7.35) / 0.3, 0, 1)), outP = clamp((t - 8.8) / 0.18, 0, 1);
        el.wonder.style.display = 'block'; el.wonder.style.top = (138 + 5 * Math.sin(t * 2.6)) + 'px';
        el.wonder.style.transform = `scale(${inP * (1 - outP)})`;
      } else el.wonder.style.display = 'none';
      // end card
      if (win(t, 9.4, 12)) { const inP = E.easeOutCubic(clamp((t - 9.5) / 0.55, 0, 1)), outP = clamp((t - 11.45) / 0.4, 0, 1);
        el.card.style.display = 'block'; el.card.style.top = (612 + 10 * (1 - inP)) + 'px'; el.card.style.opacity = inP * (1 - outP);
      } else el.card.style.display = 'none';
      h.raf = requestAnimationFrame(frame);
    }
    const h = { raf: requestAnimationFrame(frame), ro };
    active.push(h);
  }
  function mountAll() {
    active.splice(0).forEach(h => { cancelAnimationFrame(h.raf); h.ro.disconnect(); });
    document.querySelectorAll('[data-eye-scene]').forEach(mount);
  }
  return { mountAll };
})();
