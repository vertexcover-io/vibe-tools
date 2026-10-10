/* AI-generated. See PROMPT.md for the prompts and model used. */
// The hidden page that holds the microphone for the whole recording. Chrome does the
// speech-to-text; raw audio goes to the recorder as a backup. A recognition session ends after
// a pause, so it is restarted until told to stop.
const SERVER = 'http://127.0.0.1:9335';
const tell = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

// Chrome only finalises a result when it hears a pause, and a narration with none can hold one
// result open indefinitely -- measured 2026-09-10: a single result ran 181s and finalised with
// an empty transcript, losing every word spoken in it while the panel had been showing them all
// along as interim. So interim text is kept rather than displayed and dropped, and the session
// is cycled on a timer so results finalise on a bounded schedule instead of whenever Chrome
// decides to.
const CYCLE_MS = 45000;

let audio, sr, listening = true, flush = Promise.resolve(), cycle = null;
const startedAt = new Map();
// index -> the longest interim text seen for a result that has not finalised yet.
const pending = new Map();

const emit = (index, text) => {
  const said = (text || '').trim();
  if (!said) return;
  tell({ kind: 'speech', payload: { start: (startedAt.get(index) || Date.now()) / 1000, end: Date.now() / 1000, text: said } });
};

// Everything still interim when a session ends, in the order it was spoken.
const flushPending = () => {
  for (const index of [...pending.keys()].sort((a, b) => a - b)) emit(index, pending.get(index));
  pending.clear();
};

const stopAudio = () => new Promise(resolve => {
  if (!audio || audio.state !== 'recording') return resolve();
  audio.onstop = () => flush.then(resolve);
  audio.stop();
});

const startMic = () => navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
  audio = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  audio.ondataavailable = e => { if (e.data.size) flush = flush.then(() => fetch(SERVER + '/audio', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: e.data }).catch(() => {})); };
  audio.start(1000);
  tell({ kind: 'mic', status: 'on' });
}).catch(err => tell({ kind: 'mic', status: 'failed: ' + err.message }));

function listen(lang) {
  sr = new webkitSpeechRecognition();
  sr.continuous = true; sr.interimResults = true; sr.lang = lang;
  sr.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!startedAt.has(i)) startedAt.set(i, Date.now());
      const text = e.results[i][0].transcript.trim();
      if (!e.results[i].isFinal) {
        // Held, not just shown: this is the only copy until the result finalises, and it may
        // finalise empty.
        if (text) pending.set(i, text);
        tell({ kind: 'interim', text });
        continue;
      }
      emit(i, text || pending.get(i));
      pending.delete(i);
    }
  };
  sr.onend = () => { clearTimeout(cycle); flushPending(); startedAt.clear(); if (listening) listen(lang); };
  sr.onerror = e => { if (!['no-speech', 'aborted'].includes(e.error)) tell({ kind: 'mic', status: 'speech error: ' + e.error }); };
  try {
    sr.start();
  } catch (err) {
    // start() throws if the previous session has not let go yet. Without this the recogniser
    // dies silently for the rest of the recording and only the audio backup survives.
    tell({ kind: 'mic', status: 'speech restarting: ' + err.message });
    setTimeout(() => { if (listening) listen(lang); }, 1000);
    return;
  }
  clearTimeout(cycle);
  cycle = setTimeout(() => { if (listening && sr) sr.stop(); }, CYCLE_MS);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind !== 'mic-stop') return false;
  listening = false;
  clearTimeout(cycle);
  // Whatever is still interim when Stop is pressed is the last thing that was said, and is the
  // most likely thing to matter.
  const ended = new Promise(resolve => { if (!sr) return resolve(); sr.onend = () => { flushPending(); resolve(); }; sr.stop(); });
  ended.then(stopAudio).then(() => reply({ ok: true }));
  return true;
});

window.onerror = (message) => tell({ kind: 'mic', status: 'error: ' + message });
window.onunhandledrejection = (e) => tell({ kind: 'mic', status: 'error: ' + (e.reason && e.reason.message || e.reason) });
tell({ kind: 'mic', status: 'opening' });
// Offscreen pages get chrome.runtime and nothing else, so the language comes from the worker.
chrome.runtime.sendMessage({ kind: 'lang' }).then(async ({ lang }) => {
  await startMic();
  if ('webkitSpeechRecognition' in window) listen(lang); else tell({ kind: 'mic', status: 'no speech-to-text in this browser' });
});
