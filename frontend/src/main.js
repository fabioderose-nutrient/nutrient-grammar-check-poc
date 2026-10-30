import { createDocAuthSystem } from '@nutrient-sdk/document-authoring';

const SAMPLE_TEXT = `Dear Mr. Johnson,

Thank you for your interest in our product. We are writing to inform you that your recent application has been recieved and is currently under review.

In order to accomodate your request, we have assigned a dedicated team to handle your case. The team will definately reach out to you within the next few business days.

Please note that teh process may take longer then expected due to the fact that we are experiencing a very unique surge in applications at this point in time.

We would also like to utilize this opportunity to remind you that all documents should of been submitted by the original deadline. If you could of sent them earlier, it would have expedited the process.

Their is no need to worry about the status of your request. Its a standard procedure and we assure you that your a valued client.

We look forward to working with you and will keep you updated on any developments. If you have any questions, please do not hesitate to contact us.

Best regards,
Sarah Williams
Customer Relations Manager`;

const COLORS = {
  spelling: { bg: '#fce4e4', flash: '#f87171' },
  grammar:  { bg: '#fef3c7', flash: '#fbbf24' },
  style:    { bg: '#dbeafe', flash: '#60a5fa' },
};

let docAuthSystem, editor, doc;
let issues = [];
let activeIdx = null;
let coordData = null;   // PDF extraction result for hit-testing
let pageScreenRect = null; // cached page position on screen
let pagePdfSize = null;    // { w, h } in PDF points

// ────────────────────────────
// Boot
// ────────────────────────────
async function boot() {
  status('Loading…');
  docAuthSystem = await createDocAuthSystem();
  doc = await docAuthSystem.createDocumentFromPlaintext(SAMPLE_TEXT);
  editor = await docAuthSystem.createEditor(
    document.getElementById('editor-container'),
    { document: doc },
  );
  status('');
  document.getElementById('btn-check').onclick = check;
  document.getElementById('btn-clear').onclick = clearAll;

}

// ────────────────────────────
// Grammar check pipeline
// ────────────────────────────
async function check() {
  const btn = document.getElementById('btn-check');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Checking';
  await clearAll();

  try {
    status('Reading document…');
    const text = await readAllText();

    status('Analysing…');
    const grammarRes = await fetch('/api/grammar-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!grammarRes.ok) throw new Error('Grammar service ' + grammarRes.status);
    issues = (await grammarRes.json()).issues;

    status('Marking…');
    await annotateIssues();

    status('Mapping positions…');
    const pdfBuf = await doc.exportPDF();
    const coordRes = await fetch('/api/extract-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBuf,
    });
    if (!coordRes.ok) throw new Error('Coord extraction ' + coordRes.status);
    coordData = await coordRes.json();

    // Pre-compute screen-space hit rects for each issue
    computeIssueScreenRects();
    setupEditorHover();

    renderSidebar();
    status('');
  } catch (e) {
    console.error(e);
    status('Error — see console');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Check';
  }
}

// ────────────────────────────
// Text extraction
// ────────────────────────────
async function readAllText() {
  let out = '';
  await doc.transaction(async ({ draft }) => {
    for (const s of draft.body().sections())
      for (const bl of s.content().blocklevels())
        if (bl.type === 'paragraph') out += bl.asTextView().getPlainText() + '\n';
    return { commit: false };
  });
  return out.trimEnd();
}

// ────────────────────────────
// Annotate (highlight + underline)
// ────────────────────────────
async function annotateIssues() {
  await doc.transaction(async ({ draft }) => {
    const sections = draft.body().sections();
    for (const issue of issues) {
      const col = (COLORS[issue.category] || COLORS.style).bg;
      let found = false;
      for (const s of sections) {
        if (found) break;
        for (const bl of s.content().blocklevels()) {
          if (bl.type !== 'paragraph') continue;
          const tv = bl.asTextView();
          const hit = tv.searchText(issue.text);
          if (hit) {
            tv.setFormatting({ highlight: col, underline: true }, hit.range);
            found = true;
            break;
          }
        }
      }
    }
    return { commit: true };
  });
}

// ────────────────────────────
// Flash a single issue's highlight brighter (on hover)
// ────────────────────────────
async function flashIssue(idx) {
  const issue = issues[idx];
  if (!issue) return;
  const flash = (COLORS[issue.category] || COLORS.style).flash;
  await doc.transaction(async ({ draft }) => {
    for (const s of draft.body().sections())
      for (const bl of s.content().blocklevels()) {
        if (bl.type !== 'paragraph') continue;
        const tv = bl.asTextView();
        const hit = tv.searchText(issue.text);
        if (hit) {
          tv.setFormatting({ highlight: flash }, hit.range);
          return { commit: true };
        }
      }
    return { commit: false };
  });
}

