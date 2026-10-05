const loadDataTools = require('./dataTools');

/** Resolve all 120 validated records; incomplete cards, invalid fields and ESM load failures reject. */
async function decodePads(data) {
  if (data.length !== 120 * 32) throw new Error('PAD_INFO.BIN must contain all 120 pad records (3840 bytes).');
  const { SP404PadInfo } = await loadDataTools();
  const { pads } = SP404PadInfo.fromFile(data);
  for (const pad of pads) validatePad(pad, SP404PadInfo);
  return pads;
}

/** Enforce card-specific offset bounds and reject damaged flag bytes retained by the parser. */
function validatePad(pad, SP404PadInfo) {
  for (const field of ['lofi', 'loop', 'gate', 'reverse']) {
    if (typeof pad[field] !== 'boolean') throw new Error(`${pad.label}: invalid ${field}.`);
  }
  if (!['WAVE', 'AIFF'].includes(pad.format) || !['Mono', 'Stereo'].includes(pad.channels)) {
    throw new Error(`${pad.label}: invalid audio format or channel count.`);
  }
  for (const prefix of ['original', 'user']) {
    const start = pad[`${prefix}SampleStart`];
    const end = pad[`${prefix}SampleEnd`];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 512 || end < start || end > 0xffffffff) {
      throw new Error(`${pad.label}: invalid ${prefix} sample offsets.`);
    }
  }
  // The v5 encoder validates device field ranges; card payload bounds remain the app's responsibility.
  SP404PadInfo.encodePad(pad);
}

/** Resolve owned metadata bytes for 120 ordered pads; invalid identities or fields reject before any write. */
async function encodePads(pads) {
  if (!Array.isArray(pads) || pads.length !== 120) throw new Error('A card must contain exactly 120 pads.');
  const { SP404PadInfo } = await loadDataTools();
  return Buffer.concat(pads.map((pad, index) => {
    const label = SP404PadInfo.getPadLabel(index);
    const filename = `${label[0]}${label.slice(1).padStart(7, '0')}.WAV`;
    if (pad.label !== label || pad.filename !== filename) throw new Error(`Invalid pad order or filename at ${label}.`);
    validatePad(pad, SP404PadInfo);
    return SP404PadInfo.encodePad(pad);
  }));
}

module.exports = { decodePads, encodePads };
