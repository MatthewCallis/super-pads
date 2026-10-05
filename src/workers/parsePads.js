const fs = require('node:fs');
const path = require('node:path');
const { decodePads } = require('../padMetadata');
const { recoverCard, SAMPLE_DIRECTORY } = require('../cardTransaction');
const readWaveMetadata = require('../readWaveMetadata');
const { readPatterns } = require('../readPatterns');

/** Recover interrupted saves and return exactly one validated card result. */
onmessage = async ({ data: { root } }) => {
  try {
    if (!root) throw new Error('No card root selected.');
    recoverCard(root);
    const directory = path.join(root, SAMPLE_DIRECTORY);
    const pads = await decodePads(fs.readFileSync(path.join(directory, 'PAD_INFO.BIN')));
    for (const pad of pads) {
      // Match the canonical filename: removing zeroes confuses pad 10 with pad 1.
      const file = path.join(directory, pad.filename);
      if (!fs.existsSync(file)) continue;
      pad.samplePresent = true;
      try {
        const { size, duration, mtimeMs } = readWaveMetadata(file);
        Object.assign(pad, { size, duration, mtimeMs });
      } catch (error) {
        // One unpreviewable sample must not hide the remaining valid card metadata.
        pad.previewError = error.message;
      }
    }
    postMessage({ success: true, pads, patterns: await readPatterns(root) });
  } catch (error) { postMessage({ success: false, error: error.message }); }
};