async function unflashIssue(idx) {
  const issue = issues[idx];
  if (!issue) return;
  const bg = (COLORS[issue.category] || COLORS.style).bg;
  await doc.transaction(async ({ draft }) => {
    for (const s of draft.body().sections())
      for (const bl of s.content().blocklevels()) {
        if (bl.type !== 'paragraph') continue;
        const tv = bl.asTextView();
        const hit = tv.searchText(issue.text);
        if (hit) {
          tv.setFormatting({ highlight: bg }, hit.range);
          return { commit: true };
        }
      }
    return { commit: false };
  });
}

// ────────────────────────────
// Strip all annotations
// ────────────────────────────
async function stripAnnotations() {
  await doc.transaction(async ({ draft }) => {
    for (const s of draft.body().sections())
      for (const bl of s.content().blocklevels()) {
        if (bl.type !== 'paragraph') continue;
        const tv = bl.asTextView();
        const all = tv.searchText(/.+/s);
        if (all) tv.setFormatting({ highlight: null, underline: null }, all.range);
      }
    return { commit: true };
  });
}

// ────────────────────────────
// Apply a fix
// ────────────────────────────
async function applyFix(idx) {
  const issue = issues[idx];
  let n = 0;
  await doc.transaction(async ({ draft }) => {
    for (const s of draft.body().sections()) {
      n += s.content().replaceText(issue.text, issue.suggestion);
      if (n) break;
    }
    return { commit: true };
  });
  if (n) {
    markCardFixed(idx);
    status(`"${issue.text}" → "${issue.suggestion}"`);
  }
}

// ────────────────────────────
// Hit-testing: map pointer position → issue index
// ────────────────────────────
// We store per-issue rects in PDF points, then convert to screen on the fly.
let issueRects = []; // [{ idx, pdfL, pdfT, pdfR, pdfB, pageW, pageH }]

function computeIssueScreenRects() {
  issueRects = [];
  if (!coordData) return;

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    for (const page of coordData.pages) {
      const rects = findWordRects(issue.text, page);
      if (!rects.length) continue;
      const merged = rects.reduce((a, r) => ({
        l: Math.min(a.l, r.l), t: Math.min(a.t, r.t),
        r: Math.max(a.r, r.r), b: Math.max(a.b, r.b),
      }), { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity });

      issueRects.push({
        idx: i,
        pdfL: merged.l, pdfT: merged.t,
        pdfR: merged.r, pdfB: merged.b,
        pageW: page.width, pageH: page.height,
      });
      break;
    }
  }
  console.log(`[grammar] Computed ${issueRects.length} issue rects from PDF coords`);
}

function hitTest(screenX, screenY) {
  // We need to know where the page is rendered on screen.
  // Calibrate by finding the page element.
  const pageEl = findPageElement();
  if (!pageEl) return -1;
  const pr = pageEl.getBoundingClientRect();

  for (const ir of issueRects) {
    const sx = pr.width / ir.pageW;
    const sy = pr.height / ir.pageH;

    // PDF→screen: x is straightforward, y is flipped (PDF y=0 is bottom)
    const left   = pr.left + ir.pdfL * sx;
    const top    = pr.top  + (ir.pageH - ir.pdfB) * sy;
    const right  = pr.left + ir.pdfR * sx;
    const bottom = pr.top  + (ir.pageH - ir.pdfT) * sy;

    // Add a small padding for easier hovering
    const pad = 4;
    if (screenX >= left - pad && screenX <= right + pad &&
        screenY >= top - pad && screenY <= bottom + pad) {
      return ir.idx;
    }
  }
  return -1;
}

function findPageElement() {
  const container = document.getElementById('editor-container');
  // Try canvas first (Nutrient may render to canvas)
  const canvas = container.querySelector('canvas');
  if (canvas) return canvas;
  // Otherwise the first large child
  for (const el of container.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 200 && r.height > 200 && el !== container) return el;
  }
  return container;
}

// ────────────────────────────
// Editor hover via pointermove
// ────────────────────────────
let editorHoverSetUp = false;

function setupEditorHover() {
  if (editorHoverSetUp) return;
  editorHoverSetUp = true;

  const container = document.getElementById('editor-container');
  container.addEventListener('pointermove', (e) => {
    if (!issueRects.length) return;
    const idx = hitTest(e.clientX, e.clientY);
    if (idx >= 0) {
      doHighlight(idx);
    } else if (activeIdx !== null) {
      doUnhighlight();
    }
  });
  container.addEventListener('pointerleave', () => {
    if (activeIdx !== null) doUnhighlight();
  });
}

