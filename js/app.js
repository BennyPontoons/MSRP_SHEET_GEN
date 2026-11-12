/* ============================================================
 * app.js — UI controller: upload → parse → review → download.
 * ============================================================ */
(function () {
  'use strict';
  const MSRP = (window.MSRP = window.MSRP || {});
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const state = { quote: null, model: null, images: { profile: null, layout: null }, blobUrl: null, fileBase: 'MSRP_Sheet', gen: 0 };
  MSRP.state = state;

  /* ---------------- view switching ---------------- */
  function show(view) {
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }
  function procStep(step) {
    const order = ['read', 'sort', 'build'];
    const idx = order.indexOf(step);
    $$('.proc-steps li').forEach((li) => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle('is-done', i < idx);
      li.classList.toggle('is-active', i === idx);
    });
    $('#procTitle').textContent = ['Reading your quote…', 'Sorting the build…', 'Laying out your sheet…'][idx] || 'Working…';
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2600);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => MSRP.fmtMoney(c);
  const tick = () => new Promise((r) => setTimeout(r, 30));

  /* ---------------- file intake ---------------- */
  async function handleFile(file) {
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (!isPdf) return fail('That file isn’t a PDF. Please upload the Customer Quote PDF exported from the Bennington boat builder.');
    show('processing');
    procStep('read');
    try {
      const buf = await file.arrayBuffer();
      const quote = await MSRP.parseQuote(buf);
      if (!quote.items.length) throw new Error('No line items were found. Make sure this is a Bennington Customer Quote with a “Build Details” section.');
      procStep('sort');
      await tick();
      state.quote = quote;
      MSRP.categorize(quote);
      state.images = { profile: quote.image, layout: null };
      $('#boatName').value = quote.boatName || '';
      state.fileBase = (quote.boatName || 'Bennington').replace(/[^\w\-]+/g, '_') + '_MSRP_Sheet';
      procStep('build');
      await MSRP.loadAssets();
      renderPanel();
      show('review');
      await regenerate();
    } catch (e) {
      console.error(e);
      fail(e && e.message ? e.message : 'Something went wrong while reading the PDF.');
    }
  }
  function fail(msg) {
    $('#errorMsg').textContent = msg;
    show('error');
  }
  function reset() {
    state.quote = null;
    state.model = null;
    if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = null;
    $('#fileInput').value = '';
    $('#downloadBtn').disabled = true;
    show('idle');
  }

  /* ---------------- model + panel ---------------- */
  function currentModel() {
    const q = state.quote;
    const name = $('#boatName').value.trim() || q.boatName;
    const model = MSRP.buildModel({ ...q, boatName: name });
    model.boatName = name;
    model.specs = q.specs;
    model.standards = q.standards;
    model.images = state.images;
    return model;
  }

  const MOVE_TARGETS = [
    ['base', 'Base boat'],
    ['styling', 'Styling'],
    ['perf', 'Performance'],
    ['engine', 'Engine'],
    ['prerig', 'Pre-rig'],
    ['rigging', 'Engine rigging'],
    ['options', 'Options'],
    ['hidden', 'Don’t show (only $0 items)'],
  ];

  function renderPanel() {
    const q = state.quote;
    const m = (state.model = currentModel());
    $('#quoteMeta').textContent = [q.quoteNo && `Quote ${q.quoteNo}`, q.date].filter(Boolean).join(' · ');

    // pricing / reconciliation
    const b = m.buckets;
    $('#buckets').innerHTML = `
      <dt>Base Boat</dt><dd>${money(b.base)}</dd>
      <dt>Engine &amp; Performance Package</dt><dd>${money(b.enginePerf)}</dd>
      <dt>Styling &amp; Options</dt><dd>${money(b.stylingOptions)}</dd>
      <dt class="total">Total MSRP</dt><dd class="total">${money(m.total)}</dd>`;
    const badge = $('#reconBadge');
    badge.className = 'badge ' + (m.reconcile.ok ? 'badge--ok' : 'badge--bad');
    badge.textContent = m.reconcile.ok ? 'Reconciled to the penny' : 'Needs attention';
    $('#checks').innerHTML = m.reconcile.checks
      .map((c) => {
        let label = c.label;
        if (!c.ok && c.delta) label += ` (off by ${money(Math.abs(c.delta))})`;
        if (c.label.startsWith('Line items match') && c.ok) label += ` — ${money(m.reconcile.quoteTotal)}`;
        return `<li class="${c.ok ? '' : 'bad'} ${c.info ? 'info' : ''}">${esc(label)}</li>`;
      })
      .join('');

    // groups
    const groups = [
      ['Base Boat', m.base, b.base],
      ['Styling', m.styling],
      ['Performance', m.performance],
      ['Options', m.options],
    ];
    const itemById = Object.fromEntries(q.items.map((i) => [i.id, i]));
    $('#groups').innerHTML = groups
      .map(([title, rows]) => {
        const sum = rows.reduce((s, r) => s + r.price, 0);
        const body = rows.length
          ? rows
              .map((r) => {
                const it = itemById[r.id];
                const opts = MOVE_TARGETS.filter(([k]) => k !== 'hidden' || it.price === 0)
                  .map(([k, l]) => `<option value="${k}" ${it.cat === k ? 'selected' : ''}>${esc(l)}</option>`)
                  .join('');
                return `<div class="line">
                  <div class="line__label ${r.sub ? 'is-sub' : ''}" title="${esc(it.desc)}">${esc(r.label)}</div>
                  <div class="line__price ${r.price === 0 ? 'is-zero' : ''}">${r.price === 0 ? 'Included' : money(r.price)}</div>
                  <select data-item="${r.id}" aria-label="Section for ${esc(r.label)}">${opts}</select>
                </div>`;
              })
              .join('')
          : `<div class="empty">Nothing selected in this section.</div>`;
        return `<div class="group"><div class="group__head"><span>${title}</span><b>${money(sum)}</b></div>${body}</div>`;
      })
      .join('');

    // hidden ($0) items
    $('#hiddenCount').textContent = m.hidden.length;
    $('#hiddenList').innerHTML = m.hidden
      .map((it) => `<li><span>${esc(it.desc)}</span><button type="button" data-show="${it.id}">Show in options</button></li>`)
      .join('');

    // images
    setThumb('#thumbProfile', state.images.profile, 'No image');
    setThumb('#thumbLayout', state.images.layout, 'Placeholder');
    $('#profileNote').textContent = state.images.profile ? (state.images.profileCustom ? 'Custom image' : 'Pulled from the quote') : 'Not found in quote';
    $('#layoutNote').textContent = state.images.layout ? 'Custom image' : 'Placeholder for now';

    // warnings
    $('#warnings').innerHTML = (q.warnings || []).map((w) => `<p>${esc(w)}</p>`).join('');
    $('#previewTitle').textContent = `${m.boatName} · MSRP Sheet`;
  }

  function setThumb(sel, img, emptyText) {
    const el = $(sel);
    if (img) {
      el.style.backgroundImage = `url(${img.dataUrl})`;
      el.classList.remove('is-empty');
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.classList.add('is-empty');
      el.textContent = emptyText;
    }
  }

  /* ---------------- generation + preview ---------------- */
  async function regenerate() {
    if (!state.quote) return;
    const gen = ++state.gen;
    const paper = $('#paper');
    paper.classList.add('is-busy');
    $('#downloadBtn').disabled = true;
    try {
      const model = currentModel();
      state.model = model;
      const res = await MSRP.buildSheet(model);
      if (gen !== state.gen) return;
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = URL.createObjectURL(res.blob);
      state.fileBase = (model.boatName || 'Bennington').replace(/[^\w\-]+/g, '_') + '_MSRP_Sheet';
      await renderPreview(res.blob, gen);
      $('#previewMeta').textContent = `11 × 17 in · 1 page · ${Math.round(res.blob.size / 1024)} KB` + (res.overflow ? ' · ⚠ content was too long to fit fully' : '');
      $('#downloadBtn').disabled = false;
      MSRP.last = { quote: state.quote, model, result: res, blobUrl: state.blobUrl };
    } catch (e) {
      console.error(e);
      toast('Could not build the sheet: ' + (e.message || e));
    } finally {
      if (gen === state.gen) paper.classList.remove('is-busy');
    }
  }

  async function renderPreview(blob, gen) {
    const buf = await blob.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);
    if (gen !== state.gen) return;
    const canvas = $('#previewCanvas');
    const cssW = canvas.parentElement.clientWidth || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (cssW * dpr) / base.width });
    const off = document.createElement('canvas');
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    // intent 'print' avoids requestAnimationFrame, so rendering continues in background tabs
    await page.render({ canvasContext: off.getContext('2d'), viewport, intent: 'print' }).promise;
    if (gen !== state.gen) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
  }

  function download() {
    if (!state.blobUrl) return;
    const a = document.createElement('a');
    a.href = state.blobUrl;
    a.download = state.fileBase + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('MSRP sheet downloaded');
  }

  /* ---------------- images ---------------- */
  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxW = 2400;
        const r = Math.min(1, maxW / img.naturalWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * r);
        c.height = Math.round(img.naturalHeight * r);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ dataUrl: c.toDataURL('image/jpeg', 0.92), width: c.width, height: c.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unsupported image')); };
      img.src = url;
    });
  }

  /* ---------------- events ---------------- */
  let nameTimer;
  function bind() {
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    const dz = $('#dropzone');
    const input = $('#fileInput');
    input.addEventListener('change', () => handleFile(input.files[0]));
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

    // whole-window drag & drop
    let depth = 0;
    const overlay = $('#dragOverlay');
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; dz.classList.add('is-over'); if (!$('.view--idle').classList.contains('is-active')) overlay.classList.add('is-on'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { dz.classList.remove('is-over'); overlay.classList.remove('is-on'); } });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dz.classList.remove('is-over');
      overlay.classList.remove('is-on');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/') && state.quote) {
        // dropping an image while reviewing fills the overhead layout slot
        readImage(f).then((img) => { state.images.layout = img; renderPanel(); regenerate(); toast('Overhead layout image added'); });
        return;
      }
      handleFile(f);
    });

    document.addEventListener('click', (e) => {
      const act = e.target.closest('[data-action]');
      if (act && act.dataset.action === 'reset') reset();
      const showBtn = e.target.closest('[data-show]');
      if (showBtn) {
        const it = state.quote.items.find((i) => i.id === showBtn.dataset.show);
        if (it) { it.cat = 'options'; renderPanel(); regenerate(); }
      }
    });
    $('#downloadBtn').addEventListener('click', download);
    $('#editToggle').addEventListener('click', (e) => {
      const on = $('#groups').classList.toggle('is-editing');
      e.currentTarget.setAttribute('aria-pressed', String(on));
      e.currentTarget.textContent = on ? 'Done' : 'Edit sections';
    });

    $('#groups').addEventListener('change', (e) => {
      const sel = e.target.closest('select[data-item]');
      if (!sel) return;
      const it = state.quote.items.find((i) => i.id === sel.dataset.item);
      if (!it) return;
      it.cat = sel.value;
      renderPanel();
      regenerate();
    });

    $('#boatName').addEventListener('input', () => {
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => { renderPanel(); regenerate(); }, 450);
    });

    $$('input[data-image]').forEach((inp) =>
      inp.addEventListener('change', async () => {
        const f = inp.files[0];
        if (!f) return;
        try {
          const img = await readImage(f);
          state.images[inp.dataset.image] = img;
          if (inp.dataset.image === 'profile') state.images.profileCustom = true;
          renderPanel();
          regenerate();
        } catch (err) {
          toast('That image could not be read.');
        }
        inp.value = '';
      })
    );

    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (state.blobUrl && state.quote) regenerate(); }, 300);
    });

    // test / demo hook: ?sample=path/to/quote.pdf
    const sample = new URLSearchParams(location.search).get('sample');
    if (sample && /^[\w\-\/]+\.pdf$/i.test(sample)) {
      fetch(sample).then((r) => r.blob()).then((b) => handleFile(new File([b], sample.split('/').pop(), { type: 'application/pdf' })));
    }
  }

  MSRP.handleFile = handleFile;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
