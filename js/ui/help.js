// Keyboard shortcut reference. Keys follow PeakForge where the action exists
// there (F fit, Del delete, Esc deselect, Ctrl+Z/Y, Ctrl+S, double-click to add,
// arrows to nudge); the rest are new to Raman Studio.

export const SHORTCUTS = [
  ['Files', [
    ['O', 'Open spectrum file(s)'],
    ['Ctrl S', 'Save project (JSON)'],
    ['Drag & drop', 'Load files anywhere on the window'],
  ]],
  ['Analysis', [
    ['D', 'Detect & label again (replays the scan)'],
    ['F', 'Deconvolve: nine-band atlas fit (PeakForge: auto-fit)'],
    ['1 · 2 · 3', 'Laser 532 · 633 · 785 nm'],
    ['Double-click plot', 'Add a peak by hand (PeakForge: add peak)'],
    ['Del', 'Remove the selected peak (PeakForge: delete curve)'],
    ['← →', 'Nudge the selected peak 1 cm⁻¹ (Shift = 10×)'],
    ['Ctrl Z · Ctrl Y', 'Undo · redo'],
  ]],
  ['View', [
    ['Wheel · pinch', 'Zoom around the cursor'],
    ['Drag', 'Pan · Shift-drag: zoom to a range'],
    ['R  or  0', 'Show the whole spectrum'],
    ['+ −', 'Zoom in · out'],
    ['B', 'Raw spectrum + baseline + removed spikes'],
    ['C', 'Compare raw and processed'],
    ['[ ]', 'Previous · next label'],
    ['Enter', 'Open the selected band in the atlas panel'],
    ['Esc', 'Deselect · close (PeakForge: deselect)'],
  ]],
  ['Display', [
    ['P', 'Presentation mode (fullscreen, projector contrast)'],
    ['← → in presentation', 'Step through labels with captions'],
    ['T', 'Light / dark theme'],
    ['?', 'This help'],
  ]],
];

export function showHelp(dlg) {
  dlg.innerHTML = `<form method="dialog">
    <div class="dlg-head"><h2 id="helpTitle">Keyboard shortcuts</h2><button class="btn ghost" value="close" aria-label="Close">Esc</button></div>
    <div class="dlg-body"><div class="helpgrid">${SHORTCUTS.map(([group, rows]) =>
      `<h3>${group}</h3>${rows.map(([k, d]) => `<div><span>${d}</span><kbd>${k}</kbd></div>`).join('')}`).join('')}
    </div></div></form>`;
  dlg.showModal();
}
