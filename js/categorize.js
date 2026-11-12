/* ============================================================
 * categorize.js — Sorts quote line items into sheet sections
 * and reconciles every dollar against the quote's Total MSRP.
 * ============================================================ */
(function () {
  'use strict';
  const MSRP = (window.MSRP = window.MSRP || {});

  const MANUFACTURERS = ['Yamaha', 'Mercury', 'Suzuki', 'Honda', 'Tohatsu', 'Evinrude', 'Volvo', 'Indmar', 'Ilmor'];
  const MFR_RE = new RegExp('\\b(' + MANUFACTURERS.join('|') + ')\\b', 'i');
  // Typical outboard model codes: VF250XB, F150XB, LF250XCA, XF425, DF140ATL, BF250 …
  const ENGINE_CODE_RE = /^(?:Twin\s+|Dual\s+|\(?\d\)?\s*x?\s*)?(?:V?F|LF|XF|XTO|DF|BF|ME|MM)?\s?\d{2,3}\s?[A-Z0-9\-]*$/i;

  const CATEGORIES = {
    base: 'Base Boat',
    engine: 'Engine',
    prerig: 'Pre-Rig',
    rigging: 'Engine Rigging',
    perf: 'Performance',
    styling: 'Styling',
    options: 'Options',
    hidden: 'Not shown',
  };
  MSRP.CATEGORIES = CATEGORIES;

  const BUCKET_OF = { base: 'base', engine: 'enginePerf', prerig: 'enginePerf', rigging: 'enginePerf', perf: 'enginePerf', styling: 'stylingOptions', options: 'stylingOptions', hidden: 'stylingOptions' };
  MSRP.BUCKET_OF = BUCKET_OF;

  function isEngine(it, idx, items) {
    const d = it.desc.trim();
    if (it.price <= 0) return false;
    if (/pre-?\s?rig|rigging|package|steering|harness|control|gauge|prop\b|propeller/i.test(d)) return false;
    if (ENGINE_CODE_RE.test(d) && /\d/.test(d)) return true;
    if (MFR_RE.test(d) && /\b\d{2,3}\s?(HP|L|XL|EXLPT|ELPT|CXL|XXL)\b/i.test(d)) return true;
    // Last line of the quote is normally the engine.
    if (idx === items.length - 1 && d.length <= 32 && /\d/.test(d) && !/\s{2,}/.test(d) && d.split(' ').length <= 4) return true;
    return false;
  }

  function styleKind(d) {
    if (/^Accent Panel Colou?r\s*:/i.test(d)) return 'accent';
    if (/^Furniture Accent\s*:/i.test(d)) return 'furnAccent';
    if (/^Base Vinyl\s*:/i.test(d)) return 'vinyl';
    if (/\btrim package\b/i.test(d)) return 'trim';
    if (/anodiz/i.test(d)) return 'anodizing';
    if (/^(?!.*console)(?!.*accent)[\w \-]*Colou?r\s*:/i.test(d)) return 'mainColor';
    return null;
  }

  // "Sport Package", "Performance Package", "Sport Pkg", and Bennington package codes (SPS, SPS+, ESP, ESP+).
  // Note: "Sport Trim Package" is a trim (Styling), not a sport package.
  const PKG_RE = /\b(?:sport|performance)\s+(?:package|pkg)\b|^SPS\+?(?=\s|$)|^ESP\+?(?=\s|$)/i;

  function autoCategory(it, idx, items) {
    const d = it.desc;
    if (/^Base Boat\b/i.test(d)) return 'base';
    if (isEngine(it, idx, items)) return 'engine';
    if (/pre-?\s?rig/i.test(d)) return 'prerig';
    if (/\b(single|twin|dual|triple|quad)\b.*\bengine rigging\b/i.test(d) || /^engine rigging/i.test(d)) return 'rigging';
    // Sport / performance packages go to Performance only when the line costs money;
    // $0 package lines fall through (and normally stay off the sheet).
    if (PKG_RE.test(d)) {
      if (it.price !== 0) return 'perf';
    } else if (/hydraulic (assist )?steering|power assist steering/i.test(d)) return 'perf';
    if (styleKind(d)) return 'styling';
    if (it.price !== 0) return 'options';
    if (/^Stage\s*\d+\s*:/i.test(d)) return 'options';
    return 'hidden';
  }

  /** Strip builder prefixes like "conFiberglass - " or "S_SPORT - ". */
  function cleanPrefix(d) {
    return d.replace(/^(con[A-Z]\w*|[A-Z]+_[A-Z0-9_]+)\s+-\s+/, '').trim();
  }
  MSRP.cleanPrefix = cleanPrefix;

  function valueAfterColon(d) {
    const i = d.indexOf(':');
    return i >= 0 ? d.slice(i + 1).trim() : d.trim();
  }

  function engineManufacturer(items) {
    for (const it of items) {
      if (it.cat === 'prerig' || it.cat === 'rigging' || it.cat === 'engine') {
        const m = it.desc.match(MFR_RE);
        if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      }
    }
    const eng = items.find((i) => i.cat === 'engine');
    if (eng) {
      const code = eng.desc.replace(/^(Twin|Dual)\s+/i, '');
      if (/^(V?F|LF|XF|XTO)\d/i.test(code)) return 'Yamaha';
      if (/^DF\d/i.test(code)) return 'Suzuki';
      if (/^BF\d/i.test(code)) return 'Honda';
    }
    return '';
  }

  /** Initial categorisation (category per item). */
  function categorize(quote) {
    quote.items.forEach((it, idx) => {
      it.autoCat = autoCategory(it, idx, quote.items);
      it.cat = it.autoCat;
    });
    return buildModel(quote);
  }

  /** Builds the display model and reconciliation from current item categories. */
  function buildModel(quote) {
    // Apply user edits: removed lines drop out, price overrides replace the quoted price.
    const allItems = quote.items;
    const items = allItems
      .filter((i) => !i.removed)
      .map((i) => ({ ...i, origPrice: i.price, price: i.priceOverride != null ? i.priceOverride : i.price }));
    const by = (c) => items.filter((i) => i.cat === c);
    const sortGroup = (arr) => arr.slice().sort((a, b) => b.price - a.price || a.order - b.order);

    // ----- Base boat
    const baseItems = by('base');
    const base = baseItems.map((it) => ({ id: it.id, label: quote.boatName || it.desc.replace(/^Base Boat:\s*/i, ''), price: it.price }));

    // ----- Styling (fixed order of requested attributes, then any extra styling)
    const order = ['mainColor', 'accent', 'trim', 'vinyl', 'furnAccent', 'anodizing'];
    const styling = [];
    const stylingItems = by('styling').map((it) => ({ it, kind: styleKind(it.desc) }));
    stylingItems.sort((a, b) => (order.indexOf(a.kind) + 1 || 99) - (order.indexOf(b.kind) + 1 || 99) || a.it.order - b.it.order);
    for (const { it, kind } of stylingItems) {
      const v = valueAfterColon(it.desc);
      let label;
      switch (kind) {
        case 'mainColor': label = `${v} Exterior Main`; break;
        case 'accent':
          if (/^no\b/i.test(v) && it.price === 0) continue; // "No Accent"
          label = `${v} Exterior Accent`; break;
        case 'vinyl': label = `${v} Vinyl`; break;
        case 'furnAccent': label = `${v} Furniture Accent`; break;
        default: label = cleanPrefix(it.desc);
      }
      styling.push({ id: it.id, label, price: it.price });
    }

    // ----- Performance: engine, pre-rig, rigging, performance package (+ sub-features)
    const mfr = engineManufacturer(items);
    const performance = [];
    for (const it of sortGroup(by('engine'))) {
      const code = it.desc.trim();
      const label = mfr && !code.toLowerCase().includes(mfr.toLowerCase()) ? `${mfr} ${code}` : code;
      performance.push({ id: it.id, label, price: it.price });
    }
    for (const it of by('prerig')) performance.push({ id: it.id, label: cleanPrefix(it.desc), price: it.price });
    for (const it of by('rigging')) performance.push({ id: it.id, label: cleanPrefix(it.desc), price: it.price });
    const perf = by('perf');
    if (perf.length) {
      // Each package line that doesn't extend another package is a "main" line;
      // lines that extend it with " - " (e.g. "... - Power Hydraulic Assist Steering") list under it.
      const byPrice = (a, b) => b.price - a.price || a.order - b.order;
      const pkgs = perf.filter((p) => PKG_RE.test(p.desc));
      const mains = pkgs
        .filter((p) => !pkgs.some((q) => q !== p && p.desc.startsWith(q.desc + ' - ')))
        .sort(byPrice);
      const used = new Set();
      for (const main of mains) {
        used.add(main);
        performance.push({ id: main.id, label: cleanPrefix(main.desc).replace(/\s*-\s*Increased Horse ?Power$/i, ''), price: main.price });
        const prefix = main.desc + ' - ';
        for (const s of perf.filter((p) => !used.has(p) && p.desc.startsWith(prefix)).sort(byPrice)) {
          used.add(s);
          performance.push({ id: s.id, label: s.desc.slice(prefix.length), price: s.price, sub: true });
        }
      }
      for (const s of perf.filter((p) => !used.has(p)).sort(byPrice)) {
        performance.push({ id: s.id, label: cleanPrefix(s.desc), price: s.price });
      }
    }

    // ----- Options
    const options = sortGroup(by('options')).map((it) => ({ id: it.id, label: cleanPrefix(it.desc), price: it.price }));

    const hidden = by('hidden');

    // ----- Buckets & reconciliation (integer cents)
    const sum = (arr) => arr.reduce((s, i) => s + i.price, 0);
    const buckets = { base: 0, enginePerf: 0, stylingOptions: 0 };
    for (const it of items) buckets[BUCKET_OF[it.cat]] += it.price;
    const itemsTotal = sum(items);
    const bucketTotal = buckets.base + buckets.enginePerf + buckets.stylingOptions;
    const quoteTotal = quote.summary.total;
    const hiddenPriced = hidden.filter((h) => h.price !== 0);
    // Original quote (before user edits) — proves the PDF was read correctly.
    const origTotal = allItems.reduce((s, i) => s + i.price, 0);
    const removedItems = allItems.filter((i) => i.removed);
    const overridden = allItems.filter((i) => !i.removed && i.priceOverride != null && i.priceOverride !== i.price);
    const edited = removedItems.length > 0 || overridden.length > 0;
    const editDelta = itemsTotal - origTotal;

    const checks = [];
    checks.push({ label: 'Pricing sections add up to the Total MSRP', ok: bucketTotal === itemsTotal });
    if (quoteTotal != null) checks.push({ label: 'Quote read correctly — line items match its Total Boat MSRP', ok: origTotal === quoteTotal, delta: origTotal - quoteTotal, quoteMatch: true });
    if (!edited) {
      if (quote.summary.base != null) checks.push({ label: 'Base boat matches the quote', ok: buckets.base === quote.summary.base, info: true });
      if (quote.summary.enginePrerig != null) {
        const ep = sum(by('engine')) + sum(by('prerig'));
        checks.push({ label: 'Engine + pre-rig matches the quote’s Engine & Prerig', ok: ep === quote.summary.enginePrerig, info: true });
      }
    }
    if (hiddenPriced.length) checks.push({ label: 'Every priced item appears on the sheet', ok: false });
    const ok = checks.filter((c) => !c.info).every((c) => c.ok) && quoteTotal != null;

    return {
      boatName: quote.boatName,
      base, styling, performance, options, hidden,
      manufacturer: mfr,
      buckets,
      total: bucketTotal,
      quoteTotal,
      removed: removedItems,
      edits: { edited, removedCount: removedItems.length, overriddenCount: overridden.length, delta: editDelta, origTotal },
      reconcile: { ok, checks, itemsTotal, quoteTotal },
    };
  }

  MSRP.categorize = categorize;
  MSRP.buildModel = buildModel;

  /** Money formatting: "$46,376" (cents shown only when non-zero). */
  MSRP.fmtMoney = function (cents, { always = false } = {}) {
    const neg = cents < 0;
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100);
    const c = abs % 100;
    let s = '$' + dollars.toLocaleString('en-US');
    if (c || always) s += '.' + String(c).padStart(2, '0');
    return neg ? '-' + s : s;
  };
})();
