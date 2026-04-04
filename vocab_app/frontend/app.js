const API = '';
const POS_LIST = [
  "Noun","Verb","Adjective","Adverb","Conjunction",
  "Expression","Particle","Interjection","Counter","Determiner",
];

// ── Logger ────────────────────────────────────────────────────
function log(module, ...args) {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`${time} [${module}]`, ...args);
}

// ── Toast ─────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast-${type}`;
  el.style.display = 'block';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

// ── Log active Gemini model on load ───────────────────────────
fetch(`${API}/api/info`)
  .then(r => r.json())
  .then(d => log('Gemini', `Active model → ${d.model}`))
  .catch(err => console.error('[Info]', err));

// ── Tab switching ──────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.panel).classList.add('active');
    log('Tab', `Switched to → ${btn.textContent.trim()}`);
    if (btn.dataset.panel === 'panel-stats') loadStats();
  });
});

// ── File input labels ──────────────────────────────────────────
function fileLabel(inputId, labelId) {
  document.getElementById(inputId).addEventListener('change', e => {
    const files = e.target.files;
    document.getElementById(labelId).textContent =
      files.length === 0 ? 'Choose file(s)…'
      : files.length === 1 ? files[0].name
      : `${files.length} files selected`;
  });
}
fileLabel('pdf-input',   'pdf-file-name');
fileLabel('image-input', 'image-file-name');
document.getElementById('csv-input').addEventListener('change', e => {
  document.getElementById('csv-file-name').textContent =
    e.target.files[0]?.name || 'Choose a CSV file…';
});

// ── SSE streaming helper ───────────────────────────────────────
async function streamProcess(url, formData, onProgress, onDone, onError) {
  try {
    const res = await fetch(url, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Server error' }));
      onError(err.detail || 'Server error');
      return;
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if      (event.type === 'progress') onProgress(event.message);
          else if (event.type === 'done')     onDone(event.items);
          else if (event.type === 'error')    onError(event.message);
        } catch { /* ignore parse errors */ }
      }
    }
  } catch (err) {
    onError(err.message);
  }
}

// ── Progress UI ────────────────────────────────────────────────
function showProgress(msg) {
  document.getElementById('progress-msg').textContent = msg;
  document.getElementById('progress-section').style.display = 'block';
}
function updateProgress(msg) {
  document.getElementById('progress-msg').textContent = msg;
}
function hideProgress() {
  document.getElementById('progress-section').style.display = 'none';
}

