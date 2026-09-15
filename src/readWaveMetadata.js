const fs = require('node:fs');

/** Read RIFF chunk headers for PCM duration and identity without allocating the audio payload. */
module.exports = function readWaveMetadata(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size, mtimeMs } = fs.fstatSync(fd);
    const header = Buffer.alloc(24);
    const read = (length, offset) => {
      if (fs.readSync(fd, header, 0, length, offset) !== length) throw new Error('Truncated WAV header.');
    };
    read(12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Not a RIFF WAVE file.');
    }
    let format;
    let audio;
    for (let offset = 12; offset + 8 <= size;) {
      read(8, offset);
      const kind = header.toString('ascii', 0, 4);
      const length = header.readUInt32LE(4);
      if (offset + 8 + length > size) throw new Error('Truncated WAV chunk.');
      if (kind === 'fmt ') {
        if (length < 16) throw new Error('Invalid WAV format chunk.');
        read(16, offset + 8);
        format = {
          encoding: header.readUInt16LE(0), channels: header.readUInt16LE(2),
          sampleRate: header.readUInt32LE(4), byteRate: header.readUInt32LE(8),
          blockAlign: header.readUInt16LE(12),
        };
      } else if (kind === 'data') audio = { dataOffset: offset + 8, dataBytes: length };
      if (format && audio) break;
      // RIFF chunks may be odd-sized; their alignment byte is not included in the chunk length.
      offset += 8 + length + length % 2;
    }
    if (!format || !audio || ![1, 3].includes(format.encoding) || !format.byteRate || !format.blockAlign) {
      throw new Error('Unsupported or incomplete PCM WAV.');
    }
    return { size, mtimeMs, duration: audio.dataBytes / format.byteRate, ...format, ...audio };
  } finally { fs.closeSync(fd); }
};
