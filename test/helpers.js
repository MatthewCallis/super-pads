const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AudioPadInfo } = require('@uttori/audio-padinfo');

/** Create an isolated card and a 22.05 kHz mono PCM source. Duration defaults to 0.1 seconds; caller removes root. */
function createCard({ seconds = 0.1, prefix = 'super-pads-test-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const directory = path.join(root, 'ROLAND', 'SP-404SX', 'SMPL') + path.sep;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'PAD_INFO.BIN'), Buffer.concat(
    Array.from({ length: 120 }, () => AudioPadInfo.encodePad()),
  ));

  const samples = Math.round(seconds * 22050);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 22050) * 8192), 44 + index * 2);
  }
  const file = path.join(root, 'source with spaces.wav');
  fs.writeFileSync(file, wav);
  return { root, directory, file };
}

module.exports = { createCard };
