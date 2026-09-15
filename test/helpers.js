const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AudioPadInfo } = require('@uttori/audio-padinfo');

/** Create an isolated SD card and a 0.1-second, 22.05 kHz mono PCM source. Caller removes root. */
function createCard() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'super-pads-test-'));
  const directory = path.join(root, 'ROLAND', 'SP-404SX', 'SMPL') + path.sep;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'PAD_INFO.BIN'), Buffer.concat(
    Array.from({ length: 120 }, () => AudioPadInfo.encodePad()),
  ));

  const samples = 2205;
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
