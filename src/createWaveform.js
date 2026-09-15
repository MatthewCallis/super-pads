const WaveformData = require('waveform-data');

/**
 * Reduce decoded audio to 128-frame waveform peaks in a browser worker.
 * Channel copies are transferred so the caller retains ownership of the AudioBuffer.
 * The worker is terminated on completion or failure; failures reject the promise.
 */
module.exports = function createWaveform(audioBuffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('./src/workers/renderAudioWaveform.js');
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      try {
        resolve(WaveformData.create(data.buffer));
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    try {
      const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => (
        audioBuffer.getChannelData(index).slice().buffer
      ));
      worker.postMessage({ channels, sampleRate: audioBuffer.sampleRate }, channels);
    } catch (error) {
      worker.terminate();
      reject(error);
    }
  });
};
