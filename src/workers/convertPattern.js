const { patternToMidi, midiToPattern, inspectMidi, inspectPattern } = require('../patternMetadata');

/** Convert supplied bytes without filesystem writes; transfer an owned output buffer in the terminal reply. */
onmessage = async ({ data: { direction, buffer, options } }) => {
  try {
    if (direction === 'inspect-midi' || direction === 'inspect-pattern') {
      const inspect = direction === 'inspect-midi' ? inspectMidi : inspectPattern;
      postMessage({ success: true, summary: await inspect(buffer) });
      return;
    }
    let converted;
    if (direction === 'midi') {
      converted = await patternToMidi(buffer, options);
    } else if (direction === 'pattern') {
      converted = await midiToPattern(buffer, options?.noteMap);
    } else {
      throw new Error('Pattern conversion direction must be midi or pattern.');
    }
    // Buffer may use a shared allocation pool; transfer only the exact output bytes owned by this reply.
    const output = Uint8Array.from(converted).buffer;
    postMessage({ success: true, buffer: output }, [output]);
  } catch (error) {
    postMessage({ success: false, error: error.message });
  }
};
