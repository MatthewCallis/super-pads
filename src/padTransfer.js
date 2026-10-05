/** Whether a pad has audio that can be dragged, excluding samples queued for removal. */
function canDragPad(pad) {
  return Boolean(pad && !pad.remove && (pad.convert || pad.samplePresent));
}

/**
 * Swap complete sample settings between two slots, or move into an empty slot. Mutates only editor state.
 * Slot labels/filenames stay fixed; sourceFilename tracks the original card file through repeated moves.
 * Returns false for a same-slot drop, an unknown slot, or a source without usable audio.
 */
function transferPads(pads, sourceLabel, targetLabel) {
  if (!Object.hasOwn(pads, sourceLabel) || !Object.hasOwn(pads, targetLabel)) return false;
  const source = pads[sourceLabel];
  const target = pads[targetLabel];
  if (sourceLabel === targetLabel || !target || !canDragPad(source)) return false;

  /** Attach sample contents to a slot while retaining the immutable, pre-save audio source. */
  function place(contents, slot) {
    const pad = { ...contents, label: slot.label, filename: slot.filename, relocated: true };
    // Pending imports own their external source; saved samples still belong to their original disk file.
    if (contents.samplePresent && !contents.convert) {
      pad.sourceFilename = contents.sourceFilename || contents.filename;
    } else {
      delete pad.sourceFilename;
    }
    return pad;
  }

  pads[sourceLabel] = place(target, source);
  pads[targetLabel] = place(source, target);
  return true;
}

module.exports = { canDragPad, transferPads };
