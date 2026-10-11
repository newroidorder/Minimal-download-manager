import { getSettings, api, sendToServer, fmtBytes, detectedKey } from './lib.js';

// Everything shown here can come from hostile pages or servers, so it is
// rendered with textContent only.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let settings;
let tab;

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = cls;
}

async function renderDetected() {
  const list = tab ? (await chrome.storage.session.get(detectedKey(tab.id)))[detectedKey(tab.id)] || [] : [];
  const ul = $('detected');
  if (!list.length) {
    ul.replaceChildren(el('li', 'empty', 'Nothing detected yet. Play the video or start the download, then reopen.'));
    return;
  }
  ul.replaceChildren(...list.map((d) => {
    const li = el('li');
    const row = el('div', 'row');
    const name = el('div', 'name', d.filename);
    name.title = d.url;
    row.append(name);
    if (d.kind === 'stream') {
      row.append(el('span', 'meta', 'HLS/DASH: not supported'));
    } else {
      const b = el('button', 'ghost', 'Download');
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await sendToServer({ url: d.url, filename: d.filename, referrer: tab.url });
          b.textContent = 'Sent';
        } catch (err) {
          b.textContent = 'Failed';
          b.title = err.message;
          b.disabled = false;
        }
      });
      row.append(b);
    }
    li.append(row, el('div', 'meta', [d.type, fmtBytes(d.size)].filter(Boolean).join(' · ')));
    return li;
  }));
}

async function renderRecent() {
  const ul = $('recent');
  if (!settings.token) {
    setStatus('No token set. Open Settings and paste the token the server printed.', 'bad');
    ul.replaceChildren();
    return;
  }
  let items;
  try {
    const r = await api('/api/queue', {}, settings);
    if (r.status === 401) throw new Error('Token rejected. Check Settings.');
    if (!r.ok) throw new Error(`Server answered ${r.status}`);
    items = await r.json();
    setStatus(`Connected to ${settings.server}`, 'ok');
  } catch (err) {
    setStatus(err instanceof TypeError ? 'Server offline. Start it with: npm start (in server/)' : err.message, 'bad');
    ul.replaceChildren();
    return;
  }
  if (!items.length) {
    ul.replaceChildren(el('li', 'empty', 'No downloads yet.'));
    return;
  }
  ul.replaceChildren(...items.slice(0, 6).map((d) => {
    const li = el('li');
    const name = el('div', 'name', d.filename || d.url);
    name.title = d.url;
    const bar = el('div', 'bar');
    const fill = el('div', 'fill' + (d.status === 'done' ? ' done' : d.status === 'error' ? ' error' : ''));
    fill.style.width = `${d.progress || 0}%`;
    bar.append(fill);
    const parts = [d.status];
    if (d.status === 'downloading') parts.push(`${d.progress}%`, d.speed ? `${fmtBytes(d.speed)}/s` : '');
    if (d.size) parts.push(fmtBytes(d.size));
    if (d.error) parts.push(d.error);
    li.append(name, bar, el('div', 'meta', parts.filter(Boolean).join(' · ')));
    return li;
  }));
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('url').value.trim();
  try {
    await sendToServer({ url, referrer: '' });
    $('url').value = '';
    renderRecent();
  } catch (err) {
    setStatus(err.message, 'bad');
  }
});

$('openUi').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: settings.server });
});
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

settings = await getSettings();
[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
renderDetected();
renderRecent();
setInterval(renderRecent, 1000);
