// Popup: is Minimal Download Manager running, plus the videos and files found on this page.
// The connection to the program lives in the service worker; ask it.
import { fmtBytes, detectedKey } from './lib.js';

const ping = () => chrome.runtime.sendMessage({ type: 'popup-status' }).catch(() => null);
const capture = (d) => chrome.runtime.sendMessage({ type: 'popup-download', ...d }).then((r) => {
  if (r?.error) throw new Error(r.error);
  return r?.accepted === true;
});

const pt = chrome.i18n.getUILanguage().startsWith('pt');
const T = pt ? {
  open: 'Abrir o Minimal Download Manager', running: 'Conectado ao Minimal Download Manager {v}', notRunning: 'O Minimal Download Manager não está aberto. Os downloads ficam no navegador.',
  start: 'Iniciar', found: 'Encontrado nesta página', none: 'Nada encontrado ainda. Toque o vídeo ou comece o download e abra de novo.',
  download: 'Baixar', sent: 'Enviado', failed: 'Falhou', stream: 'HLS/DASH: ainda não suportado',
  hint: 'Os tipos de arquivo capturados são escolhidos no Minimal Download Manager: Opções > Tipos de arquivos. Segure Alt ao clicar para deixar o navegador baixar.'
} : {
  open: 'Open Minimal Download Manager', running: 'Connected to Minimal Download Manager {v}', notRunning: 'Minimal Download Manager is not open. Downloads stay in the browser.',
  start: 'Start', found: 'Found on this page', none: 'Nothing found yet. Play the video or start the download, then reopen.',
  download: 'Download', sent: 'Sent', failed: 'Failed', stream: 'HLS/DASH: not supported yet',
  hint: 'The file types to capture are chosen in Minimal Download Manager: Options > File types. Hold Alt while clicking to let the browser download.'
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const openApp = () => chrome.tabs.create({ url: 'miniidm://open' });

async function renderStatus() {
  const info = await ping();
  const box = $('status');
  box.replaceChildren(el('span', 'dot'));
  if (info) {
    box.className = 'status ok';
    box.append(el('span', null, T.running.replace('{v}', info.version)));
  } else {
    box.className = 'status bad';
    box.append(el('span', null, T.notRunning));
    const b = el('button', 'ghost', T.start);
    b.addEventListener('click', openApp);
    box.append(b);
  }
}

async function renderDetected() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const list = tab ? (await chrome.storage.session.get(detectedKey(tab.id)))[detectedKey(tab.id)] || [] : [];
  const ul = $('detected');
  if (!list.length) return ul.replaceChildren(el('li', 'empty', T.none));
  ul.replaceChildren(...list.map((d) => {
    const li = el('li');
    const name = el('div', 'name');
    const n = el('div', null, d.filename);
    n.title = d.url;
    name.append(n, el('div', 'meta', [d.type, fmtBytes(d.size)].filter(Boolean).join(' · ')));
    li.append(name);
    if (d.kind === 'stream') {
      li.append(el('span', 'meta', T.stream));
    } else {
      const b = el('button', 'ghost', T.download);
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const ok = await capture({ url: d.url, filename: d.filename, referrer: tab.url, kind: 'detected' });
          b.textContent = ok ? T.sent : T.failed;
        } catch {
          b.textContent = T.failed;
          b.disabled = false;
        }
      });
      li.append(b);
    }
    return li;
  }));
}

$('openApp').textContent = T.open;
$('openApp').addEventListener('click', openApp);
$('foundTitle').textContent = T.found;
$('hint').textContent = T.hint;
renderStatus();
renderDetected();
