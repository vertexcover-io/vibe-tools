/* AI-generated. See PROMPT.md for the prompts and model used. */
// The one visible extension page. Chrome grants the microphone to the extension here, once;
// the hidden recording page shares that grant. Opened by the toolbar icon, or by the recorder
// when the mic was refused. Hands over to the page overlay and closes itself.
const SERVER = 'http://127.0.0.1:9335';
const $ = id => document.getElementById(id);

const grantMic = () => navigator.mediaDevices.getUserMedia({ audio: true })
  .then(stream => { stream.getTracks().forEach(t => t.stop()); return true; })
  .catch(err => { $('s').textContent = 'Microphone permission was refused: ' + err.message + '. Actions will still be recorded.'; return false; });

const closeMe = async () => { const me = await chrome.tabs.getCurrent(); if (me) chrome.tabs.remove(me.id); };

fetch(SERVER + '/status').then(r => r.json()).then(async st => {
  const { recording } = await chrome.storage.session.get({ recording: false });
  $('s').textContent = 'Recorder found. Checking the microphone...';
  const granted = await grantMic();
  if (recording) {
    if (granted) await chrome.runtime.sendMessage({ kind: 'mic-restart' });
  } else {
    await chrome.runtime.sendMessage({ kind: 'start', url: st.start_url, lang: st.lang || 'en-US' });
  }
  $('s').textContent = 'Recording. Look for the panel in the corner of the page.';
  closeMe();
}).catch(() => {
  $('s').textContent = 'Recorder is not running. Start recorder.py, then click Start.';
  $('start').hidden = false;
  $('start').onclick = () => location.reload();
});
