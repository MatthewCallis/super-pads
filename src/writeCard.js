const fs = require('node:fs');
const path = require('node:path');
const loadDataTools = require('./dataTools');
const readWaveMetadata = require('./readWaveMetadata');
const encodeAudio = require('./encodeAudio');
const relocateSample = require('./relocateSample');
const { writeNew } = require('./fileStorage');
const { encodePads, decodePads } = require('./padMetadata');
const { CardTransaction, recoverCard, SAMPLE_DIRECTORY } = require('./cardTransaction');
const { inspectPattern } = require('./patternMetadata');
const { patternFilename } = require('./patternSlots');
const { PATTERN_DIRECTORY } = require('./readPatterns');

/** Run at most two sample-staging jobs; await every started job before allowing rollback. */
async function stageQueuedSamples(jobs) {
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
 * Stages and validates all sample changes before replacing samples, metadata, or the saved editor state.
 */
async function writeCard({ root, state }) {
  try { recoverCard(root); } catch (error) {
    error.recoveryRequired = true;
    throw error;
  }
  const { SP404PadInfo } = await loadDataTools();
  await decodePads(fs.readFileSync(path.join(root, SAMPLE_DIRECTORY, 'PAD_INFO.BIN')));
  const snapshot = structuredClone(state);
  const pads = Object.values(snapshot.pads);
  // Validate identities before using any client-provided filenames as destinations.
  await encodePads(pads);
  for (const pad of pads) {
    if (pad.sourceFilename !== undefined && (typeof pad.sourceFilename !== 'string'
      || !/^[A-J]00000(?:0[1-9]|1[0-2])\.WAV$/.test(pad.sourceFilename))) {
      throw new Error(`${pad.label}: invalid transfer source filename.`);
    }
  }
  const transaction = new CardTransaction(root);
  try {
    const jobs = [];
    const replacements = new Map();
    for (const pad of pads) {
      const target = `${SAMPLE_DIRECTORY}/${pad.filename}`;
      // Moving into an empty slot leaves a vacancy whose old disk file must be removed at commit.
      if (pad.remove || (pad.relocated && !pad.samplePresent && !pad.convert)) {
        transaction.stage(target, true);
        const defaults = SP404PadInfo.fromFile(SP404PadInfo.encodePad()).pads[0];
        Object.assign(pad, defaults, { label: pad.label, filename: pad.filename, size: 0, duration: 0, samplePresent: false });
        delete pad.externalFile;
        delete pad.externalFileSize;
      } else if (pad.targetChannels && pad.avaliable && !pad.samplePresent && !pad.convert) {
        // Empty pads have no audio to convert; retain the requested format for the next import.
        pad.channels = pad.targetChannels;
      } else if (pad.convert || pad.targetChannels) {
        const imported = pad.convert;
        const source = imported ? pad.externalFile : path.join(root, SAMPLE_DIRECTORY, pad.sourceFilename || pad.filename);
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
      } else if (pad.sourceFilename && pad.sourceFilename !== pad.filename) {
        const source = path.join(root, SAMPLE_DIRECTORY, pad.sourceFilename);
        const destination = transaction.stage(target);
        replacements.set(pad.label, destination);
        // Every source is read before commit, so swaps and longer move chains cannot overwrite their inputs.
        jobs.push(async () => {
          relocateSample(source, destination, pad.label);
          const { size, duration, mtimeMs } = readWaveMetadata(destination);
          Object.assign(pad, { size, duration, mtimeMs });
        });
      }
    }
    await stageQueuedSamples(jobs);
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
      delete pad.sourceFilename;
      delete pad.relocated;
    }
    // Finish asynchronous validation before allocating the staged metadata destination.
    const metadata = await encodePads(pads);
    for (const [label, slot] of Object.entries(snapshot.patterns || {})) {
      if (slot.label !== label || slot.filename !== patternFilename(label)) throw new Error('Invalid pattern slot identity.');
      if (!slot.dirty && !slot.remove) continue;
      // Patterns share the sample transaction, so a failed card save preserves both kinds of pending edits.
      fs.mkdirSync(path.join(root, PATTERN_DIRECTORY), { recursive: true });
      const target = `${PATTERN_DIRECTORY}/${slot.filename}`;
      if (slot.remove) {
        transaction.stage(target, true);
        snapshot.patterns[label] = { label, filename: slot.filename };
      } else {
        if (!Array.isArray(slot.bytes) || slot.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          throw new Error(`${label}: invalid pattern bytes.`);
        }
        const bytes = Buffer.from(slot.bytes);
        slot.summary = await inspectPattern(bytes);
        writeNew(transaction.stage(target), bytes);
        delete slot.dirty;
      }
    }
    writeNew(transaction.stage(`${SAMPLE_DIRECTORY}/PAD_INFO.BIN`), metadata);
    writeNew(transaction.stage('super-pads.json'), JSON.stringify(snapshot, null, 2));
    const warning = transaction.commit();
    return { pads, patterns: snapshot.patterns, warning };
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
