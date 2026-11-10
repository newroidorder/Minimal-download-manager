// "Add batch download": one address with * expanded over a range.
import { mdm, t, boot, el, queueName, showError } from './common.js';

const $ = (id) => document.getElementById(id);
let urls = [];

async function preview() {
  $('error').hidden = true;
  try {
    urls = $('pattern').value.trim() ? await mdm.invoke('batchExpand', $('pattern').value.trim(), $('from').value.trim(), $('to').value.trim(), $('width').value) : [];
    if (urls.length && !/^https?:\/\//i.test(urls[0])) throw new Error('https://…');
  } catch (err) {
    urls = [];
    showError($('error'), err);
  }
  $('preview').replaceChildren(...urls.slice(0, 200).map(u => el('tr', {}, el('td', { class: 'ellipsis', text: u, title: u }))));
  $('count').textContent = urls.length ? t('batch.count', { n: urls.length }) : '';
  $('ok').disabled = !urls.length;
}

async function main() {
  const state = await boot();
  $('queue').replaceChildren(...state.settings.queues.map(q => el('option', { value: q.id, text: queueName(q) })));
  for (const id of ['pattern', 'from', 'to', 'width']) $(id).addEventListener('input', preview);
  $('ok').disabled = true;
  $('ok').addEventListener('click', async () => {
    const now = document.querySelector('input[name=when]:checked').value === 'now';
    await mdm.invoke('addMany', urls, { start: now, queueId: now ? undefined : $('queue').value });
    mdm.invoke('close');
  });
  $('cancel').addEventListener('click', () => mdm.invoke('close'));
  $('pattern').focus();
}

main();
