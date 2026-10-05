const fs = require('node:fs/promises');
const path = require('node:path');
const { ipcRenderer } = require('electron');
const runWorker = require('./runWorker');
const { BANKS, DRUM_PAD_ORDER, noteName, suggestNoteMap, validateNoteMap } = require('./patternSlots');

/** Create text-only DOM nodes so filenames and card metadata cannot inject markup. */
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Own pattern selection, the mapping dialog and timeline. Card bytes stay in the shared editor snapshot.
 * perform serializes asynchronous work with sample operations and reports failures without clearing edits.
 */
class PatternPanel {
  constructor({ getState, isReady, isBusy, perform, showError }) {
    Object.assign(this, { getState, isReady, isBusy, perform, showError });
    /** Separate selection from the sample editor; start at the first pattern slot. */
    this.current = `${BANKS[0]}1`;
    /** Pending dialog data is discarded on cancellation, leaving assigned slots untouched. */
    this.pending = undefined;
    this.panel = document.querySelector('#patterns-panel');
    this.dialog = document.querySelector('.pattern-mapping');
    this.canvas = document.querySelector('.pattern-timeline');
    this.panel.querySelector('.import-pattern').addEventListener('click', () => this.pickFile());
    this.panel.querySelector('.export-midi').addEventListener('click', () => this.openExport());
    this.panel.querySelector('.export-pattern').addEventListener('click', () => this.exportNative());
    this.panel.querySelector('.remove-pattern').addEventListener('click', () => {
      if (this.isBusy() || !this.isReady()) return;
      const slot = this.getState().patterns[this.current];
      slot.remove = !slot.remove;
      this.render();
    });
    this.panel.querySelector('.pattern-bpm').addEventListener('change', (event) => {
      const input = event.target;
      if (this.isBusy() || !input.validity.valid) return;
      const slot = this.getState().patterns[this.current];
      slot.bpm = input.value === '' ? undefined : Number(input.value);
    });
    for (const selector of ['.close-mapping', '.cancel-mapping']) {
      this.dialog.querySelector(selector).addEventListener('click', () => this.dialog.close());
    }
    this.dialog.addEventListener('close', () => { this.pending = undefined; });
    this.dialog.querySelector('.mapping-form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.confirmMapping();
    });
    for (const selector of ['.mapping-bank', '.mapping-layout', '.auto-map']) {
      const type = selector === '.auto-map' ? 'click' : 'change';
      this.dialog.querySelector(selector).addEventListener(type, () => this.autoMap());
    }
    this.dialog.querySelector('.mapping-destination').addEventListener('change', () => this.validateMapping());
    const bankSelect = this.dialog.querySelector('.mapping-bank');
    for (const bank of BANKS) bankSelect.append(new Option(bank, bank));
    // ResizeObserver also redraws after a hidden tab becomes visible; no animation loop is needed.
    this.resizeObserver = new ResizeObserver(() => this.drawTimeline());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.render();
  }

  /** Pick without a loading overlay; processing starts only after selection, and cancellation leaves slots untouched. */
  async pickFile() {
    if (!this.isReady() || this.isBusy()) return;
    const file = await this.perform(() => ipcRenderer.invoke('pickPatternFile'), { showProgress: false });
    if (file) await this.loadFile(file);
  }

  /** Import drops and picker selections through the same validated path. Native bytes are preserved exactly. */
  async loadFile(file) {
    if (!this.isReady() || this.isBusy()) return;
    const imported = await this.perform(async () => {
      const bytes = await fs.readFile(file);
      const midi = ['.mid', '.midi'].includes(path.extname(file).toLowerCase());
      if (!midi && path.extname(file).toLowerCase() !== '.bin') throw new Error('Choose a .mid, .midi or SX .bin pattern.');
      const { summary } = await runWorker('convertPattern', {
        direction: midi ? 'inspect-midi' : 'inspect-pattern', buffer: bytes,
      });
      return { bytes, summary, midi, name: path.basename(file, path.extname(file)) };
    });
    if (!imported) return;
    if (!imported.midi) {
      this.assign(imported.bytes, imported.summary, { name: imported.name });
      return;
    }
    this.pending = { ...imported, mode: 'import' };
    this.configureDialog();
    this.autoMap();
    this.dialog.showModal();
  }

  /** Stage a replacement in memory. Saving is explicitly owned by the shared Write SD Card action. */
  assign(bytes, summary, metadata, destination = this.current) {
    const slot = this.getState().patterns[destination];
    this.getState().patterns[destination] = {
      label: slot.label, filename: slot.filename, bytes: Array.from(bytes), summary, ...metadata, dirty: true,
    };
    this.current = destination;
    this.render();
  }

  /** Offer the stored import map first; native patterns get unique drum-rack pitches that can be edited. */
  openExport() {
    if (this.isBusy() || !this.isReady()) return;
    const slot = this.getState().patterns[this.current];
    if (!slot?.summary || slot.remove) return;
    const map = {};
    const taken = new Set();
    for (const pad of slot.summary.usedPads) {
      const stored = Object.entries(slot.noteMap || {}).find(([, label]) => label === pad);
      let note = stored ? Number(stored[0]) : 36 + DRUM_PAD_ORDER.indexOf(Number(pad.slice(1)));
      // Repeated pad numbers across banks need distinct export pitches to avoid merging instruments.
      if (!Number.isInteger(note) || note < 0 || note > 127 || taken.has(note)) {
        note = Array.from({ length: 128 }, (_, i) => i).find((candidate) => !taken.has(candidate));
      }
      taken.add(note);
      map[pad] = note;
    }
    this.pending = { mode: 'export', slot, map, name: slot.name || slot.label };
    this.configureDialog();
    this.renderMapping();
    this.dialog.showModal();
  }

  /** Reset dialog options; imports start in the selected slot's bank, and destination labels disclose replacements. */
  configureDialog() {
    const exporting = this.pending.mode === 'export';
    this.dialog.querySelector('#mapping-title').textContent = exporting ? 'Export MIDI' : 'Import MIDI';
    this.dialog.querySelector('.mapping-file').textContent = this.pending.name;
    this.dialog.querySelector('.mapping-source-heading').textContent = exporting ? 'Sample pad' : 'MIDI note';
    this.dialog.querySelector('.mapping-target-heading').textContent = exporting ? 'MIDI note' : 'Sample pad';
    this.dialog.querySelector('.mapping-detail-heading').textContent = exporting ? 'Note name' : 'Sample';
    this.dialog.querySelector('.confirm-mapping').textContent = exporting ? 'Export MIDI' : 'Import pattern';
    for (const node of this.dialog.querySelectorAll('.import-option')) node.hidden = exporting;
    this.dialog.querySelector('.mapping-options').hidden = exporting;
    this.dialog.querySelector('.mapping-help').textContent = exporting
      ? 'Choose a unique MIDI pitch for each used sample pad. C1 = MIDI 36. Timing and velocity are retained.'
      : `${this.pending.summary.notes.length} hits · ${this.pending.summary.bars} bars · ${this.pending.summary.ppq} PPQ. C1 = MIDI 36. Every pitch needs a unique sample pad.`;
    this.dialog.querySelector('.mapping-save-help').textContent = exporting
      ? 'Tempo is included only when Export tempo is set.' : 'Import stages this pattern. Write SD Card saves it to the selected slot.';
    const destination = this.dialog.querySelector('.mapping-destination');
    destination.replaceChildren();
    for (const slot of Object.values(this.getState().patterns)) {
      let label = `${slot.label} · Empty`;
      if (slot.bytes || slot.error) label = `${slot.label} · Replace ${slot.name || 'pattern'}`;
      destination.append(new Option(label, slot.label));
    }
    destination.value = this.current;
    if (!exporting) {
      // A previous import's manual group/layout choices must not become defaults for another slot.
      this.dialog.querySelector('.mapping-bank').value = this.current[0];
      this.dialog.querySelector('.mapping-layout').value = 'drum';
    }
  }

  /** Regenerate suggestions only on explicit auto assignment/group/layout changes, preserving manual edits otherwise. */
  autoMap() {
    if (!this.pending || this.pending.mode !== 'import') return;
    this.pending.map = suggestNoteMap(this.pending.summary.pitches,
      this.dialog.querySelector('.mapping-bank').value, this.dialog.querySelector('.mapping-layout').value);
    this.renderMapping();
  }

  /** Explain whether a mapping has a playable sample, including pending imports and removals. */
  sampleStatus(label) {
    const pad = this.getState().pads[label];
    if (pad?.remove) return 'Pending removal';
    if (pad?.convert) return path.basename(pad.externalFile);
    if (pad?.samplePresent) return pad.externalFile ? path.basename(pad.externalFile) : 'Sample loaded';
    return 'Empty sample pad';
  }

  /** Build editable rows from detected pitches/used pads; every change updates validation immediately. */
  renderMapping() {
    const pending = this.pending;
    const exporting = pending.mode === 'export';
    const sources = exporting ? pending.slot.summary.usedPads : pending.summary.pitches;
    const notes = exporting ? pending.slot.summary.notes : pending.summary.notes;
    const body = this.dialog.querySelector('.mapping-rows');
    body.replaceChildren();
    for (const source of sources) {
      const row = element('tr');
      const sourceText = exporting ? source : `${noteName(source)} (${source})`;
      const count = notes.filter((note) => (exporting ? note.pad : note.note) === source).length;
      row.append(element('td', 'mapping-source', sourceText), element('td', '', count));
      const target = element('td');
      const detail = element('td', 'mapping-detail');
      let input;
      if (exporting) {
        input = element('input');
        input.type = 'number';
        input.min = '0';
        input.max = '127';
        input.step = '1';
      } else {
        input = element('select');
        for (const pad of Object.values(this.getState().pads)) input.append(new Option(`${pad.label} · ${this.sampleStatus(pad.label)}`, pad.label));
      }
      input.value = pending.map[source];
      input.setAttribute('aria-label', `Assignment for ${sourceText}`);
      input.dataset.source = source;
      const update = () => {
        pending.map[source] = exporting ? Number(input.value) : input.value;
        if (exporting && input.value === '') pending.map[source] = NaN;
        let detailText = this.sampleStatus(input.value);
        if (exporting) {
          detailText = '—';
          if (Number.isInteger(pending.map[source]) && pending.map[source] >= 0 && pending.map[source] <= 127) {
            detailText = noteName(pending.map[source]);
          }
        }
        detail.textContent = detailText;
        this.validateMapping();
      };
      input.addEventListener('input', update);
      input.addEventListener('change', update);
      target.append(input);
      row.append(target, detail);
      body.append(row);
      update();
    }
  }

  /** Block incomplete/ambiguous assignments, but allow empty sample pads with a clear useful warning. */
  validateMapping() {
    if (!this.pending) return false;
    let message;
    let valid = true;
    try {
      if (this.pending.mode === 'import') {
        validateNoteMap(this.pending.summary.pitches, this.pending.map);
        const missing = this.pending.summary.pitches.filter((note) => {
          const pad = this.getState().pads[this.pending.map[note]];
          return !pad || pad.remove || (!pad.convert && !pad.samplePresent);
        }).length;
        message = `${this.pending.summary.pitches.length} notes assigned`;
        if (missing) message += ` · ${missing} sample pads need audio`;
        const destination = this.getState().patterns[this.dialog.querySelector('.mapping-destination').value];
        if (destination?.bytes || destination?.error) message += ` · Replaces pattern ${destination.label} when saved`;
      } else {
        const values = Object.values(this.pending.map);
        if (values.some((note) => !Number.isInteger(note) || note < 0 || note > 127)) throw new Error('MIDI pitches must be whole numbers from 0 to 127.');
        if (new Set(values).size !== values.length) throw new Error('Choose a unique MIDI pitch for every sample pad.');
        message = `${values.length} sample pads assigned to MIDI notes`;
      }
    } catch (error) { valid = false; message = error.message; }
    const status = this.dialog.querySelector('.mapping-validation');
    status.textContent = message;
    status.classList.toggle('invalid', !valid);
    this.dialog.querySelector('.confirm-mapping').disabled = !valid;
    return valid;
  }

  /** Finish conversion before replacing editor state. Export cancellation leaves the pattern unchanged. */
  async confirmMapping() {
    if (this.isBusy() || !this.validateMapping()) return;
    const pending = this.pending;
    const destination = this.dialog.querySelector('.mapping-destination').value;
    // Close before async work so Escape cannot discard a map while its conversion is committing to memory.
    this.dialog.close();
    if (pending.mode === 'export') {
      await this.perform(async () => {
        const { buffer } = await runWorker('convertPattern', {
          direction: 'midi', buffer: Buffer.from(pending.slot.bytes),
          options: { noteMap: pending.map, bpm: pending.slot.bpm, fileName: pending.name, ppq: 96 },
        });
        const saved = await ipcRenderer.invoke('exportPatternFile', { bytes: new Uint8Array(buffer), filename: `${pending.name}.mid`, midi: true });
        // Remember an explicitly exported assignment for the next export; canceled dialogs preserve the old map.
        if (saved) pending.slot.noteMap = Object.fromEntries(Object.entries(pending.map).map(([pad, note]) => [note, pad]));
      });
      return;
    }
    const result = await this.perform(async () => {
      const { buffer } = await runWorker('convertPattern', { direction: 'pattern', buffer: pending.bytes, options: { noteMap: pending.map } });
      const { summary } = await runWorker('convertPattern', { direction: 'inspect-pattern', buffer });
      return { bytes: new Uint8Array(buffer), summary };
    });
    if (result) this.assign(result.bytes, result.summary, { name: pending.name, noteMap: pending.map, bpm: pending.summary.bpm }, destination);
    else {
      // A conversion failure keeps the editable mapping available for correction and retry.
      this.pending = pending;
      this.configureDialog();
      this.dialog.querySelector('.mapping-destination').value = destination;
      this.renderMapping();
      this.dialog.showModal();
    }
  }

  /** Export exact native bytes; mappings/tempo are editor metadata and do not alter SX pattern files. */
  async exportNative() {
    if (this.isBusy() || !this.isReady()) return;
    const slot = this.getState().patterns[this.current];
    if (!slot?.summary || slot.remove) return;
    await this.perform(() => ipcRenderer.invoke('exportPatternFile', {
      bytes: Uint8Array.from(slot.bytes), filename: `${slot.name || slot.label}.bin`, midi: false,
    }));
  }

  /** Render all bank assignments and the selected pattern's facts without changing sample selection. */
  render() {
    const matrix = this.panel.querySelector('.pattern-matrix');
    matrix.replaceChildren();
    const patterns = this.getState().patterns || {};
    for (const bank of BANKS) {
      const group = element('section', 'bank-group pattern-bank');
      group.setAttribute('aria-label', `Bank ${bank} patterns`);
      const heading = element('div', 'bank-heading');
      const slots = Object.values(patterns).filter((slot) => slot.label[0] === bank);
      const occupied = slots.filter((slot) => (slot.bytes || slot.error) && !slot.remove).length;
      heading.append(element('h2', '', `Bank ${bank}`), element('span', 'bank-count', `${occupied} / 12`));
      const pads = element('div', 'pattern-list');
      for (const slot of slots) {
        const button = element('button', 'pattern-pad');
        button.type = 'button';
        button.dataset.slot = slot.label;
        button.disabled = !this.isReady();
        button.classList.toggle('active-pad', Boolean(slot.bytes || slot.error));
        button.classList.toggle('add-pad', Boolean(slot.dirty));
        button.classList.toggle('delete-pad', Boolean(slot.remove));
        button.classList.toggle('selected', slot.label === this.current);
        button.setAttribute('aria-pressed', String(slot.label === this.current));
        let status = 'Empty';
        if (slot.summary) status = `${slot.summary.bars} bars`;
        if (slot.dirty) status = 'Pending';
        if (slot.error) status = 'Unreadable';
        if (slot.remove) status = 'Remove';
        button.append(element('span', 'pad-name', slot.label), element('span', 'pad-status', status));
        button.title = `${slot.label}: ${slot.name || status}. Drop a MIDI or SX pattern file to import.`;
        button.addEventListener('click', () => {
          if (this.isBusy()) return;
          this.current = slot.label;
          this.render();
          this.panel.querySelector(`.pattern-pad[data-slot="${slot.label}"]`).focus({ preventScroll: true });
        });
        button.addEventListener('dragover', (event) => {
          event.preventDefault();
          if (!this.isReady() || this.isBusy() || !event.dataTransfer.types.includes('Files')) return;
          event.dataTransfer.dropEffect = 'copy';
          button.classList.add('drop-target');
        });
        button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
        button.addEventListener('drop', (event) => {
          event.preventDefault();
          button.classList.remove('drop-target');
          if (!this.isReady() || this.isBusy()) return;
          if (event.dataTransfer.files.length !== 1) { this.showError('Drop one MIDI or SX pattern file.'); return; }
          const file = require('electron').webUtils.getPathForFile(event.dataTransfer.files[0]);
          if (!file) { this.showError('Drop a pattern file from your computer.'); return; }
          this.current = slot.label;
          this.loadFile(file);
        });
        pads.append(button);
      }
      group.append(heading, pads);
      matrix.append(group);
    }
    matrix.hidden = !this.isReady();
    const slot = patterns[this.current];
    const hasPattern = Boolean(this.isReady() && slot?.summary && !slot.remove);
    this.panel.querySelector('.pattern-slot-label').textContent = this.current;
    const title = this.panel.querySelector('#pattern-title');
    title.textContent = slot?.name || `Pattern ${this.current}`;
    title.title = title.textContent;
    let summary = 'Empty slot · Import MIDI or an SX pattern to get started.';
    if (!this.isReady()) summary = 'Open an SD card to manage all 120 pattern slots.';
    else if (slot?.error) summary = `Unreadable pattern: ${slot.error}`;
    else if (slot?.summary) summary = `${slot.summary.bars} bars · ${slot.summary.notes.length} hits · ${slot.summary.usedPads.length} sample pads · ${slot.summary.numerator}/4`;
    if (slot?.dirty) summary += ' · Pending import';
    if (slot?.remove) summary += ' · Pending removal';
    this.panel.querySelector('.pattern-summary').textContent = summary;
    this.panel.querySelector('.import-pattern').disabled = !this.isReady();
    for (const selector of ['.export-midi', '.export-pattern', '.pattern-bpm']) this.panel.querySelector(selector).disabled = !hasPattern || !this.isReady();
    const remove = this.panel.querySelector('.remove-pattern');
    remove.disabled = !(slot?.bytes || slot?.error) || !this.isReady();
    remove.textContent = slot?.remove ? 'Keep pattern' : 'Remove';
    this.panel.querySelector('.pattern-bpm').value = slot?.bpm || '';
    const used = this.panel.querySelector('.pattern-used-pads');
    used.textContent = hasPattern ? `Samples: ${slot.summary.usedPads.join(', ')}` : 'Note width shows duration. Brightness shows velocity.';
    used.title = used.textContent;
    this.panel.querySelector('.pattern-timeline-empty').hidden = hasPattern;
    this.canvas.setAttribute('aria-label', hasPattern ? `${summary}. Sample lanes: ${slot.summary.usedPads.join(', ')}.` : 'Empty pattern timeline');
    this.drawTimeline();
  }

  /** Draw on a quarter-note beat axis at native timing; duration/velocity stay visible without quantizing the data. */
  drawTimeline() {
    const summary = this.getState().patterns?.[this.current]?.summary;
    const width = Math.floor(this.canvas.parentElement.clientWidth);
    if (!width) return;
    // Keep drum lanes in pitch order instead of first-hit order, so sparse instruments remain easy to locate.
    const lanes = [...(summary?.usedPads || [])].sort((a, b) => {
      const bank = a[0].localeCompare(b[0]);
      if (bank) return bank;
      return DRUM_PAD_ORDER.indexOf(Number(a.slice(1))) - DRUM_PAD_ORDER.indexOf(Number(b.slice(1)));
    });
    // Fit the common eight-instrument kit in shorter windows; larger kits keep readable, scrollable lanes.
    const shortWindow = window.innerHeight <= 700 || window.innerWidth <= 1300;
    const viewportHeight = shortWindow ? 110 : 150;
    const laneHeight = Math.max(10, Math.min(14, Math.floor((viewportHeight - 30) / Math.max(1, lanes.length))));
    const height = Math.max(100, 30 + lanes.length * laneHeight);
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = width * ratio;
    this.canvas.height = height * ratio;
    this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.fillStyle = '#1c222c';
    ctx.fillRect(0, 0, width, height);
    if (!this.isReady() || !summary || this.getState().patterns[this.current].remove) return;
    const left = 62;
    const usable = width - left - 12;
    const beatWidth = usable / summary.beats;
    const fontSize = laneHeight < 14 ? 9 : 10;
    ctx.font = `${fontSize}px Montserrat, sans-serif`;
    for (let beat = 0; beat <= summary.beats; beat++) {
      const bar = beat % summary.numerator === 0;
      ctx.strokeStyle = bar ? '#526070' : '#303a49';
      ctx.beginPath();
      ctx.moveTo(left + beat * beatWidth, 24);
      ctx.lineTo(left + beat * beatWidth, height - 8);
      ctx.stroke();
      // Label sparsely for long patterns so the timeline remains readable at window minimum width.
      if (bar && beat < summary.beats && (beatWidth * summary.numerator >= 30 || beat % (summary.numerator * 4) === 0)) {
        ctx.fillStyle = '#aeb7c5';
        ctx.fillText(`Bar ${beat / summary.numerator + 1}`, left + beat * beatWidth + 4, 15);
      }
    }
    for (const [index, pad] of lanes.entries()) {
      ctx.fillStyle = '#d7deea';
      ctx.fillText(pad, 12, 28 + laneHeight - 3 + index * laneHeight);
    }
    for (const note of summary.notes) {
      const lane = lanes.indexOf(note.pad);
      const x = left + note.time * beatWidth;
      const length = Math.min(Math.max(3, note.length * beatWidth), width - 12 - x);
      ctx.fillStyle = `rgba(151, 157, 242, ${0.3 + 0.7 * note.velocity / 127})`;
      ctx.fillRect(x, 28 + lane * laneHeight, length, laneHeight - 5);
    }
  }
}

module.exports = PatternPanel;
