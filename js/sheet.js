/* ============================================================
 * sheet.js — Builds the 11" x 17" MSRP window sheet with jsPDF.
 * Everything auto-scales so the sheet always fits on one page.
 * ============================================================ */
(function () {
  'use strict';
  const MSRP = (window.MSRP = window.MSRP || {});

  const PAGE_W = 792; // 11in
  const PAGE_H = 1224; // 17in
  const M = 40;
  const COLOR = {
    band: [24, 24, 26],
    ink: [26, 26, 28],
    muted: [107, 112, 122],
    rule: [214, 217, 222],
    hair: [231, 233, 237],
    bar: [240, 241, 244],
    zebra: [248, 249, 250],
    white: [255, 255, 255],
  };
  const FONT_FILES = {
    MontserratRegular: 'assets/fonts/Montserrat-Regular.ttf',
    MontserratMedium: 'assets/fonts/Montserrat-Medium.ttf',
    MontserratSemiBold: 'assets/fonts/Montserrat-SemiBold.ttf',
    MontserratBold: 'assets/fonts/Montserrat-Bold.ttf',
  };

  /* ---------------- asset loading ---------------- */
  let assetsPromise = null;
  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }
  function loadAssets() {
    if (assetsPromise) return assetsPromise;
    assetsPromise = (async () => {
      const fonts = {};
      try {
        await Promise.all(Object.entries(FONT_FILES).map(async ([name, url]) => {
          const r = await fetch(url);
          if (!r.ok) throw new Error('font ' + url);
          fonts[name] = bufToBase64(await r.arrayBuffer());
        }));
      } catch (e) {
        console.warn('Falling back to Helvetica:', e);
        for (const k of Object.keys(fonts)) delete fonts[k];
      }
      const logoImg = await loadImage('assets/bennington-logo-white.png');
      const c = document.createElement('canvas');
      c.width = logoImg.naturalWidth; c.height = logoImg.naturalHeight;
      c.getContext('2d').drawImage(logoImg, 0, 0);
      return { fonts, logo: { dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height } };
    })();
    return assetsPromise;
  }
  MSRP.loadAssets = loadAssets;

  /* ---------------- document + font helpers ---------------- */
  function newDoc(assets) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: [PAGE_W, PAGE_H], orientation: 'portrait', compress: true });
    const hasFonts = Object.keys(assets.fonts).length === 4;
    if (hasFonts) {
      for (const [name, b64] of Object.entries(assets.fonts)) {
        doc.addFileToVFS(name + '.ttf', b64);
        doc.addFont(name + '.ttf', name, 'normal');
      }
    }
    const F = hasFonts
      ? { reg: ['MontserratRegular', 'normal'], med: ['MontserratMedium', 'normal'], semi: ['MontserratSemiBold', 'normal'], bold: ['MontserratBold', 'normal'] }
      : { reg: ['helvetica', 'normal'], med: ['helvetica', 'normal'], semi: ['helvetica', 'bold'], bold: ['helvetica', 'bold'] };
    return { doc, F, hasFonts };
  }

  function sanitize(t, hasFonts) {
    let s = String(t == null ? '' : t).replace(/●/g, '•');
    if (!hasFonts) s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, '-').replace(/[–—]/g, '-');
    return s;
  }

  /* ---------------- formatting ---------------- */
  const money = (c) => MSRP.fmtMoney(c);
  function priceText(c) { return c === 0 ? 'Included' : money(c); }

  function feetInches(v) {
    if (v == null || v === '') return '';
    const s = String(v).trim();
    const fi = s.match(/^(\d+)\s*'\s*-?\s*(\d+(?:\.\d+)?)\s*"?$/);
    if (fi) return `${fi[1]}' ${fi[2]}"`;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = parseFloat(s);
      let ft = Math.floor(n);
      let inch = Math.round((n - ft) * 12 * 2) / 2;
      if (inch >= 12) { ft += 1; inch -= 12; }
      return inch ? `${ft}' ${inch}"` : `${ft}'`;
    }
    return s;
  }

  function specRows(specs) {
    const rows = [];
    const add = (label, value) => { if (value != null && String(value).trim() !== '') rows.push([label, String(value).trim()]); };
    const num = (v) => /^\d+(\.\d+)?$/.test(String(v || '').trim());
    add('Person Capacity', specs.capacity && (num(specs.capacity) ? `${specs.capacity} People` : specs.capacity));
    add('Max. HP', specs.maxHp && (num(specs.maxHp) ? `${specs.maxHp} HP` : specs.maxHp));
    add('Hull Weight', specs.hullWeight && (num(specs.hullWeight) ? `${Number(specs.hullWeight).toLocaleString('en-US')} lbs` : specs.hullWeight));
    add('Pontoon Gauge', specs.gauge);
    add('Pontoon Diameter', specs.pontoonDiameter);
    add('Length Overall (LOA)', specs.loa && (num(specs.loa) ? `${specs.loa} ft` : feetInches(specs.loa)));
    add('Pontoon Length', feetInches(specs.pontoonLength));
    add('Deck Length', feetInches(specs.deckLength));
    add('Beam', feetInches(specs.beam));
    add('Engine Configuration', specs.engine);
    if (specs.fuel) {
      const m = String(specs.fuel).match(/(\d+(?:\.\d+)?)\s*gal/i);
      add('Fuel Capacity', m ? `${m[1]} gal` : specs.fuel);
    }
    return rows;
  }
  MSRP.specRows = specRows;

  /* ---------------- composition ---------------- */
  const LEFT = { x: M, w: 336 };
  const RIGHT = { x: M + 336 + 40, w: PAGE_W - 2 * M - 336 - 40 };
  const IMG_TOP = 196, IMG_H = 236;
  const COL_TOP = 470;
  const COL_BOTTOM = 1146;

  /**
   * Lays out (and optionally draws) the two columns.
   * Returns the y each column ends at.
   */
  function compose(ctx, model, s, stdFs, draw) {
    const { doc, F, hasFonts } = ctx;
    const T = (t) => sanitize(t, hasFonts);
    const font = (f, size) => { doc.setFont(f[0], f[1]); doc.setFontSize(size); };
    const color = (c) => doc.setTextColor(c[0], c[1], c[2]);
    const wrap = (text, width) => doc.splitTextToSize(T(text), width);

    function heading(col, y, label) {
      const fs = 12.5 * s;
      y += fs;
      if (draw) {
        font(F.bold, fs); color(COLOR.ink);
        doc.setCharSpace(1.1 * s);
        doc.text(T(label.toUpperCase()), col.x, y);
        doc.setCharSpace(0);
        doc.setDrawColor(...COLOR.ink); doc.setLineWidth(1.4);
        doc.line(col.x, y + 6 * s, col.x + col.w, y + 6 * s);
      }
      return y + 6 * s + 8 * s;
    }

    // Generic row: label (wrapped) + right-aligned value on first baseline.
    function row(col, y, label, value, o = {}) {
      const fs = (o.fs || 10) * s;
      const lh = fs * 1.32;
      const padT = (o.pad != null ? o.pad : 4.2) * s;
      const indent = o.indent ? 12 * s : 0;
      font(o.valueFont || F.med, fs);
      const valueW = value ? doc.getTextWidth(T(value)) : 0;
      const labelW = col.w - indent - Math.max(64 * s, valueW + 14 * s);
      font(o.labelFont || F.reg, fs);
      const lines = wrap(label, labelW);
      const h = padT * 2 + lh * (lines.length - 1) + fs * 0.98;
      if (draw) {
        if (o.zebra) { doc.setFillColor(...COLOR.zebra); doc.rect(col.x, y, col.w, h, 'F'); }
        const base = y + padT + fs * 0.78;
        font(o.labelFont || F.reg, fs); color(o.labelColor || COLOR.ink);
        if (o.indent) {
          doc.setDrawColor(...COLOR.muted); doc.setLineWidth(0.6);
          doc.line(col.x + 3 * s, base - fs * 0.3, col.x + 8 * s, base - fs * 0.3);
        }
        lines.forEach((ln, i) => doc.text(ln, col.x + indent + (o.inset || 0), base + i * lh));
        if (value) {
          font(o.valueFont || F.med, fs); color(o.valueColor || COLOR.ink);
          doc.text(T(value), col.x + col.w - (o.inset || 0), base, { align: 'right' });
        }
        if (!o.noRule) {
          doc.setDrawColor(...COLOR.hair); doc.setLineWidth(0.6);
          doc.line(col.x, y + h, col.x + col.w, y + h);
        }
      }
      return y + h;
    }

    function groupBar(col, y, label) {
      const fs = 9 * s;
      const h = 19 * s;
      if (draw) {
        doc.setFillColor(...COLOR.bar); doc.rect(col.x, y, col.w, h, 'F');
        font(F.bold, fs); color(COLOR.ink);
        doc.setCharSpace(0.9 * s);
        doc.text(T(label.toUpperCase()), col.x + 7 * s, y + h / 2 + fs * 0.36);
        doc.setCharSpace(0);
      }
      return y + h + 1 * s;
    }

    /* ----- LEFT: Pricing Details ----- */
    let yl = COL_TOP;
    yl = heading(LEFT, yl, 'Pricing Details');
    const b = model.buckets;
    yl = row(LEFT, yl, 'Base Boat', money(b.base), { fs: 10.5, inset: 2 });
    yl = row(LEFT, yl, 'Engine & Performance Package', money(b.enginePerf), { fs: 10.5, inset: 2 });
    yl = row(LEFT, yl, 'Styling & Options', money(b.stylingOptions), { fs: 10.5, inset: 2 });
    yl += 6 * s;
    {
      const h = 34 * s;
      if (draw) {
        doc.setFillColor(...COLOR.band); doc.rect(LEFT.x, yl, LEFT.w, h, 'F');
        font(F.bold, 10.5 * s); color(COLOR.white);
        doc.setCharSpace(1.2 * s);
        doc.text(T('TOTAL MSRP'), LEFT.x + 12 * s, yl + h / 2 + 3.8 * s);
        doc.setCharSpace(0);
        font(F.bold, 16 * s);
        doc.text(T(money(model.total)), LEFT.x + LEFT.w - 12 * s, yl + h / 2 + 5.6 * s, { align: 'right' });
      }
      yl += h;
    }
    yl += 22 * s;

    /* ----- LEFT: Specifications ----- */
    yl = heading(LEFT, yl, 'Specifications & Capacity');
    specRows(model.specs || {}).forEach(([k, v], i) => {
      yl = row(LEFT, yl, k, v, { fs: 9.6, labelColor: COLOR.muted, zebra: i % 2 === 0, inset: 6 * s, pad: 4 });
    });
    yl += 22 * s;

    /* ----- LEFT: Standards (rich paragraph, bold labels) ----- */
    yl = heading(LEFT, yl, 'Standard Features');
    const stdLh = stdFs * 1.36;
    const runsLines = [];
    {
      // greedy word wrap across mixed bold/regular runs
      const words = [];
      (model.standards || []).forEach((sec, si) => {
        if (sec.label) words.push({ t: sec.label + ':', bold: true, brk: si > 0 });
        T(sec.text).split(/\s+/).filter(Boolean).forEach((w, wi) => words.push({ t: w, bold: false, brk: !sec.label && wi === 0 && si > 0 }));
      });
      let line = [], lineW = 0;
      font(F.reg, stdFs);
      const spaceW = doc.getTextWidth(' ');
      for (const w of words) {
        font(w.bold ? F.bold : F.reg, stdFs);
        const ww = doc.getTextWidth(T(w.t));
        if (w.brk && line.length) { runsLines.push(line); line = []; lineW = 0; }
        if (line.length && lineW + spaceW + ww > LEFT.w) { runsLines.push(line); line = []; lineW = 0; }
        line.push({ ...w, x: line.length ? lineW + spaceW : 0 });
        lineW = line.length === 1 ? ww : lineW + spaceW + ww;
      }
      if (line.length) runsLines.push(line);
    }
    if (draw) {
      runsLines.forEach((ln, i) => {
        const y = yl + stdFs + i * stdLh;
        for (const w of ln) {
          font(w.bold ? F.bold : F.reg, stdFs);
          color(w.bold ? COLOR.ink : [70, 74, 82]);
          doc.text(T(w.t), LEFT.x + w.x, y);
        }
      });
    }
    yl += runsLines.length ? stdFs * 0.3 + runsLines.length * stdLh : 0;

    /* ----- RIGHT: Boat Build ----- */
    let yr = COL_TOP;
    yr = heading(RIGHT, yr, 'Boat Build');
    const groups = [
      ['Base Boat', model.base],
      ['Styling', model.styling],
      ['Performance', model.performance],
      ['Options', model.options],
    ];
    groups.forEach(([label, rows], gi) => {
      if (!rows || !rows.length) return;
      if (gi > 0) yr += 8 * s;
      yr = groupBar(RIGHT, yr, label);
      rows.forEach((r) => {
        yr = row(RIGHT, yr, r.label, priceText(r.price), {
          fs: 9.6,
          indent: !!r.sub,
          inset: 7 * s,
          labelColor: r.sub ? [80, 84, 92] : COLOR.ink,
          valueColor: r.price === 0 ? COLOR.muted : COLOR.ink,
          valueFont: r.price === 0 ? F.reg : F.med,
          pad: 3.6,
        });
      });
    });

    return { yl, yr };
  }

  function drawChrome(ctx, model, assets) {
    const { doc, F, hasFonts } = ctx;
    const T = (t) => sanitize(t, hasFonts);
    // header band
    doc.setFillColor(...COLOR.band);
    doc.rect(0, 0, PAGE_W, 108, 'F');
    const lw = 320, lh = (lw * assets.logo.h) / assets.logo.w;
    doc.addImage(assets.logo.dataUrl, 'PNG', (PAGE_W - lw) / 2, (108 - lh) / 2, lw, lh, 'logo', 'FAST');

    // title
    doc.setFont(...F.bold); doc.setFontSize(34); doc.setTextColor(...COLOR.ink);
    doc.text(T(model.boatName || 'Bennington'), PAGE_W / 2, 160, { align: 'center' });
    const sub = 'MANUFACTURER’S SUGGESTED RETAIL PRICE';
    doc.setFont(...F.med); doc.setFontSize(8.5); doc.setTextColor(...COLOR.muted);
    const cs = 2.2;
    doc.setCharSpace(cs);
    const sw = doc.getTextWidth(T(sub)) + cs * (T(sub).length - 1);
    doc.text(T(sub), (PAGE_W - sw) / 2, 180);
    doc.setCharSpace(0);

    // images
    const gap = 24;
    const bw = (PAGE_W - 2 * M - gap) / 2;
    const slots = [
      { x: M, img: model.images && model.images.profile, label: 'Side Profile' },
      { x: M + bw + gap, img: model.images && model.images.layout, label: 'Overhead Layout' },
    ];
    for (const sl of slots) {
      if (sl.img) {
        const r = Math.min(bw / sl.img.width, IMG_H / sl.img.height);
        const w = sl.img.width * r, h = sl.img.height * r;
        doc.addImage(sl.img.dataUrl, 'JPEG', sl.x + (bw - w) / 2, IMG_TOP + (IMG_H - h) / 2, w, h, undefined, 'FAST');
      } else {
        doc.setFillColor(246, 247, 249);
        doc.setDrawColor(...COLOR.rule);
        doc.setLineWidth(0.8);
        doc.setLineDashPattern([4, 3], 0);
        doc.roundedRect(sl.x, IMG_TOP, bw, IMG_H, 6, 6, 'FD');
        doc.setLineDashPattern([], 0);
        doc.setFont(...F.semi); doc.setFontSize(10); doc.setTextColor(...COLOR.muted);
        doc.setCharSpace(1.6);
        const t = T(sl.label.toUpperCase());
        const tw = doc.getTextWidth(t) + 1.6 * (t.length - 1);
        doc.text(t, sl.x + (bw - tw) / 2, IMG_TOP + IMG_H / 2 - 2);
        doc.setCharSpace(0);
        doc.setFont(...F.reg); doc.setFontSize(8.5);
        doc.text(T('Image coming soon'), sl.x + bw / 2, IMG_TOP + IMG_H / 2 + 14, { align: 'center' });
      }
    }
    // divider
    doc.setDrawColor(...COLOR.rule); doc.setLineWidth(0.8);
    doc.line(M, IMG_TOP + IMG_H + 18, PAGE_W - M, IMG_TOP + IMG_H + 18);
    // column divider
    doc.setDrawColor(...COLOR.hair);
    doc.line(RIGHT.x - 20, COL_TOP, RIGHT.x - 20, COL_BOTTOM);

    // footer
    doc.setDrawColor(...COLOR.rule);
    doc.line(M, 1164, PAGE_W - M, 1164);
    doc.setFont(...F.reg); doc.setFontSize(6.4); doc.setTextColor(...COLOR.muted);
    const disc = 'Prices shown are Manufacturer’s Suggested Retail Prices in US Dollars and do not include destination fees, prep, registration fees, taxes, dealer installed options, or any other applicable discounts or charges unless otherwise noted. Prices, materials, standard equipment and options are subject to change without notice. Renderings are artistic representations and may not reflect the specific model or selected options; colors, features and options may vary. Please contact your Bennington dealer for exact pricing at the time of purchase.';
    const lines = doc.splitTextToSize(T(disc), PAGE_W - 2 * M);
    doc.text(lines, PAGE_W / 2, 1178, { align: 'center', lineHeightFactor: 1.4 });
  }

  /** Find the largest scale + standards font that fits, then draw. */
  async function buildSheet(model) {
    const assets = await loadAssets();
    const measureCtx = newDoc(assets);
    const avail = COL_BOTTOM;
    const MIN_STD = 5.2;
    let chosen = null;
    for (let s = 1.0; s >= 0.5 - 1e-9; s -= 0.02) {
      const r = compose(measureCtx, model, s, MIN_STD, false);
      if (r.yl <= avail && r.yr <= avail) { chosen = s; break; }
    }
    let overflow = false;
    if (chosen == null) { chosen = 0.5; overflow = true; }
    // largest standards font that still fits (cap so it stays tasteful)
    let lo = MIN_STD, hi = Math.max(MIN_STD, 9 * Math.min(1, chosen + 0.1));
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const r = compose(measureCtx, model, chosen, mid, false);
      if (r.yl <= avail) lo = mid; else hi = mid;
    }
    const ctx = newDoc(assets);
    drawChrome(ctx, model, assets);
    const out = compose(ctx, model, chosen, lo, true);
    ctx.doc.setProperties({ title: `${model.boatName || 'Bennington'} — MSRP Sheet`, subject: 'MSRP window sheet', creator: 'Bennington MSRP Sheet Generator' });
    return { blob: ctx.doc.output('blob'), scale: chosen, standardsFont: lo, overflow: overflow || out.yl > avail + 0.5 || out.yr > avail + 0.5 };
  }

  MSRP.buildSheet = buildSheet;
  MSRP.SHEET = { PAGE_W, PAGE_H };
})();
