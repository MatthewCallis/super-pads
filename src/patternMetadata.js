const loadDataTools = require('./dataTools');

/**
 * Parse native SX bytes through SP404Pattern, rejecting unknown pads before editor assignment or export.
 * The library supports preserving unknown records; the editor requires a complete, playable mapping.
 * @returns {Promise<import('@uttori/data-tools').SP404Pattern>} Parsed native records at 96 PPQ.
 */
async function readSXPattern(data) {
  const { SP404Pattern } = await loadDataTools();
  if (!data || data.byteLength < 16) throw new Error('A pattern must include a sixteen-byte footer.');
  const pattern = new SP404Pattern(data, { og: true });
  for (const note of pattern.notes) {
    if (note.midiNote === 128) continue;
    // Unknown records must be visible as damage, never silently omitted during a later MIDI export.
    if (!note.padLabel) {
      throw new Error('Pattern contains an unknown sample pad address. Reimport its source MIDI to rebuild it.');
    }
    if (note.velocity > 127) throw new Error('Pattern contains an invalid velocity.');
  }
  return pattern;
}

/**
 * Export an SX/A pattern to MIDI bytes using the twelve-pad layout and native 96 ticks per quarter note.
 * Options map pad labels A1–J12 to MIDI notes 0–127; every used pad needs a mapping to prevent silent loss.
 * Optional BPM and destination PPQ are passed to SP404Pattern; malformed patterns and invalid options reject.
 * @param {Buffer|Uint8Array|ArrayBuffer} data Complete pattern bytes, including the sixteen-byte footer.
 * @param {import('@uttori/data-tools').SP404ToMidiOptions} options MIDI mapping and optional tempo/timing settings.
 * @returns {Promise<Buffer>} Owned bytes suitable for writing to a MIDI file.
 */
async function patternToMidi(data, options) {
  const pattern = await readSXPattern(data);
  for (const label of pattern.getUsedPads()) {
    if (!options?.noteMap || !Object.hasOwn(options.noteMap, label)) {
      throw new Error(`No MIDI note mapping for ${label}.`);
    }
  }
  const midi = pattern.toMidi(options);
  return Buffer.from(midi.saveToDataBuffer().data);
}

/**
 * Import MIDI bytes as an SX/A pattern, rescaling timing to the device's 96 ticks per quarter note.
 * The map associates MIDI notes 0–127 with pads A1–J12. Unmapped notes, unsupported timing and oversized patterns reject.
 * @param {Buffer|Uint8Array|ArrayBuffer} data A complete Standard MIDI File.
 * @param {Record<number, string>} noteMap Caller-owned MIDI-note-to-pad mapping.
 * @returns {Promise<Buffer>} Owned pattern bytes; this helper does not write to the card.
 */
async function midiToPattern(data, noteMap) {
  const { AudioMIDI, SP404Pattern } = await loadDataTools();
  const midi = new AudioMIDI(data);
  midi.parse();
  const pattern = SP404Pattern.fromMidi(midi, noteMap, SP404Pattern.defaultPPQOG, true);
  return Buffer.from(pattern.data);
}

/**
 * Inspect merged MIDI pitches for assignment without changing the bytes. Empty/unsupported files reject.
 * Note times/lengths and total beats use quarter-note units; bars include trailing rests and are rounded up.
 * Returns distinct sorted pitches, note hits with velocity 1–127, source PPQ, and optional initial BPM.
 */
async function inspectMidi(data) {
  const { AudioMIDI } = await loadDataTools();
  const midi = new AudioMIDI(data);
  midi.parse();
  if (midi.timeDivision < 1 || midi.timeDivision > 0x7fff) throw new Error('SMPTE MIDI timing is unsupported.');
  if (midi.format === 2 && midi.chunks.length > 1) throw new Error('Independent format-2 tracks cannot form one pattern.');
  const notes = [];
  let end = 0;
  let bpm;
  for (const track of midi.chunks) {
    let time = 0;
    for (const event of track.events) {
      time += event.deltaTime;
      // MIDI encodes the denominator as a power of two, so 2 denotes the quarter note in 4/4.
      if (event.type === 0xff && event.metaType === 0x58
        && (event.data.numerator !== 4 || event.data.denominator !== 2)) {
        throw new Error('MIDI import currently supports only 4/4 patterns.');
      }
      // Native patterns do not store BPM. Keep the initial MIDI tempo as editor/export metadata.
      if (event.type === 0xff && event.metaType === 0x51 && time === 0 && bpm === undefined) {
        bpm = event.data.bpm;
      }
      if (event.type === 0x90 && event.data.velocity > 0) {
        const length = (event.data.length || 0) / midi.timeDivision;
        notes.push({ note: event.data.note, time: time / midi.timeDivision, length, velocity: event.data.velocity });
        end = Math.max(end, time / midi.timeDivision + length);
      }
    }
    end = Math.max(end, time / midi.timeDivision);
  }
  if (!notes.length) throw new Error('This MIDI file contains no note hits.');
  const bars = Math.max(1, Math.ceil(end / 4));
  if (bars > 64) throw new Error('SX patterns support at most 64 bars.');
  const pitches = [...new Set(notes.map((note) => note.note))].sort((a, b) => a - b);
  return { notes, pitches, bars, beats: bars * 4, bpm, ppq: midi.timeDivision };
}

/**
 * Decode native SX timing, retaining placeholders in duration but excluding them from visible hits.
 * Returns pad-labelled notes with time/length in quarter-note beats, velocity, used pads and bar/meter totals.
 * Unknown pad addresses, malformed records and durations above 64 bars reject before assignment or writing.
 */
async function inspectPattern(data) {
  const pattern = await readSXPattern(data);
  const numerators = [4, 3, 2, 1, 5, 6, undefined, 7];
  const numerator = numerators[pattern.timeSignature];
  if (!numerator) throw new Error('Unsupported pattern time signature.');
  let ticks = 0;
  let end = 0;
  const notes = [];
  for (const note of pattern.notes) {
    // The SX delay belongs after this hit, including placeholders and the last record's trailing rest.
    const start = ticks;
    ticks += note.ticks;
    end = Math.max(end, ticks);
    if (note.midiNote === 128) continue;
    notes.push({ pad: note.padLabel, time: start / 96, length: note.length / 96, velocity: note.velocity });
    end = Math.max(end, start + note.length);
  }
  const bars = Math.max(1, pattern.bars, Math.ceil(end / (96 * numerator)));
  if (bars > 64) throw new Error('SX patterns support at most 64 bars.');
  return { notes, usedPads: pattern.getUsedPads(), bars, beats: bars * numerator, numerator };
}

module.exports = { patternToMidi, midiToPattern, inspectMidi, inspectPattern };