// ── Submit: text ───────────────────────────────────────────────
document.getElementById('text-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = document.getElementById('korean-text').value.trim();
  if (!text) return setStatus('text-status', 'Please enter some text.', 'error');

  log('Text', `Submitting ${text.length} chars to /api/process/text`);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setStatus('text-status', 'Sending to Gemini…');

  const body = new FormData();
  body.append('text', text);

  try {
    const res  = await fetch(`${API}/api/process/text`, { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Server error');

    const deckTag = document.getElementById('text-deck-tag').value.trim();
    log('Text', `✅ ${data.items?.length ?? 0} item(s) received — deck tag: "${deckTag || 'none'}"`);
    showReview(data.items, deckTag);
    setStatus('text-status', `${data.items.length} items ready for review.`, 'success');
  } catch (err) {
    console.error('[Text]', err);
    setStatus('text-status', `Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Submit: PDF ────────────────────────────────────────────────
document.getElementById('pdf-form').addEventListener('submit', async e => {
  e.preventDefault();
  const files = document.getElementById('pdf-input').files;
  if (!files.length) return setStatus('pdf-status', 'Please select at least one PDF.', 'error');

  log('PDF', `Submitting ${files.length} file(s): ${[...files].map(f => f.name).join(', ')}`);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  showProgress(`Preparing ${files.length} file(s)…`);
  setStatus('pdf-status', '');

  const body = new FormData();
  for (const f of files) body.append('files', f);
  const deckTag = document.getElementById('pdf-deck-tag').value.trim();

  await streamProcess(
    `${API}/api/process/pdf`, body,
    msg => { log('PDF', `Progress: ${msg}`); updateProgress(msg); },
    items => {
      log('PDF', `✅ ${items.length} item(s) received — deck tag: "${deckTag || 'none'}"`);
      hideProgress();
      showReview(items, deckTag);
      setStatus('pdf-status', `${items.length} items ready for review.`, 'success');
      btn.disabled = false;
    },
    err => {
      console.error('[PDF]', err);
      hideProgress();
      setStatus('pdf-status', `Error: ${err}`, 'error');
      btn.disabled = false;
    },
  );
});

// ── Submit: image ──────────────────────────────────────────────
document.getElementById('image-form').addEventListener('submit', async e => {
  e.preventDefault();
  const files = document.getElementById('image-input').files;
  if (!files.length) return setStatus('image-status', 'Please select at least one image.', 'error');

  log('Image', `Submitting ${files.length} image(s): ${[...files].map(f => f.name).join(', ')}`);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  showProgress(`Preparing ${files.length} image(s)…`);
  setStatus('image-status', '');

  const body = new FormData();
  for (const f of files) body.append('files', f);
  const deckTag = document.getElementById('image-deck-tag').value.trim();

  await streamProcess(
    `${API}/api/process/image`, body,
    msg => { log('Image', `Progress: ${msg}`); updateProgress(msg); },
    items => {
      log('Image', `✅ ${items.length} item(s) received — deck tag: "${deckTag || 'none'}"`);
      hideProgress();
      showReview(items, deckTag);
      setStatus('image-status', `${items.length} items ready for review.`, 'success');
      btn.disabled = false;
    },
    err => {
      console.error('[Image]', err);
      hideProgress();
      setStatus('image-status', `Error: ${err}`, 'error');
      btn.disabled = false;
    },
  );
});

// ── Submit: CSV import ─────────────────────────────────────────
document.getElementById('csv-form').addEventListener('submit', async e => {
  e.preventDefault();
  const file = document.getElementById('csv-input').files[0];
  if (!file) return setStatus('csv-status', 'Please select a CSV file.', 'error');

  log('CSV', `Importing file: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  setStatus('csv-status', 'Importing…');

  const body = new FormData();
  body.append('file', file);

  try {
    const res  = await fetch(`${API}/api/import/csv`, { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Import failed');
    log('CSV', `✅ ${data.imported} imported, ${data.duplicates} duplicate(s), ${data.errors?.length ?? 0} error(s).`);
    const errNote = data.errors?.length ? ` (${data.errors.length} row errors)` : '';
    setStatus('csv-status',
      `✅ ${data.imported} imported, ${data.duplicates} duplicates skipped.${errNote}`,
      'success',
    );
    loadHistory();
  } catch (err) {
    console.error('[CSV]', err);
    setStatus('csv-status', `Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Review table ───────────────────────────────────────────────
let reviewItems = [];

function showReview(items, deckTag = '') {
  reviewItems = items.map((item, i) => ({ ...item, _key: i }));
  document.getElementById('review-batch-tag').value = deckTag;
  document.getElementById('review-count').textContent = `${reviewItems.length} items`;
  renderReviewTable();
  const sec = document.getElementById('review-section');
  sec.style.display = 'block';
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReviewTable() {
  const tbody = document.getElementById('review-tbody');
  if (reviewItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No items to review.</td></tr>';
    return;
  }
  tbody.innerHTML = reviewItems.map((item, idx) => `
    <tr>
      <td><input type="text" value="${esc(item.korean  || '')}"
          oninput="reviewItems[${idx}].korean=this.value" /></td>
      <td><input type="text" value="${esc(item.french  || '')}"
          oninput="reviewItems[${idx}].french=this.value" /></td>
      <td><input type="text" value="${esc(item.phrase  || '')}"
          oninput="reviewItems[${idx}].phrase=this.value" /></td>
      <td>
        <select onchange="reviewItems[${idx}].part_of_speech=this.value">
          <option value="">— select —</option>
          ${POS_LIST.map(p =>
            `<option value="${p}"${item.part_of_speech===p?' selected':''}>${p}</option>`
          ).join('')}
        </select>
      </td>
      <td><input type="text" value="${esc(item.thematic_tag || '')}"
          oninput="reviewItems[${idx}].thematic_tag=this.value"
          placeholder="optional tag" /></td>
      <td><button class="btn-delete" onclick="removeReviewRow(${idx})">✕</button></td>
    </tr>`).join('');
}

function removeReviewRow(idx) {
  reviewItems.splice(idx, 1);
  document.getElementById('review-count').textContent = `${reviewItems.length} items`;
  renderReviewTable();
}

async function commitReview() {
  if (reviewItems.length === 0) return;
  const batchTag = document.getElementById('review-batch-tag').value.trim();
  log('Commit', `Committing ${reviewItems.length} item(s) — batch tag: "${batchTag || 'none'}"`);
  const btn    = document.getElementById('commit-btn');
  btn.disabled = true;
  setStatus('review-status', 'Saving to database…');

  try {
    const res  = await fetch(`${API}/api/vocabulary/commit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ items: reviewItems, thematic_tag: batchTag || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Commit failed');

    log('Commit', `✅ ${data.saved.length} saved, ${data.duplicates.length} duplicate(s).`);

    const dupNote = data.duplicates.length
      ? ` ${data.duplicates.length} duplicate(s) — see merge section below.` : '';
    setStatus('review-status',
      `✅ ${data.saved.length} word(s) saved.${dupNote}`, 'success');
    document.getElementById('review-section').style.display = 'none';
    reviewItems = [];
    loadHistory();

    if (data.merge_candidates && data.merge_candidates.length > 0) {
      renderMergeSection(data.merge_candidates);
    }
  } catch (err) {
    console.error('[Commit]', err);
    setStatus('review-status', `Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ── Merge section ──────────────────────────────────────────────
let _mergeCandidates = [];

function renderMergeSection(candidates) {
  _mergeCandidates = candidates;
  const sec = document.getElementById('merge-section');
  document.getElementById('merge-count').textContent = `${candidates.length} duplicate${candidates.length !== 1 ? 's' : ''}`;

  const FIELDS = [
    { key: 'french',         label: 'French' },
    { key: 'phrase',         label: 'Example phrase' },
    { key: 'part_of_speech', label: 'Part of speech' },
    { key: 'thematic_tag',   label: 'Thematic tag' },
  ];

  document.getElementById('merge-list').innerHTML = candidates.map((c, ci) => `
    <div class="merge-entry">
      <h3>🔤 ${esc(c.korean)}</h3>
      <table class="merge-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Keep existing</th>
            <th>Use proposed</th>
          </tr>
        </thead>
        <tbody>
          ${FIELDS.map(f => {
            const ex  = c.existing[f.key]  || '—';
            const pro = c.proposed[f.key] || '—';
            const same = ex === pro;
            return `<tr>
              <td><strong>${f.label}</strong></td>
              <td>
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                  <input type="radio" name="merge-${ci}-${f.key}" value="existing" ${same ? 'checked' : 'checked'} />
                  <span class="merge-val-existing">${esc(ex)}</span>
                </label>
              </td>
              <td>
                <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;${same?'opacity:0.45;':''}">
                  <input type="radio" name="merge-${ci}-${f.key}" value="proposed" ${same ? 'disabled' : ''} />
                  <span class="merge-val-proposed">${esc(pro)}</span>
                </label>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`).join('');

  sec.style.display = 'block';
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function submitMerges() {
  const FIELDS = ['french', 'phrase', 'part_of_speech', 'thematic_tag'];
  const items = _mergeCandidates.map((c, ci) => {
    const item = { id: c.id };
    FIELDS.forEach(f => {
      const chosen = document.querySelector(`input[name="merge-${ci}-${f}"]:checked`);
      if (chosen) {
        item[f] = chosen.value === 'existing' ? c.existing[f] : c.proposed[f];
      }
    });
    return item;
  });

  try {
    const res  = await fetch(`${API}/api/vocabulary/merge`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Merge failed');
    log('Merge', `✅ ${data.updated} entries updated.`);
    showToast(`✅ ${data.updated} duplicate(s) merged.`, 'success');
    document.getElementById('merge-section').style.display = 'none';
    _mergeCandidates = [];
    loadHistory();
  } catch (err) {
    console.error('[Merge]', err);
    showToast(`Merge error: ${err.message}`, 'error');
  }
}

function dismissMerge() {
  document.getElementById('merge-section').style.display = 'none';
  _mergeCandidates = [];
}

// ── Inline cell editing ────────────────────────────────────────
let _editTd = null;
let _editOriginal = null;

function startEdit(td) {
  if (_editTd) cancelEdit();
  const col   = td.dataset.col;
  const rowId = Number(td.closest('tr').dataset.id);
  _editOriginal = td.innerHTML;
  _editTd = td;
  td.classList.add('editing');

  let input;
  if (col === 'part_of_speech') {
    input = document.createElement('select');
    input.className = 'inline-edit-select';
    input.innerHTML = `<option value="">— none —</option>` +
      POS_LIST.map(p => `<option value="${p}"${td.dataset.value===p?' selected':''}>${p}</option>`).join('');
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit-input';
    input.value = td.dataset.value || '';
  }

  input.dataset.col   = col;
  input.dataset.rowId = rowId;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commitEdit(input); }
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  });
  input.addEventListener('blur', () => {
    // small delay so click on another cell cancels first
    setTimeout(() => { if (_editTd === td) commitEdit(input); }, 120);
  });

  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();
}

async function commitEdit(input) {
  if (!_editTd) return;
  const col   = input.dataset.col;
  const rowId = Number(input.dataset.rowId);
  const value = input.value.trim();

  _editTd = null;
  _editOriginal = null;

  try {
    const res  = await fetch(`${API}/api/vocabulary/${rowId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [col]: value || null }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Update failed');
    log('Edit', `✅ id=${rowId} ${col}="${value}"`);

    // Update the local allHistory entry
    const entry = allHistory.find(r => r.id === rowId);
    if (entry) entry[col] = value || null;
    renderHistory();
  } catch (err) {
    console.error('[Edit]', err);
    showToast(`Save failed: ${err.message}`, 'error');
    loadHistory();
  }
}

function cancelEdit() {
  if (!_editTd) return;
  _editTd.innerHTML = _editOriginal;
  _editTd = null;
  _editOriginal = null;
}

// ── Bulk edit ──────────────────────────────────────────────────
function showBulkEditForm(field) {
  const container = document.getElementById('bulk-edit-form');
  const label = field === 'part_of_speech' ? 'New Part of Speech' : 'New Thematic Tag';

  let inputHtml;
  if (field === 'part_of_speech') {
    inputHtml = `<select id="bulk-edit-value">
      <option value="">— clear —</option>
      ${POS_LIST.map(p => `<option value="${p}">${p}</option>`).join('')}
    </select>`;
  } else {
    inputHtml = `<input type="text" id="bulk-edit-value" placeholder="e.g. TOPIK 1, Kdrama…" />`;
  }

  container.innerHTML = `
    <label>${label}:</label>
    ${inputHtml}
    <button class="btn-tool btn-secondary" onclick="applyBulkEdit('${field}')">Apply to ${selectedIds.size} selected</button>
    <button class="btn-tool" onclick="document.getElementById('bulk-edit-form').style.display='none'">✕</button>
  `;
  container.style.display = 'flex';
  container.querySelector('#bulk-edit-value').focus();
}

async function applyBulkEdit(field) {
  if (!selectedIds.size) return;
  const valueEl = document.getElementById('bulk-edit-value');
  const value   = valueEl ? valueEl.value.trim() : '';

  try {
    const body = { ids: [...selectedIds], [field]: value || null };
    const res  = await fetch(`${API}/api/vocabulary/bulk-edit`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Bulk edit failed');
    log('BulkEdit', `✅ ${data.updated} entries updated — ${field}="${value}"`);
    showToast(`✅ ${data.updated} entries updated.`, 'success');
    document.getElementById('bulk-edit-form').style.display = 'none';
    loadHistory();
  } catch (err) {
    console.error('[BulkEdit]', err);
    showToast(`Bulk edit failed: ${err.message}`, 'error');
  }
}

// ── History & selection state ──────────────────────────────────
let pageSize     = 50;
let allHistory   = [];
let filteredRows = [];
let selectedIds  = new Set();
let currentPage  = 1;

async function loadHistory() {
  try {
    const res = await fetch(`${API}/api/vocabulary`);
    allHistory = await res.json();
    selectedIds.clear();
    populateFilterOptions();
    applyFilter();
  } catch { /* silently ignore */ }
}

function populateFilterOptions() {
  const posVals = [...new Set(allHistory.map(r => r.part_of_speech).filter(Boolean))].sort();
  const tagVals = [...new Set(allHistory.map(r => r.thematic_tag).filter(Boolean))].sort();

  const posEl = document.getElementById('filter-pos');
  const tagEl = document.getElementById('filter-tag');
  const curPos = posEl.value;
  const curTag = tagEl.value;

  posEl.innerHTML = '<option value="">All parts of speech</option>' +
    posVals.map(p => `<option value="${esc(p)}"${p===curPos?' selected':''}>${esc(p)}</option>`).join('');
  tagEl.innerHTML = '<option value="">All themes</option>' +
    tagVals.map(t => `<option value="${esc(t)}"${t===curTag?' selected':''}>${esc(t)}</option>`).join('');
}

function applyFilter() {
  const q   = document.getElementById('history-search').value.toLowerCase();
  const pos = document.getElementById('filter-pos').value;
  const tag = document.getElementById('filter-tag').value;

  filteredRows = allHistory.filter(r => {
    const matchText = !q ||
      (r.korean || '').toLowerCase().includes(q) ||
      (r.french || '').toLowerCase().includes(q) ||
      (r.phrase || '').toLowerCase().includes(q);
    const matchPos = !pos || r.part_of_speech === pos;
    const matchTag = !tag || r.thematic_tag   === tag;
    return matchText && matchPos && matchTag;
  });
  currentPage = 1;
  renderHistory();
}

function renderHistory() {
  const tbody      = document.getElementById('history-tbody');
  const count      = document.getElementById('history-count');
  const size       = pageSize === 'ALL' ? filteredRows.length || 1 : pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / size));
  if (currentPage > totalPages) currentPage = totalPages;

  count.textContent = `${filteredRows.length} word${filteredRows.length !== 1 ? 's' : ''}`;

  if (filteredRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No vocabulary saved yet.</td></tr>';
    renderPagination(0, totalPages);
    updateSelectionUI();
    return;
  }

  const start    = (currentPage - 1) * size;
  const pageRows = filteredRows.slice(start, start + size);

  tbody.innerHTML = pageRows.map(r => `
    <tr class="${selectedIds.has(r.id) ? 'row-selected' : ''}" data-id="${r.id}">
      <td class="col-check">
        <input type="checkbox" class="row-check" data-id="${r.id}"
          ${selectedIds.has(r.id) ? 'checked' : ''} />
      </td>
      <td>${esc(r.korean)}</td>
      <td class="editable" data-col="french" data-id="${r.id}" data-value="${esc(r.french || '')}">${esc(r.french)}</td>
      <td class="editable" data-col="phrase" data-id="${r.id}" data-value="${esc(r.phrase || '')}">${esc(r.phrase)}</td>
      <td class="editable" data-col="part_of_speech" data-id="${r.id}" data-value="${esc(r.part_of_speech || '')}">
        ${r.part_of_speech
          ? `<span class="pos-badge pos-${esc(r.part_of_speech)}">${esc(r.part_of_speech)}</span>`
          : '<span style="color:#9ca3af">—</span>'}
      </td>
      <td class="editable" data-col="thematic_tag" data-id="${r.id}" data-value="${esc(r.thematic_tag || '')}">
        ${r.thematic_tag
          ? `<span class="tag-badge">${esc(r.thematic_tag)}</span>`
          : '<span style="color:#9ca3af">—</span>'}
      </td>
      <td><button class="btn-delete" title="Delete" onclick="deleteEntry(${r.id})">✕</button></td>
    </tr>`).join('');

  // Checkbox listeners
  tbody.querySelectorAll('.row-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      cb.checked ? selectedIds.add(id) : selectedIds.delete(id);
      cb.closest('tr').classList.toggle('row-selected', cb.checked);
      updateSelectionUI();
    });
  });

  // Inline edit listeners — click on editable cells
  tbody.querySelectorAll('td.editable').forEach(td => {
    td.addEventListener('click', () => startEdit(td));
  });

  renderPagination(filteredRows.length, totalPages);
  updateSelectionUI();
}

function renderPagination(total, totalPages) {
  const el = document.getElementById('pagination');
  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const size  = pageSize === 'ALL' ? total || 1 : pageSize;
  const start = (currentPage - 1) * size + 1;
  const end   = Math.min(currentPage * size, total);

  const prev  = `<button class="pg-btn" ${currentPage===1?'disabled':''} onclick="goPage(${currentPage-1})">‹ Prev</button>`;
  const next  = `<button class="pg-btn" ${currentPage===totalPages?'disabled':''} onclick="goPage(${currentPage+1})">Next ›</button>`;
  let pages   = '';
  for (const p of pageRange(currentPage, totalPages)) {
    pages += p === '…'
      ? `<span class="pg-ellipsis">…</span>`
      : `<button class="pg-btn ${p===currentPage?'pg-active':''}" onclick="goPage(${p})">${p}</button>`;
  }
  el.innerHTML = `
    <span class="pg-info">${start}–${end} of ${total}</span>
    <div class="pg-controls">${prev}${pages}${next}</div>`;
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  const pages  = new Set([1, total, current, current-1, current+1].filter(p => p>=1 && p<=total));
  const sorted = [...pages].sort((a,b) => a-b);
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i]-sorted[i-1] > 1) result.push('…');
    result.push(sorted[i]);
  }
  return result;
}

function goPage(p) {
  currentPage = p;
  renderHistory();
  document.getElementById('history-section').scrollIntoView({behavior:'smooth', block:'start'});
}

function updateSelectionUI() {
  const actions  = document.getElementById('selection-actions');
  const selCount = document.getElementById('selection-count');
  const selAll   = document.getElementById('select-all');

  const n = selectedIds.size;
  actions.style.display = n > 0 ? 'flex' : 'none';
  selCount.textContent  = `${n} selected`;

  const visIds       = Array.from(document.querySelectorAll('.row-check')).map(cb => Number(cb.dataset.id));
  const checkedCount = visIds.filter(id => selectedIds.has(id)).length;
  selAll.checked       = visIds.length > 0 && checkedCount === visIds.length;
  selAll.indeterminate = checkedCount > 0 && checkedCount < visIds.length;
}

document.getElementById('select-all').addEventListener('change', e => {
  document.querySelectorAll('.row-check').forEach(cb => {
    const id = Number(cb.dataset.id);
    if (e.target.checked) { selectedIds.add(id); cb.checked = true; cb.closest('tr').classList.add('row-selected'); }
    else                  { selectedIds.delete(id); cb.checked = false; cb.closest('tr').classList.remove('row-selected'); }
  });
  updateSelectionUI();
});

document.getElementById('history-search').addEventListener('input', applyFilter);
document.getElementById('filter-pos').addEventListener('change', applyFilter);
document.getElementById('filter-tag').addEventListener('change', applyFilter);

document.getElementById('page-size-select').addEventListener('change', e => {
  pageSize = e.target.value === 'ALL' ? 'ALL' : Number(e.target.value);
  currentPage = 1;
  renderHistory();
});

// ── Single delete ──────────────────────────────────────────────
async function deleteEntry(id) {
  if (!confirm('Delete this entry?')) return;
  log('Delete', `Deleting entry id=${id}`);
  await fetch(`${API}/api/vocabulary/${id}`, { method: 'DELETE' });
  selectedIds.delete(id);
  loadHistory();
}

// ── Export all CSV ─────────────────────────────────────────────
function exportAll() { window.location.href = `${API}/api/vocabulary/export`; }

// ── Export all Anki ───────────────────────────────────────────
function exportAllAnki() { window.location.href = `${API}/api/vocabulary/export-anki`; }

// ── Delete all ─────────────────────────────────────────────────
function deleteAll() {
  showModal('Delete ALL vocabulary?', 'This will permanently remove every entry in the database.', async () => {
    log('Delete', 'Deleting ALL entries.');
    await fetch(`${API}/api/vocabulary`, { method: 'DELETE' });
    selectedIds.clear();
    loadHistory();
  });
}

// ── Export selected CSV ────────────────────────────────────────
async function exportSelected() {
  if (!selectedIds.size) return;
  const res = await fetch(`${API}/api/vocabulary/export-selected`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...selectedIds] }),
  });
  if (!res.ok) return showToast('Export failed.', 'error');
  triggerDownload(await res.blob(), 'vocabulary_selected.csv');
}

// ── Export selected Anki ───────────────────────────────────────
async function exportSelectedAnki() {
  if (!selectedIds.size) return;
  const res = await fetch(`${API}/api/vocabulary/export-selected-anki`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [...selectedIds] }),
  });
  if (!res.ok) return showToast('Anki export failed.', 'error');
  triggerDownload(await res.blob(), 'vocabulary_selected.apkg');
}

// ── Delete selected ────────────────────────────────────────────
function deleteSelected() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  showModal(`Delete ${n} selected entr${n===1?'y':'ies'}?`, 'This action cannot be undone.', async () => {
    log('Delete', `Bulk deleting ${n} entry/entries: ids=[${[...selectedIds].join(', ')}]`);
    await fetch(`${API}/api/vocabulary/bulk`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    selectedIds.clear();
    loadHistory();
  });
}

// ── Stats dashboard ────────────────────────────────────────────
let _statsLoaded = false;
let _posChart = null, _weeklyChart = null, _tagChart = null;

async function loadStats() {
  if (_statsLoaded) return;
  try {
    const res  = await fetch(`${API}/api/stats`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Stats failed');
    renderStats(data);
    _statsLoaded = true;
  } catch (err) {
    console.error('[Stats]', err);
    document.getElementById('stats-total').textContent = 'Failed to load statistics.';
  }
}

function renderStats(data) {
  document.getElementById('stats-total').textContent =
    `${data.total_words} words in database`;

  const CHART_DEFAULTS = {
    responsive: true,
    plugins: { legend: { display: false } },
  };

  // POS bar chart
  if (_posChart) _posChart.destroy();
  _posChart = new Chart(document.getElementById('pos-chart'), {
    type: 'bar',
    data: {
      labels: data.pos_breakdown.map(r => r.pos),
      datasets: [{ data: data.pos_breakdown.map(r => r.count),
        backgroundColor: '#4f8ef7', borderRadius: 6 }],
    },
    options: { ...CHART_DEFAULTS, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
  });

  // Weekly line chart
  if (_weeklyChart) _weeklyChart.destroy();
  _weeklyChart = new Chart(document.getElementById('weekly-chart'), {
    type: 'line',
    data: {
      labels: data.weekly_counts.map(r => r.week),
      datasets: [{ data: data.weekly_counts.map(r => r.count),
        borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.12)',
        tension: 0.35, fill: true, pointRadius: 4 }],
    },
    options: { ...CHART_DEFAULTS, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
  });

  // Tag bar chart
  if (_tagChart) _tagChart.destroy();
  if (data.tag_breakdown.length > 0) {
    _tagChart = new Chart(document.getElementById('tag-chart'), {
      type: 'bar',
      data: {
        labels: data.tag_breakdown.map(r => r.tag),
        datasets: [{ data: data.tag_breakdown.map(r => r.count),
          backgroundColor: '#a78bfa', borderRadius: 6 }],
      },
      options: { ...CHART_DEFAULTS, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
        indexAxis: data.tag_breakdown.length > 5 ? 'y' : 'x' },
    });
  } else {
    document.getElementById('tag-chart').closest('.stat-card').innerHTML =
      '<p class="stat-title">Top Thematic Tags</p><p style="color:#9ca3af;font-size:0.9rem;margin-top:1rem;">No tags yet.</p>';
  }

  // TOPIK progress bars
  const cov = data.topik_coverage;
  document.getElementById('topik-bars').innerHTML = `
    <div class="topik-item">
      <div class="topik-label">
        <span>TOPIK I (~800 words)</span>
        <span>${cov.topik_i_pct}%</span>
      </div>
      <div class="topik-track">
        <div class="topik-bar topik-bar-i" style="width:${cov.topik_i_pct}%"></div>
      </div>
      <p class="topik-note">${cov.total} / 800 words</p>
    </div>
    <div class="topik-item">
      <div class="topik-label">
        <span>TOPIK II (~3500 words)</span>
        <span>${cov.topik_ii_pct}%</span>
      </div>
      <div class="topik-track">
        <div class="topik-bar topik-bar-ii" style="width:${cov.topik_ii_pct}%"></div>
      </div>
      <p class="topik-note">${cov.total} / 3500 words</p>
    </div>`;
}

// ── Modal ──────────────────────────────────────────────────────
let _modalCb = null;
function showModal(msg, msg2, onConfirm) {
  document.getElementById('modal-msg').textContent  = msg;
  document.getElementById('modal-msg2').textContent = msg2;
  _modalCb = onConfirm;
  document.getElementById('modal-overlay').style.display = 'flex';
}
function modalCancel()  { _modalCb = null; document.getElementById('modal-overlay').style.display = 'none'; }
async function modalConfirm() {
  document.getElementById('modal-overlay').style.display = 'none';
  if (_modalCb) await _modalCb();
  _modalCb = null;
}
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) modalCancel();
});

// ── Helpers ────────────────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function setStatus(id, msg, type = '') {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className   = `status ${type}`;
}

function esc(str = '') {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ───────────────────────────────────────────────────────
loadHistory();
