const WaveformData = require('waveform-data');
const runWorker = require('./runWorker');

/**
 * Reduce decoded audio to at most width peaks (240 by default) in a cancellable browser worker.
 * Channel copies are transferred so the caller retains ownership of the AudioBuffer.
 * The worker is terminated on completion or failure; failures reject the promise.
 */
module.exports = async function createWaveform(audioBuffer, { width = 240, signal } = {}) {
  signal?.throwIfAborted();
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => (
    audioBuffer.getChannelData(index).slice().buffer
  ));
  const { buffer } = await runWorker('renderAudioWaveform', {
    channels, sampleRate: audioBuffer.sampleRate, width,
  }, { signal, transfer: channels });
  return WaveformData.create(buffer);
};
