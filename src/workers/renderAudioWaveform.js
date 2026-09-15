const WaveformData = require('waveform-data');

/** Accept transferred Float32 PCM channel buffers and return an 8-bit waveform buffer. */
onmessage = ({ data }) => {
  try {
    const width = data.width ?? 240;
    if (!Number.isInteger(width) || width < 1 || width > 16384 || !data.channels?.length) {
      throw new Error('Invalid waveform dimensions.');
    }
    const channels = data.channels.map((buffer) => new Float32Array(buffer));
    // AudioBuffer cannot be cloned between workers; expose the fields used by waveform-data.
    const audioBuffer = {
      numberOfChannels: channels.length,
      length: channels[0].length,
      sampleRate: data.sampleRate,
      getChannelData: (index) => channels[index],
    };
    WaveformData.createFromAudio({
      audio_buffer: audioBuffer,
      scale: Math.max(1, Math.ceil(audioBuffer.length / width)),
      bits: 8,
      // Already off the UI thread. The package's automatic Node worker cannot run in Electron.
      disable_worker: true,
    }, (error, waveform) => {
      if (error) {
        postMessage({ error: error.message });
        return;
      }
      const buffer = waveform.toArrayBuffer();
      postMessage({ buffer }, [buffer]);
    });
  } catch (error) {
    postMessage({ error: error.message });
  }
};
