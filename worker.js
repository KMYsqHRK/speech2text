import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
env.allowLocalModels = false;

let transcriber = null;

self.onmessage = async ({ data: msg }) => {
  if (msg.type === 'load') {
    try {
      transcriber = await pipeline('automatic-speech-recognition', msg.modelId, {
        quantized: true,
        progress_callback: (p) => self.postMessage({ type: 'progress', payload: p })
      });
      self.postMessage({ type: 'ready' });
    } catch (e) {
      self.postMessage({ type: 'error', message: e.message });
    }
  } else if (msg.type === 'transcribe') {
    try {
      const result = await transcriber(msg.float32, {
        language: 'japanese', task: 'transcribe',
        chunk_length_s: 30, stride_length_s: 5,
      });
      self.postMessage({ type: 'result', id: msg.id, text: result.text || '' });
    } catch (e) {
      self.postMessage({ type: 'result', id: msg.id, text: '', error: e.message });
    }
  }
};
