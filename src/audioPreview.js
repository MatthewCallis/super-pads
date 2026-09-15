const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const createWaveform = require('./createWaveform');

/**
 * Own the selected pad's player, cancellable waveform work, and a bounded cache of display-sized peaks.
 * Stable controls share one Audio element, so changing selection always stops the previous playback.
 */
class AudioPreview {
  constructor({ canvas, play, pause, onError }) {
    this.canvas = canvas;
    this.play = play;
    this.pause = pause;
    this.onError = onError;
    this.audio = new Audio();
    this.cache = new Map();
    this.controller = null;
    play.addEventListener('click', () => {
      const signal = this.controller?.signal;
      this.audio.play().catch((error) => {
        if (signal && !signal.aborted) onError(error);
      });
    });
    pause.addEventListener('click', () => this.audio.pause());
  }

  /** Stop playback and make all pending completions obsolete before changing any visible controls. */
  clear() {
    this.controller?.abort();
    this.controller = null;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.play.disabled = true;
    this.pause.disabled = true;
    this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Load a native path; omitted paths represent empty pads. Errors belong only to the current selection. */
  async show(file) {
    this.clear();
    if (!file) return;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const url = pathToFileURL(file).href;
    let context;
    this.audio.addEventListener('canplay', () => {
      if (signal.aborted || this.audio.readyState < 2) return;
      this.play.disabled = false;
      this.pause.disabled = false;
    }, { signal });
    this.audio.addEventListener('error', () => {
      if (!signal.aborted && this.audio.error) this.onError(new Error('Could not preview this audio file.'));
    }, { signal });
    this.audio.src = url;
    this.audio.load();
    try {
      const { size, mtimeMs } = await fs.stat(file);
      signal.throwIfAborted();
      const key = JSON.stringify([file, size, mtimeMs, this.canvas.width]);
      let waveform = this.cache.get(key);
      if (!waveform) {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`Could not read preview (${response.status}).`);
        const buffer = await response.arrayBuffer();
        signal.throwIfAborted();
        context = new AudioContext();
        const audioBuffer = await context.decodeAudioData(buffer);
        signal.throwIfAborted();
        waveform = await createWaveform(audioBuffer, { width: this.canvas.width, signal });
      }
      // Both cache insertion and drawing must belong to the still-selected pad.
      signal.throwIfAborted();
      this.cache.delete(key);
      this.cache.set(key, waveform);
      if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value);
      this.draw(waveform);
    } catch (error) {
      if (!signal.aborted) this.onError(error);
    } finally {
      if (context && context.state !== 'closed') await context.close();
    }
  }

  /** Fit the entire peak envelope to the canvas, including the end of long samples. */
  draw(waveform) {
    const { canvas } = this;
    const ctx = canvas.getContext('2d');
    const channel = waveform.channel(0);
    const scaleY = (value) => canvas.height - ((value + 128) * canvas.height) / 256;
    const step = canvas.width / Math.max(1, waveform.length);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#222831';
    ctx.fillStyle = '#222831';
    ctx.beginPath();
    for (let index = 0; index < waveform.length; index++) {
      ctx.lineTo((index + 0.5) * step, scaleY(channel.max_sample(index)));
    }
    for (let index = waveform.length - 1; index >= 0; index--) {
      ctx.lineTo((index + 0.5) * step, scaleY(channel.min_sample(index)));
    }
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
  }
}

module.exports = AudioPreview;
