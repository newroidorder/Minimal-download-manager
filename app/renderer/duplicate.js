// "This link is already in the list": add a numbered copy, replace, or resume.
import { idm, t, boot, statusText, fitWindow } from './common.js';

const $ = (id) => document.getElementById(id);
const token = idm.params.token;

async function main() {
  const state = await boot();
  const info = await idm.invoke('duplicateInfo', token);
  if (!info) return idm.invoke('close');
  const ex = info.existing;
  $('name').textContent = `${ex.filename} (${statusText(ex, state.settings.queues)})`;
  $('url').textContent = ex.url;
  $('url').title = ex.url;
  if (ex.status === 'done') document.querySelector('[value="resume"] + span').textContent = t('dup.showDone');
  $('ok').addEventListener('click', async () => {
    const act = document.querySelector('input[name=act]:checked').value;
    await idm.invoke('duplicate', token, act, $('remember').checked);
    idm.invoke('close');
  });
  $('cancel').addEventListener('click', async () => { await idm.invoke('duplicate', token, 'cancel'); idm.invoke('close'); });
  $('ok').focus();
  fitWindow();
}

main();
