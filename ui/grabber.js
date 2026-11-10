// Site Explorer: explore a page (and linked pages) and download the files found.
import { mdm, t, boot, el, fileBadge, queueName, showError } from './common.js';

const $ = (id) => document.getElementById(id);
const PRESETS = {
  images: 'jpg jpeg png gif webp bmp svg tif tiff',
  audio: 'mp3 wav flac m4a aac ogg opus wma',
  video: 'mp4 mkv avi mov webm wmv flv m4v',
  archives: 'zip rar 7z gz tar bz2 xz iso',
  documents: 'pdf doc docx xls xlsx ppt pptx txt epub'
};
let files = [];
let checked = new Set();
let settings;
let project = null;
let exploring = false;

const exts = () => $('exts').value.split(/[\s,;]+/).map(x => x.replace(/^\*?\./, '').toLowerCase()).filter(Boolean);

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = files.filter(f => !q || f.name.toLowerCase().includes(q) || f.url.toLowerCase().includes(q));
  $('results').replaceChildren(...shown.map((f) => {
    const box = el('input', { type: 'checkbox', checked: checked.has(f.url) });
    box.addEventListener('change', () => { if (box.checked) checked.add(f.url); else checked.delete(f.url); sync(); });
    const name = el('td', { class: 'ellipsis', title: f.url });
    name.innerHTML = fileBadge(f.name);
    name.append(' ', f.name);
    return el('tr', {}, el('td', {}, box), name, el('td', { text: f.ext.toUpperCase() }), el('td', { class: 'ellipsis muted', text: f.page, title: f.page }));
  }));
  sync();
}

function sync() {
  $('all').checked = files.length > 0 && checked.size === files.length;
  $('download').disabled = checked.size === 0;
  $('progress').textContent = files.length ? t('grab.selected', { n: checked.size, total: files.length }) : $('progress').textContent;
}

async function explore() {
  $('error').hidden = true;
  const url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) return showError($('error'), 'https://…');
  files = [];
  checked.clear();
  render();
  exploring = true;
  $('explore').disabled = true;
  $('stop').hidden = false;
  $('progress').textContent = t('grab.exploring');
  try {
    const r = await mdm.invoke('grab', { url, depth: Number($('depth').value), exts: exts(), sameSite: $('sameSite').checked });
    files = r.files;
    checked = new Set(files.map(f => f.url));
    render();
    $('progress').textContent = t('grab.done', { pages: r.pages, n: files.length });
  } catch (err) {
    showError($('error'), err);
  } finally {
    exploring = false;
    $('explore').disabled = false;
    $('stop').hidden = true;
  }
}

async function main() {
  const state = await boot();
  settings = state.settings;
  $('queue').replaceChildren(...settings.queues.map(q => el('option', { value: q.id, text: queueName(q) })));
  project = (settings.grabberProjects || []).find(p => p.id === mdm.params.project) || null;
  $('url').value = project?.url || '';
  $('depth').value = String(project?.depth ?? 1);
  $('exts').value = project ? project.exts.join(' ') : PRESETS.archives;
  $('sameSite').checked = project?.sameSite ?? true;
  if (project) document.title = `${t('grab.title')}: ${project.name}`;
  for (const b of document.querySelectorAll('[data-preset]')) b.addEventListener('click', () => { $('exts').value = PRESETS[b.dataset.preset]; });
  mdm.on('grab', ({ found }) => { if (exploring) $('progress').textContent = t('grab.progress', { n: found }); });
  $('explore').addEventListener('click', explore);
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') explore(); });
  $('stop').addEventListener('click', () => mdm.invoke('grabStop'));
  $('filter').addEventListener('input', render);
  $('all').addEventListener('change', () => { checked = $('all').checked ? new Set(files.map(f => f.url)) : new Set(); render(); });
  $('download').disabled = true;
  $('download').addEventListener('click', async () => {
    const now = document.querySelector('input[name=when]:checked').value === 'now';
    const n = await mdm.invoke('addMany', files.filter(f => checked.has(f.url)).map(f => f.url), { start: now, queueId: now ? undefined : $('queue').value });
    $('progress').textContent = t('grab.added', { n });
  });
  $('saveProject').addEventListener('click', async () => {
    const url = $('url').value.trim();
    if (!/^https?:\/\//i.test(url)) return showError($('error'), 'https://…');
    let name = url;
    try { name = new URL(url).hostname; } catch { /* keep url */ }
    const list = (settings.grabberProjects || []).filter(p => p.id !== project?.id);
    const saved = { id: project?.id, name: project?.name || name, url, depth: Number($('depth').value), exts: exts(), sameSite: $('sameSite').checked };
    settings = await mdm.invoke('settings', { grabberProjects: [...list, saved] });
    project = settings.grabberProjects.find(p => p.url === url) || project;
    $('progress').textContent = t('grab.saved');
  });
  $('url').focus();
}

main();