// ────────────────────────────
// Bidirectional highlight (same visual for both directions)
// ────────────────────────────
let flashPending = false;

function doHighlight(idx) {
  if (activeIdx === idx) return;
  doUnhighlight();
  activeIdx = idx;

  const cat = issues[idx]?.category || 'style';
  const ring = (COLORS[cat] || COLORS.style).flash;

  // Sidebar card
  const card = document.querySelector(`.issue-card[data-idx="${idx}"]`);
  if (card) {
    card.classList.add('linked');
    card.style.borderLeftColor = ring;
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // Flash the highlight in the editor to a brighter colour
  if (!flashPending) {
    flashPending = true;
    flashIssue(idx).finally(() => { flashPending = false; });
  }
}

function doUnhighlight() {
  if (activeIdx === null) return;
  const prevIdx = activeIdx;
  activeIdx = null;

  const card = document.querySelector(`.issue-card[data-idx="${prevIdx}"]`);
  if (card) {
    card.classList.remove('linked');
    card.style.borderLeftColor = '';
  }

  // Revert highlight
  if (!flashPending) {
    flashPending = true;
    unflashIssue(prevIdx).finally(() => { flashPending = false; });
  }
}

// ────────────────────────────
// Word-rect lookup from PDF coordinate data
// ────────────────────────────
function findWordRects(text, page) {
  const words = page.words;
  if (!words?.length) return [];

  let built = '';
  const map = [];
  for (let i = 0; i < words.length; i++) {
    if (built.length && words[i].text !== ' ') built += ' ';
    map.push({ s: built.length, e: built.length + words[i].text.length, i });
    built += words[i].text;
  }

  const pos = built.toLowerCase().indexOf(text.toLowerCase());
  if (pos < 0) return [];
  const end = pos + text.length;

  const rects = [];
  for (const m of map) {
    if (m.e > pos && m.s < end) {
      const w = words[m.i];
      rects.push({
        l: Math.min(w.x1, w.x4),
        t: Math.min(w.y1, w.y2),
        r: Math.max(w.x2, w.x3),
        b: Math.max(w.y3, w.y4),
      });
    }
  }
  return rects;
}

// ────────────────────────────
// Sidebar
// ────────────────────────────
function renderSidebar() {
  const list = document.getElementById('issues-list');
  document.getElementById('issue-count').textContent = issues.length || '';

  if (!issues.length) {
    list.innerHTML = '<p class="placeholder">No issues found.</p>';
    return;
  }

  list.innerHTML = '';
  issues.forEach((issue, i) => {
    const card = document.createElement('div');
    card.className = 'issue-card';
    card.dataset.idx = i;
    card.innerHTML =
      `<span class="issue-badge ${issue.category}">${issue.category}</span>` +
      `<div class="issue-msg">${esc(issue.message)}</div>` +
      `<div class="issue-found"><strong>${esc(issue.text)}</strong></div>` +
      `<span class="issue-fix">${esc(issue.suggestion)}</span>`;

    card.addEventListener('pointerenter', () => doHighlight(i));
    card.addEventListener('pointerleave', () => doUnhighlight());
    card.querySelector('.issue-fix').addEventListener('click', e => {
      e.stopPropagation();
      applyFix(i);
    });

    list.appendChild(card);
  });
}

function markCardFixed(idx) {
  document.querySelectorAll(`.issue-card[data-idx="${idx}"]`).forEach(card => {
    card.classList.add('fixed');
    const fix = card.querySelector('.issue-fix');
    if (fix) fix.textContent = 'Fixed';
  });
}

// ────────────────────────────
// Clear
// ────────────────────────────
async function clearAll() {
  doUnhighlight();
  coordData = null;
  issueRects = [];
  if (issues.length) await stripAnnotations();
  issues = [];
  document.getElementById('issues-list').innerHTML =
    '<p class="placeholder">Press <strong>Check</strong> to scan the document.</p>';
  document.getElementById('issue-count').textContent = '';
  status('');
}

// ────────────────────────────
function status(msg) { document.getElementById('status').textContent = msg; }
function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

boot().catch(e => {
  console.error(e);
  document.getElementById('editor-container').innerHTML =
    `<div style="padding:32px;color:#b91c1c"><b>Failed to load editor</b><br>${e.message}</div>`;
});
