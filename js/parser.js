/* ============================================================
 * parser.js — Reads a Bennington "Customer Quote" PDF (pdf.js)
 * and returns a structured quote object.
 * ============================================================ */
(function () {
  'use strict';
  const MSRP = (window.MSRP = window.MSRP || {});

  const MONEY_RE = /^\(?-?\$\s?[\d,]+(?:\.\d{1,2})?\)?$/;
  const MIN_TEXT_HEIGHT = 4; // ignore hidden micro-text (e.g. 1.5pt watermark)

  /** "$46,376.00" -> 4637600 (integer cents). */
  function toCents(str) {
    if (str == null) return null;
    const s = String(str).trim();
    const neg = /^\(.*\)$/.test(s) || s.includes('-');
    const num = s.replace(/[^\d.]/g, '');
    if (!num) return null;
    const cents = Math.round(parseFloat(num) * 100);
    return neg ? -cents : cents;
  }
  MSRP.toCents = toCents;

  const clean = (s) => s.replace(/\s+/g, ' ').trim();

  /** Join wrapped lines: keep hyphenated compounds ("PMX-" + "R20B") together. */
  function joinWrapped(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (/[^\s]-$/.test(a) && /^[A-Za-z0-9]/.test(b)) return a + b;
    return a + ' ' + b;
  }

  /** Group text items into lines by baseline. */
  function groupLines(items) {
    const sorted = items.slice().sort((p, q) => p.base - q.base || p.x - q.x);
    const lines = [];
    for (const it of sorted) {
      const last = lines[lines.length - 1];
      const tol = Math.max(2, 0.3 * it.h);
      if (last && Math.abs(last.base - it.base) <= tol) last.items.push(it);
      else lines.push({ base: it.base, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((p, q) => p.x - q.x);
      ln.top = Math.min(...ln.items.map((i) => i.top));
      ln.x = ln.items[0].x;
      ln.text = clean(ln.items.map((i) => i.str).join(' '));
    }
    return lines;
  }

  /** Split a line into description + trailing money value (if the last item is money). */
  function splitPrice(line) {
    const its = line.items;
    const last = its[its.length - 1];
    if (its.length > 1 && MONEY_RE.test(last.str.trim())) {
      return { desc: clean(its.slice(0, -1).map((i) => i.str).join(' ')), price: toCents(last.str), priceText: last.str.trim() };
    }
    // money may be glued in one item: "Ski Tow Bar $1,564.00"
    const m = line.text.match(/^(.*?)\s+(\(?-?\$[\d,]+(?:\.\d{1,2})?\)?)$/);
    if (m) return { desc: clean(m[1]), price: toCents(m[2]), priceText: m[2] };
    return { desc: line.text, price: null };
  }

  /* ---------------- image extraction ---------------- */

  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  async function findImageBoxes(page) {
    const OPS = pdfjsLib.OPS;
    const ops = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const boxes = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      const args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args && args[0]) ctm = mul(ctm, args[0]);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintJpegXObject) {
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        boxes.push({ x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) });
      }
    }
    return boxes;
  }

  /** Remove the baked-in "NOTE: Renderings are artistic…" text block in the top-left, then trim whitespace. */
  function cleanAndTrim(canvas) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, W, H).data;
    const isInk = (x, y) => {
      const k = (y * W + x) * 4;
      return data[k] < 235 || data[k + 1] < 235 || data[k + 2] < 235;
    };
    // 1) note block: in the left 45%, find first ink rows from the top followed by a blank gap.
    const xLim = Math.floor(W * 0.45);
    const rowHasInk = (y, x0, x1) => {
      for (let x = x0; x < x1; x += 1) if (isInk(x, y)) return true;
      return false;
    };
    let first = -1;
    for (let y = 0; y < H * 0.35; y++) if (rowHasInk(y, 0, xLim)) { first = y; break; }
    if (first >= 0) {
      let blank = 0, end = -1;
      const gapNeed = Math.max(6, Math.round(H * 0.025));
      for (let y = first; y < H * 0.45; y++) {
        if (rowHasInk(y, 0, xLim)) blank = 0;
        else if (++blank >= gapNeed) { end = y; break; }
      }
      // Only treat as text if the block is short (text-like), not the boat itself.
      if (end > 0 && end - first < H * 0.3) {
        // find right edge of the block to avoid erasing the boat
        let right = 0;
        for (let y = first; y < end; y++) for (let x = xLim - 1; x > right; x--) if (isInk(x, y)) { right = x; break; }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, Math.min(W, right + 4), end);
      }
    }
    // 2) trim whitespace
    const d2 = ctx.getImageData(0, 0, W, H).data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const k = (y * W + x) * 4;
        if (d2[k] < 240 || d2[k + 1] < 240 || d2[k + 2] < 240) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas;
    const pad = Math.round(Math.max(maxX - minX, maxY - minY) * 0.015);
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  async function extractProfileImage(page, headerBase) {
    const boxes = await findImageBoxes(page);
    const view = page.view; // [x1,y1,x2,y2]
    const pageH = view[3] - view[1];
    const cands = boxes
      .map((b) => ({ ...b, w: b.x2 - b.x1, h: b.y2 - b.y1, top: pageH - b.y2 }))
      .filter((b) => b.w > 60 && b.h > 30 && b.w / b.h >= 1.3 && b.w / b.h <= 5 && b.top > headerBase - 2);
    if (!cands.length) return null;
    cands.sort((a, b) => b.w * b.h - a.w * a.h);
    const box = cands[0];
    const targetW = 2000;
    const scale = Math.min(12, targetW / box.w);
    const viewport = page.getViewport({ scale });
    const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle([box.x1, box.y1, box.x2, box.y2]);
    const rx = Math.min(vx1, vx2) + 1, ry = Math.min(vy1, vy2) + 1;
    const rw = Math.floor(Math.abs(vx2 - vx1)) - 2, rh = Math.floor(Math.abs(vy2 - vy1)) - 2;
    const canvas = document.createElement('canvas');
    canvas.width = rw;
    canvas.height = rh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, rw, rh);
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -rx, -ry], background: 'white', intent: 'print' }).promise;
    const trimmed = cleanAndTrim(canvas);
    return { dataUrl: trimmed.toDataURL('image/jpeg', 0.92), width: trimmed.width, height: trimmed.height };
  }

  /* ---------------- main parse ---------------- */

  const SPEC_KEYS = [
    ['loa', /^LOA\b|length overall/i],
    ['pontoonLength', /^pontoon length/i],
    ['deckLength', /^deck length/i],
    ['beam', /^beam/i],
    ['engine', /^engine\b/i],
    ['fuel', /^fuel/i],
    ['capacity', /^(person )?capacity\b/i],
    ['hullWeight', /^hull weight|^dry weight|^weight/i],
    ['maxHp', /^max\.? ?hp|^maximum hp/i],
    ['gauge', /^pontoon gauge|^gauge/i],
    ['pontoonDiameter', /^pontoon diameter|^tube diameter/i],
    ['specUnits', /^spec\/capacity/i],
  ];

  async function parseQuote(arrayBuffer, onProgress) {
    const progress = onProgress || (() => {});
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const warnings = [];
    const pages = [];

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const pageH = page.view[3] - page.view[1];
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const h = Math.abs(it.transform[3]) || it.height || 0;
        if (h < MIN_TEXT_HEIGHT) continue;
        const x = it.transform[4];
        const base = pageH - it.transform[5];
        items.push({ str: it.str, x, base, top: base - h, h, w: it.width });
      }
      pages.push({ page, items, lines: groupLines(items) });
      progress('read', p / pdf.numPages);
    }

    const allText = pages.map((pg) => pg.lines.map((l) => l.text).join('\n')).join('\n');
    if (!pages.some((pg) => pg.items.length)) {
      throw new Error('This PDF has no readable text. Please upload the original quote exported from the Bennington boat builder (not a scan or photo).');
    }

    // ---- header: "2027 22SSB | QUOTE SQOLN001057-1 | Date: 08/14/2026"
    let boatName = '', quoteNo = '', date = '';
    for (const pg of pages) {
      const hl = pg.lines.find((l) => /\|\s*QUOTE/i.test(l.text));
      pg.headerBase = hl ? hl.base : null;
      if (hl && !boatName) {
        const m = hl.text.match(/^(.*?)\s*\|\s*QUOTE\s*([^|]+?)\s*(?:\|\s*Date:\s*(.+))?$/i);
        if (m) { boatName = clean(m[1]); quoteNo = clean(m[2]); date = clean(m[3] || ''); }
      }
      const fl = pg.lines.find((l) => /^All prices found on/i.test(l.text));
      pg.footerTop = fl ? fl.top : Infinity;
      // drop header/footer/page numbers
      pg.body = pg.lines.filter((l) => (pg.headerBase == null || l.base > pg.headerBase + 1) && l.top < pg.footerTop - 0.5 && !/^Page \d+ of \d+$/i.test(l.text) && !/^Customer Quote$/i.test(l.text));
    }
    if (!boatName) {
      const m = allText.match(/(\d{4}\s+[A-Z0-9]{2,}[A-Z0-9 \-]*?)\s*\|/);
      if (m) boatName = clean(m[1]);
      else warnings.push('Could not find the boat name in the quote header.');
    }

    // ---- columns: split at "Build Details:" x
    const p1 = pages[0];
    const bdLine = p1.lines.find((l) => /Build Details/i.test(l.text));
    let bdItem = null;
    if (bdLine) bdItem = bdLine.items.find((i) => /Build Details/i.test(i.str));
    let split = bdItem ? bdItem.x - 6 : null;
    if (split == null) {
      split = (p1.page.view[2] - p1.page.view[0]) / 2;
      warnings.push('Could not find the "Build Details" section; layout was estimated.');
    }
    const colItems = (pg, side) => pg.items.filter((i) => (side === 'L' ? i.x < split : i.x >= split) && (pg.headerBase == null || i.base > pg.headerBase + 1) && i.top < pg.footerTop - 0.5);

    // ---- page 1 left column: summary + specs
    const summary = {};
    const specs = {};
    const specsRaw = [];
    let section = '';
    const leftLines = groupLines(colItems(p1, 'L'));
    for (const ln of leftLines) {
      const t = ln.text;
      if (/^Build Summary/i.test(t)) { section = 'summary'; continue; }
      if (/^Boat Information/i.test(t)) { section = 'info'; continue; }
      if (/^Performance Package Specs/i.test(t)) { section = 'perf'; continue; }
      if (/^(Dealer Info|Dealer PO)/i.test(t)) { section = ''; continue; }
      if (section === 'summary') {
        const sp = splitPrice(ln);
        if (sp.price != null) {
          const k = sp.desc.replace(/:$/, '').trim();
          if (/^Base Boat/i.test(k)) summary.base = sp.price;
          else if (/^Engine/i.test(k)) summary.enginePrerig = sp.price;
          else if (/^Additional/i.test(k)) summary.additional = sp.price;
          else if (/^Total Boat MSRP/i.test(k)) summary.total = sp.price;
          else if (/^Total Boat Sale/i.test(k)) summary.sale = sp.price;
          else if (/^Full Deal/i.test(k)) summary.fullDeal = sp.price;
        }
      } else if (section === 'info' || section === 'perf') {
        let key, value;
        const firstItem = ln.items[0];
        const rest = ln.items.slice(1);
        if (firstItem.str.includes(':') && !rest.length) {
          const idx = firstItem.str.indexOf(':');
          key = firstItem.str.slice(0, idx); value = firstItem.str.slice(idx + 1);
        } else {
          // label = items before the largest x gap
          let gapIdx = 0, gap = -1;
          for (let i = 1; i < ln.items.length; i++) {
            const prev = ln.items[i - 1];
            const g = ln.items[i].x - (prev.x + (prev.w || 0));
            if (g > gap) { gap = g; gapIdx = i; }
          }
          key = ln.items.slice(0, gapIdx || 1).map((i) => i.str).join(' ');
          value = ln.items.slice(gapIdx || 1).map((i) => i.str).join(' ');
        }
        key = clean(key).replace(/:$/, '');
        value = clean(value);
        if (!key) continue;
        specsRaw.push({ key, value, section });
        for (const [name, re] of SPEC_KEYS) if (re.test(key) && specs[name] == null) { specs[name] = value; break; }
      }
    }
    if (summary.total == null) warnings.push('Could not find "Total Boat MSRP" in the Build Summary.');

    // ---- line-item stream + standards
    const stream = [];
    pages.forEach((pg, idx) => {
      const pushCol = (side) => {
        let lines = groupLines(colItems(pg, side));
        if (idx === 0) {
          if (side === 'L') return;
          const hi = lines.findIndex((l) => /^Description\b/i.test(l.text) && /MSRP/i.test(l.text));
          const bi = lines.findIndex((l) => /Build Details/i.test(l.text));
          const start = hi >= 0 ? hi + 1 : bi >= 0 ? bi + 1 : lines.length;
          lines = lines.slice(start);
        }
        stream.push(...lines);
      };
      pushCol('L');
      pushCol('R');
    });

    const items = [];
    const stdLines = [];
    let inStd = false;
    let cur = null;
    for (const ln of stream) {
      if (!inStd && /^Standard Features/i.test(ln.text)) { inStd = true; cur = null; continue; }
      if (inStd) { stdLines.push(ln.text); continue; }
      if (/^Description\b.*MSRP$/i.test(ln.text)) continue;
      const sp = splitPrice(ln);
      if (sp.price != null) {
        cur = { desc: sp.desc, price: sp.price };
        items.push(cur);
      } else if (cur) {
        cur.desc = joinWrapped(cur.desc, ln.text);
      }
    }
    items.forEach((it, i) => { it.desc = clean(it.desc); it.id = 'i' + i; it.order = i; });
    if (!items.length) warnings.push('No priced line items were found under "Build Details".');

    // ---- standards: sections start on lines beginning with "Label:"
    const standards = [];
    for (const raw of stdLines) {
      const t = raw.replace(/●/g, '•');
      const m = t.match(/^([A-Z][A-Za-z &\/\-]{1,28}):\s*(.*)$/);
      if (m) standards.push({ label: m[1], text: m[2] });
      else if (standards.length) standards[standards.length - 1].text = joinWrapped(standards[standards.length - 1].text, t);
      else standards.push({ label: '', text: t });
    }
    standards.forEach((s) => {
      s.text = clean(s.text).replace(/\s*•\s*/g, ' • ').replace(/^•\s*|\s*•$/g, '');
    });

    progress('image', 0);
    let image = null;
    try {
      image = await extractProfileImage(p1.page, p1.headerBase || 0);
    } catch (e) {
      console.warn('Image extraction failed', e);
    }
    if (!image) warnings.push('No side-profile rendering was found on page 1 — a placeholder will be used.');

    return { boatName, quoteNo, date, summary, specs, specsRaw, items, standards, image, warnings, pageCount: pdf.numPages };
  }

  MSRP.parseQuote = parseQuote;
})();
