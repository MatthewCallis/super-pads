const fs = require('node:fs');
const ffmpeg = require('fluent-ffmpeg');
const { AudioWAV } = require('@uttori/audio-wave');
const { writeNew } = require('./fileStorage');
const ffmpegPath = require('ffmpeg-static-electron').path;

ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));

/**
 * Convert to a new staged 44.1 kHz, 16-bit PCM Roland WAV. Reject on FFmpeg or post-processing failure.
 * The caller owns destination cleanup; source and final card files are never opened for writing here.
 */
async function encodeAudio(file, destination, pad) {
  const temporary = `${destination}.ffmpeg.wav`;
  try {
    await new Promise((resolve, reject) => {
      ffmpeg().input(file).noVideo().audioCodec('pcm_s16le')
        .audioChannels(pad.channels === 'Stereo' ? 2 : 1).audioFrequency(44100)
        .format('wav').output(temporary).on('error', reject).on('end', resolve).run();
    });
    const { chunks } = AudioWAV.fromFile(fs.readFileSync(temporary));
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
