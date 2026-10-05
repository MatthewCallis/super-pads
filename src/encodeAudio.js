const fs = require('node:fs');
const { spawn } = require('node:child_process');
const loadDataTools = require('./dataTools');
const { writeNew } = require('./fileStorage');
const ffmpegPath = require('ffmpeg-static-electron').path;

// Packaged executables must run from the unpacked directory outside Electron's ASAR archive.
const executable = ffmpegPath.replace('app.asar', 'app.asar.unpacked');

/**
 * Write a seekable 44.1 kHz, 16-bit PCM WAV with one or two channels.
 * Settle only after FFmpeg and its stdio close; preserve spawn errors and include stderr on exit failures.
 */
function convertWithFfmpeg(file, destination, channels) {
  return new Promise((resolve, reject) => {
    // Pass paths as individual arguments so spaces and shell metacharacters remain literal filenames.
    const child = spawn(executable, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', file, '-vn', '-c:a', 'pcm_s16le',
      '-ac', String(channels), '-ar', '44100', '-f', 'wav', destination,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let processError;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Drain the pipe to avoid blocking FFmpeg, retaining only the last 65,536 characters of diagnostics.
      stderr = (stderr + chunk).slice(-64 * 1024);
    });
    child.once('error', (error) => { processError = error; });
    // Closing stdio ensures diagnostics are complete and cleanup cannot race a remaining output write.
    child.once('close', (code, signal) => {
      if (processError) {
        reject(processError);
      } else if (code === 0 && !signal) {
        resolve();
      } else {
        let reason = `ffmpeg exited with code ${code}`;
        if (signal) reason = `ffmpeg was killed with signal ${signal}`;
        const diagnostics = stderr.trim();
        if (diagnostics) reason += `: ${diagnostics}`;
        reject(new Error(reason));
      }
    });
  });
}

/**
 * Convert to a new staged 44.1 kHz, 16-bit PCM Roland WAV. Reject on FFmpeg or post-processing failure.
 * The caller owns destination cleanup; source and final card files are never opened for writing here.
 * Returned size includes the 512-byte Roland header; duration measures the PCM audio in seconds.
 */
async function encodeAudio(file, destination, pad) {
  const temporary = `${destination}.ffmpeg.wav`;
  try {
    // Resolve the ESM tools before launching FFmpeg so import failures leave no conversion running.
    const { AudioWAV } = await loadDataTools();
    await convertWithFfmpeg(file, temporary, pad.channels === 'Stereo' ? 2 : 1);
    // A staged sample must reject incomplete WAV data rather than save a partial parser recovery.
    const { chunks } = AudioWAV.fromFile(fs.readFileSync(temporary), { strict: true });
    const format = chunks.find((chunk) => chunk.type === 'format');
    const data = chunks.find((chunk) => chunk.type === 'data');
    if (!format || !data) throw new Error('Converted WAV is missing its format or audio data.');
    const parts = [
      AudioWAV.encodeFMT(format.value),
      AudioWAV.encodeRLND({ device: 'roifspsx', sampleIndex: pad.label }),
      Buffer.from(data.chunk),
    ];
    const size = parts.reduce((total, part) => total + part.length, 4);
    const output = Buffer.concat([AudioWAV.encodeHeader({ size }), ...parts]);
    if (output.indexOf(Buffer.from('data')) + 8 !== 512) throw new Error('Unexpected Roland WAV data offset.');
    writeNew(destination, output);
    return { size: output.length, duration: (output.length - 512) / format.value.byteRate };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = encodeAudio;
