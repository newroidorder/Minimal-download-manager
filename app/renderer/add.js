// "Add URL": the address, plus an optional login like IDM's "Use authorization".
import { idm, boot, showError, fitWindow } from './common.js';

const $ = (id) => document.getElementById(id);

async function submit(e) {
  e?.preventDefault();
  $('error').hidden = true;
  const url = $('url').value.trim();
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('https://…');
    new URL(url);
    await idm.invoke('add', { url, user: $('useAuth').checked ? $('user').value : '', pass: $('pass').value });
    idm.invoke('close');
  } catch (err) {
    showError($('error'), err);
  }
}

async function main() {
  await boot();
  const fromClipboard = await idm.invoke('clipboardUrl');
  $('url').value = idm.params.url || fromClipboard || '';
  $('url').focus();
  $('url').select();
  $('useAuth').addEventListener('change', () => { $('auth').hidden = !$('useAuth').checked; fitWindow(); });
  fitWindow();
  $('form').addEventListener('submit', submit);
  $('ok').addEventListener('click', submit);
  $('cancel').addEventListener('click', () => idm.invoke('close'));
  $('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(e); });
}

main();
