import { getSettings, api } from './lib.js';

const $ = (id) => document.getElementById(id);
const result = (text, cls) => { $('result').textContent = text; $('result').className = cls; };

function read() {
  return {
    server: $('server').value.trim().replace(/\/+$/, ''),
    token: $('token').value.trim(),
    captureDownloads: $('captureDownloads').checked,
    captureClicks: $('captureClicks').checked
  };
}

const s = await getSettings();
$('server').value = s.server;
$('token').value = s.token;
$('captureDownloads').checked = s.captureDownloads;
$('captureClicks').checked = s.captureClicks;

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set(read());
  result('Saved.', 'ok');
});

$('test').addEventListener('click', async () => {
  result('Testing…', 'muted');
  try {
    const r = await api('/api/health', {}, read());
    if (r.status === 401) return result('Server reached, but the token is wrong.', 'bad');
    if (!r.ok) return result(`Server answered ${r.status}.`, 'bad');
    result('Connected.', 'ok');
  } catch {
    result('Could not reach the server. Is it running?', 'bad');
  }
});
