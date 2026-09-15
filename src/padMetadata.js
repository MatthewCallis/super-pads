const { AudioPadInfo } = require('@uttori/audio-padinfo');

/** Reject incomplete cards and invalid field values before exposing them to the editor. */
function decodePads(data) {
  if (data.length !== 120 * 32) throw new Error('PAD_INFO.BIN must contain all 120 pad records (3840 bytes).');
  const { pads } = AudioPadInfo.fromFile(data);
  for (const pad of pads) validatePad(pad);
  return pads;
}

/** Validate byte offsets and fields that the library otherwise coerces or only logs as invalid. */
function validatePad(pad) {
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
  AudioPadInfo.encodePad(pad);
}

/** Encode exactly one ordered record per supported pad, never silently reorder or omit a pad. */
function encodePads(pads) {
  if (!Array.isArray(pads) || pads.length !== 120) throw new Error('A card must contain exactly 120 pads.');
  return Buffer.concat(pads.map((pad, index) => {
    const label = AudioPadInfo.getPadLabel(index);
    const filename = `${label[0]}${label.slice(1).padStart(7, '0')}.WAV`;
    if (pad.label !== label || pad.filename !== filename) throw new Error(`Invalid pad order or filename at ${label}.`);
    validatePad(pad);
    return AudioPadInfo.encodePad(pad);
  }));
}

module.exports = { decodePads, encodePads };
