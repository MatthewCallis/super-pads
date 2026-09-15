const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const encodeAudio = require('../encodeAudio');
const { syncDirectory } = require('../fileStorage');

/** Convert through a sibling temporary file; never truncate the previous sample. */
onmessage = async ({ data: { file, directory, pad } }) => {
  let temporary;
  try {
    if (!file || !directory || !pad || !/^[A-J]00000(?:0[1-9]|1[0-2])\.WAV$/.test(pad.filename)) {
      throw new Error('Invalid conversion source, destination, or pad.');
    }
    const target = path.join(directory, pad.filename);
    temporary = `${target}.${randomUUID()}.tmp`;
    const result = await encodeAudio(file, temporary, pad);
    fs.renameSync(temporary, target);
    syncDirectory(directory);
    postMessage({ success: true, pad, ...result });
  } catch (error) { postMessage({ success: false, pad, error: error.message }); }
  finally { if (temporary) fs.rmSync(temporary, { force: true }); }
};
