// Column-mapping preview: shown when column detection isn't confident, or on
// request. Lets the user say which column is the Raman shift and which are
// intensities instead of failing the import.

import { esc, fmt } from './dom.js';

/**
 * Ask the user to confirm/adjust a mapping.
 * @param {HTMLDialogElement} dlg
 * @param {{name:string, table:object, mapping:object, confidence:number}} job
 * @returns {Promise<object|null>} the chosen mapping, or null if cancelled
 */
export function askMapping(dlg, job) {
  return new Promise(resolve => {
    const { table } = job;
    const m = job.mapping || { x: null, ys: [], layout: 'columns', reasons: [] };
    const ncol = table.columns.length;
    const nrow = Math.min(12, table.nRows);
    const role = c => c === m.x ? 'x' : (m.ys || []).includes(c) ? 'y' : 'n';
    const conf = Math.round((job.confidence ?? m.confidence ?? 0) * 100);
    const head = Array.from({ length: ncol }, (_, c) => `<th><div style="font:500 10.5px var(--font-mono);color:var(--ink-3);margin-bottom:4px">${esc(table.headers[c] || 'column ' + (c + 1))}</div>
      <select data-col="${c}"><option value="x"${role(c) === 'x' ? ' selected' : ''}>Raman shift (x)</option><option value="y"${role(c) === 'y' ? ' selected' : ''}>Intensity</option><option value="n"${role(c) === 'n' ? ' selected' : ''}>Ignore</option></select></th>`).join('');
    const rows = Array.from({ length: nrow }, (_, r) => `<tr>${Array.from({ length: ncol }, (_, c) => {
      const v = table.columns[c][r];
      return `<td class="col${role(c)}" data-c="${c}">${isFinite(v) ? esc(fmt(v, 7)) : '<span style="opacity:.4">—</span>'}</td>`;
    }).join('')}</tr>`).join('');
    dlg.innerHTML = `<form method="dialog">
      <div class="dlg-head"><h2 id="mapTitle">Which column is which?</h2><span class="pane-meta">${esc(job.name)}</span></div>
      <div class="dlg-body">
        <div class="confbar">Detection confidence <span class="meter"><i style="width:${conf}%"></i></span> ${conf}%</div>
        ${(m.reasons || []).length ? `<ul class="reasons">${m.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <div class="dlg-row"><label>Layout <select id="mapLayout">
          <option value="columns"${m.layout === 'columns' ? ' selected' : ''}>x in a column, one spectrum per column</option>
          <option value="rows"${m.layout === 'rows' ? ' selected' : ''}>first row is x, one spectrum per row</option>
        </select></label><span style="color:var(--ink-3)">${table.nRows} rows × ${ncol} columns</span></div>
        <div class="maptable-wrap"><table class="maptable"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="dlg-foot"><button class="btn ghost" value="cancel">Cancel</button><button class="btn primary" value="ok" id="mapOk">Load spectrum</button></div>
    </form>`;
    const sels = [...dlg.querySelectorAll('select[data-col]')];
    const paint = () => {
      for (const s of sels) for (const td of dlg.querySelectorAll(`td[data-c="${s.dataset.col}"]`)) td.className = 'col' + s.value;
      const xs = sels.filter(s => s.value === 'x').length, ys = sels.filter(s => s.value === 'y').length;
      const layout = dlg.querySelector('#mapLayout').value;
      dlg.querySelector('#mapOk').disabled = layout === 'columns' ? !(xs === 1 && ys >= 1) : false;
    };
    for (const s of sels) s.addEventListener('change', () => {
      if (s.value === 'x') for (const o of sels) if (o !== s && o.value === 'x') o.value = 'y';
      paint();
    });
    dlg.querySelector('#mapLayout').addEventListener('change', paint);
    paint();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const layout = dlg.querySelector('#mapLayout').value;
      const x = sels.findIndex(s => s.value === 'x');
      const ys = sels.map((s, i) => s.value === 'y' ? i : -1).filter(i => i >= 0);
      resolve({ ...m, layout, x: layout === 'rows' ? null : x, ys, confidence: 1, reasons: ['set by hand'] });
    };
    dlg.returnValue = '';
    dlg.showModal();
  });
}
