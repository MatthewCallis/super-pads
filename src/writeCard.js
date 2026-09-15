const fs = require('node:fs');
const path = require('node:path');
const { AudioPadInfo } = require('@uttori/audio-padinfo');
const readWaveMetadata = require('./readWaveMetadata');
const encodeAudio = require('./encodeAudio');
const { writeNew } = require('./fileStorage');
const { encodePads, decodePads } = require('./padMetadata');
const { CardTransaction, recoverCard, SAMPLE_DIRECTORY } = require('./cardTransaction');

/** Run at most two conversions; await every started job before allowing rollback. */
async function convertQueued(jobs) {
  let next = 0;
  let failure;
  async function consume() {
    while (!failure && next < jobs.length) {
      const job = jobs[next++];
      try { await job(); } catch (error) { failure = error; }
    }
  }
  await Promise.all([consume(), consume()]);
  if (failure) throw failure;
}

/** Preserve the playback timeline when channel conversion changes the number of bytes per frame. */
function convertOffsets(pad, source, size) {
  const format = readWaveMetadata(source);
  const { dataOffset } = format;
  const blockAlign = pad.channels === 'Stereo' ? 4 : 2;
  for (const prefix of ['original', 'user']) {
    for (const edge of ['Start', 'End']) {
      const field = `${prefix}Sample${edge}`;
      const frames = Math.round((pad[field] - dataOffset) / format.blockAlign * 44100 / format.sampleRate);
      pad[field] = Math.max(512, Math.min(size, 512 + frames * blockAlign));
    }
  }
}

/**
 * Save a cloned editor snapshot as one recoverable card operation. Pending flags in the caller survive failures.
 * Converts and validates everything before replacing samples, metadata, or the saved editor state.
 */
async function writeCard({ root, state }) {
  try { recoverCard(root); } catch (error) {
    error.recoveryRequired = true;
    throw error;
  }
  decodePads(fs.readFileSync(path.join(root, SAMPLE_DIRECTORY, 'PAD_INFO.BIN')));
  const snapshot = structuredClone(state);
  const pads = Object.values(snapshot.pads);
  // Validate identities before using any client-provided filenames as destinations.
  encodePads(pads);
  const transaction = new CardTransaction(root);
  try {
    const jobs = [];
    const replacements = new Map();
    for (const pad of pads) {
      const target = `${SAMPLE_DIRECTORY}/${pad.filename}`;
      if (pad.remove) {
        transaction.stage(target, true);
        const defaults = AudioPadInfo.fromFile(AudioPadInfo.encodePad()).pads[0];
        Object.assign(pad, defaults, { label: pad.label, filename: pad.filename, size: 0, duration: 0, samplePresent: false });
        delete pad.externalFile;
        delete pad.externalFileSize;
      } else if (pad.targetChannels && pad.avaliable && !pad.samplePresent && !pad.convert) {
        // Empty pads have no audio to convert; retain the requested format for the next import.
        pad.channels = pad.targetChannels;
      } else if (pad.convert || pad.targetChannels) {
        const imported = pad.convert;
        const source = imported ? pad.externalFile : path.join(root, target);
        if (!source) throw new Error(`${pad.label}: no conversion source selected.`);
        if (pad.targetChannels) pad.channels = pad.targetChannels;
        const destination = transaction.stage(target);
        replacements.set(pad.label, destination);
        jobs.push(async () => {
          const result = await encodeAudio(source, destination, pad);
          if (imported) {
            pad.originalSampleStart = 512;
            pad.userSampleStart = 512;
            pad.originalSampleEnd = result.size;
            pad.userSampleEnd = result.size;
          } else {
            convertOffsets(pad, source, result.size);
          }
          Object.assign(pad, result, { avaliable: false, samplePresent: true, format: 'WAVE' });
          delete pad.previewError;
          pad.mtimeMs = fs.statSync(destination).mtimeMs;
        });
      }
    }
    await convertQueued(jobs);
    for (const pad of pads) {
      if (!pad.avaliable) {
        const file = replacements.get(pad.label) || path.join(root, SAMPLE_DIRECTORY, pad.filename);
        const { dataOffset, dataBytes } = readWaveMetadata(file);
        // Validate against the actual payload, including unchanged samples, before publishing metadata.
        for (const prefix of ['original', 'user']) {
          if (pad[`${prefix}SampleStart`] < dataOffset || pad[`${prefix}SampleEnd`] > dataOffset + dataBytes) {
            throw new Error(`${pad.label}: sample offsets are outside the audio payload.`);
          }
        }
      }
      pad.convert = false;
      pad.remove = false;
      delete pad.targetChannels;
    }
    writeNew(transaction.stage(`${SAMPLE_DIRECTORY}/PAD_INFO.BIN`), encodePads(pads));
    writeNew(transaction.stage('super-pads.json'), JSON.stringify(snapshot, null, 2));
    const warning = transaction.commit();
    return { pads, warning };
  } catch (error) {
    try { transaction.rollback(); } catch (recoveryError) {
      const pending = new Error(`${error.message} Recovery is pending; reopen this card to retry recovery. ${recoveryError.message}`);
      pending.recoveryRequired = true;
      throw pending;
    }
    throw error;
  }
}

module.exports = writeCard;
