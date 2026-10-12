// "This link is already in the list": add a numbered copy, replace, or resume.
import { mdm, t, boot, statusText, fitWindow } from './common.js';

const $ = (id) => document.getElementById(id);
const token = mdm.params.token;

async function main() {
  const state = await boot();
  const info = await mdm.invoke('duplicateInfo', token);
  if (!info) return mdm.invoke('close');
  const ex = info.existing;
  $('name').textContent = `${ex.filename} (${statusText(ex, state.settings.queues)})`;
  $('url').textContent = ex.url;
  $('url').title = ex.url;
  if (ex.status === 'done') document.querySelector('[value="resume"] + span').textContent = t('dup.showDone');
  $('ok').addEventListener('click', async () => {
    const act = document.querySelector('input[name=act]:checked').value;
    await mdm.invoke('duplicate', token, act, $('remember').checked);
    mdm.invoke('close');
  });
  $('cancel').addEventListener('click', async () => { await mdm.invoke('duplicate', token, 'cancel'); mdm.invoke('close'); });
  $('ok').focus();
  fitWindow();
}

main();
