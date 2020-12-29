const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const { AudioWAV } = require('@uttori/audio-wave');
const ffmpegPath = require('ffmpeg-static-electron').path;

ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));

onmessage = (event) => {
  const { file, directory, pad } = event.data;

  if (!file) {
    postMessage({ success: false, error: 'No file.' });
    return;
  }
  if (!directory) {
    postMessage({ success: false, error: 'No directory.' });
    return;
  }
  if (!pad) {
    postMessage({ success: false, error: 'No pad.' });
    return;
  }

  try {
    ffmpeg()
      .input(file)
      .noVideo()
      // .audioCodec('pcm_s16le')
      .audioChannels(pad.channels === 'Stereo' ? 2 : 1)
      .audioFrequency(44100)
      .output(`${directory}${pad.filename}`)
      // .on('progress', (progress) => {
      //   console.log(`FFMPEG Processing: ${progress.timemark} done ${progress.targetSize} kilobytes`);
      // })
      .on('end', () => {
        const data = fs.readFileSync(`${directory}${pad.filename}`);
        const { chunks } = AudioWAV.fromFile(data);
        // Remove the header, we will make a new one with our new size.
        chunks.splice(0, 1);

        // Add a new Format chunk
        // FFMPEG omits the last 2 bytes of the format chunk but the OEM tool has them.
        const oldFormat = chunks.find((chunk) => chunk.type === 'format');
        const newFormat = AudioWAV.encodeFMT(oldFormat.value);
        chunks.splice(0, 1);
        chunks.splice(0, 0, { type: 'format', chunk: newFormat });

        // Add a new RLND chunk
        const rlnd = AudioWAV.encodeRLND({ device: 'roifspsx', sampleIndex: pad.label });
        chunks.splice(1, 0, { type: 'roland', chunk: rlnd });

        // Calculate the total size, include `WAVE` text (4 bytes)
        const size = chunks.reduce((total, chunk) => {
          if (['format', 'roland', 'data'].includes(chunk.type)) {
            total += chunk.chunk.length;
          }
          return total;
        }, 4);

        // Build the binary data
        const header = AudioWAV.encodeHeader({ size });
        const parts = chunks.reduce((arr, chunk) => {
          if (['format', 'roland', 'data'].includes(chunk.type)) {
            arr.push(Buffer.from(chunk.chunk));
          }
          return arr;
        }, [header]);
        const output = Buffer.concat(parts);

        // Write file, *.WAV as that is what the offical software uses.
        fs.writeFileSync(`${directory}${pad.filename}`, output);

        postMessage({ success: true, pad, size: output.length });
      })
      .run();
  } catch (error) {
    console.error(error);
    postMessage({ success: false, pad, error });
  }
};
