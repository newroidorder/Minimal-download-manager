// Properties: details of one download; the address can be refreshed while it is stopped.
import { idm, t, boot, fmtBytes, fmtDate, catName, statusText, fileBadge, showError, fitWindow } from './common.js';

const $ = (id) => document.getElementById(id);
const ID = idm.params.id;
let settings;
let item;

function render() {
  if (!item) return idm.invoke('close');
  $('icon').innerHTML = fileBadge(item.filename, item.category);
  $('name').textContent = item.filename;
  $('sub').textContent = item.mime || '';
  $('status').textContent = statusText(item, settings.queues) + (item.error ? ` · ${item.error}` : '');
  $('size').textContent = fmtBytes(item.size, 2) || '—';
  $('category').textContent = catName(settings.save.categories.find(c => c.id === item.category)) || '—';
  $('path').textContent = item.dest || item.dir || '—';
  $('referrer').textContent = item.referrer || '—';
  $('added').textContent = fmtDate(item.addedAt) || '—';
  $('lastTry').textContent = fmtDate(item.lastTryAt) || '—';
  $('finished').textContent = fmtDate(item.finishedAt) || '—';
  $('scanLabel').hidden = $('scan').hidden = !item.scan;
  $('scan').textContent = item.scan || '';
  const locked = item.status === 'done' || ['starting', 'downloading', 'scanning'].includes(item.status);
  if (document.activeElement !== $('url')) $('url').value = item.url;
  $('url').readOnly = locked;
  $('urlHint').hidden = locked;
  if (document.activeElement !== $('description') && !$('description').dataset.edited) $('description').value = item.description || '';
  $('open').disabled = item.status !== 'done';
  $('folder').disabled = !(item.dest || item.dir);
}

async function main() {
  const state = await boot();
  settings = state.settings;
  item = await idm.invoke('item', ID);
  render();
  fitWindow();
  idm.on('item', (d) => { if (d.id === ID) { item = d; render(); } });
  idm.on('remove', (d) => { if (d.id === ID) idm.invoke('close'); });
  $('description').addEventListener('input', () => { $('description').dataset.edited = '1'; });
  $('open').addEventListener('click', () => idm.invoke('open', ID));
  $('folder').addEventListener('click', () => idm.invoke('openFolder', ID));
  $('cancel').addEventListener('click', () => idm.invoke('close'));
  $('save').addEventListener('click', async () => {
    try {
      const patch = { description: $('description').value };
      if (!$('url').readOnly) patch.url = $('url').value.trim();
      await idm.invoke('edit', ID, patch);
      idm.invoke('close');
    } catch (err) {
      showError($('error'), err);
    }
  });
}

main();
