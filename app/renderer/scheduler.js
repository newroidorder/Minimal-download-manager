// Scheduler: queues that start and stop on their own, like IDM's.
import { idm, t, boot, el, fmtBytes, queueName, statusText, LANG, showError } from './common.js';

const $ = (id) => document.getElementById(id);
let queues = [];           // editable copy
let current = 'main';
let running = new Set();
let items = new Map();
let selectedFile = null;
let dirty = false;

const q = () => queues.find(x => x.id === current);

function dayNames() {
  // 2026-10-11 is a Sunday
  return [0, 1, 2, 3, 4, 5, 6].map(d => new Intl.DateTimeFormat(LANG, { weekday: 'short' }).format(new Date(2026, 9, 11 + d)));
}

function renderList() {
  $('queueList').replaceChildren(...queues.map(x => {
    const b = el('button', { class: x.id === current ? 'on' : '', html: '' });
    b.insertAdjacentHTML('afterbegin', '<svg class="i" viewBox="0 0 24 24"></svg>');
    b.append(el('span', { class: 'grow', text: queueName(x) || t('sched.unnamed') }));
    if (running.has(x.id)) b.append(el('span', { class: 'run-dot' }));
    b.addEventListener('click', () => { readForm(); current = x.id; render(); });
    return b;
  }));
  $('deleteQueue').disabled = current === 'main';
}

function render() {
  renderList();
  const x = q();
  const s = x.schedule;
  $('qName').value = x.id === 'main' && !x.name ? t('queue.main') : x.name;
  $('qName').disabled = x.id === 'main';
  $('running').hidden = !running.has(x.id);
  $('sEnabled').checked = s.enabled;
  $('sTime').value = s.startTime;
  $('sDate').value = s.startDate || new Date().toISOString().slice(0, 10);
  document.querySelector(`input[name=mode][value=${s.startMode}]`).checked = true;
  const names = dayNames();
  $('days').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(d => {
    const box = el('input', { type: 'checkbox', checked: s.days.includes(d) });
    box.dataset.day = d;
    return el('label', { class: 'check inline' }, box, el('span', { text: names[d] }));
  }));
  $('stopOn').checked = s.stopEnabled;
  $('stopTime').value = s.stopTime;
  $('maxConc').value = x.maxConcurrent;
  $('after').value = s.afterFinish;
  $('startNow').disabled = running.has(x.id);
  $('stopNow').disabled = !running.has(x.id);
  renderFiles();
}

function readForm() {
  const x = q();
  if (!x) return;
  if (x.id !== 'main') x.name = $('qName').value.trim();
  x.maxConcurrent = Number($('maxConc').value) || 1;
  x.schedule = {
    enabled: $('sEnabled').checked,
    startMode: document.querySelector('input[name=mode]:checked').value,
    startTime: $('sTime').value || '03:00',
    startDate: $('sDate').value,
    days: [...document.querySelectorAll('#days input')].filter(b => b.checked).map(b => Number(b.dataset.day)),
    stopEnabled: $('stopOn').checked,
    stopTime: $('stopTime').value || '07:00',
    afterFinish: $('after').value
  };
}

function queueItems() {
  return [...items.values()].filter(i => i.queueId === current).sort((a, b) => (a.queueOrder || 0) - (b.queueOrder || 0));
}

function renderFiles() {
  const list = queueItems();
  $('files').replaceChildren(...list.map((i, n) => {
    const tr = el('tr', { class: i.id === selectedFile ? 'sel' : '' },
      el('td', { text: String(n + 1) }), el('td', { class: 'ellipsis', text: i.filename, title: i.url }),
      el('td', { text: fmtBytes(i.size) }), el('td', { text: statusText(i, queues) }));
    tr.addEventListener('click', () => { selectedFile = i.id; renderFiles(); });
    return tr;
  }));
}

async function move(delta) {
  const list = queueItems().map(i => i.id);
  const at = list.indexOf(selectedFile);
  if (at < 0 || at + delta < 0 || at + delta >= list.length) return;
  [list[at], list[at + delta]] = [list[at + delta], list[at]];
  await idm.invoke('reorderQueue', current, list);
}

async function apply() {
  readForm();
  try {
    const s = await idm.invoke('settings', { queues });
    queues = structuredClone(s.queues);
    dirty = false;
    return true;
  } catch (err) {
    showError($('error'), err);
    return false;
  }
}

async function main() {
  const state = await boot();
  queues = structuredClone(state.settings.queues);
  running = new Set(state.queues);
  for (const i of state.items) items.set(i.id, i);
  current = queues.some(x => x.id === idm.params.queue) ? idm.params.queue : 'main';
  render();

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== b.dataset.tab;
    });
  }
  document.querySelector('.dlg-body').addEventListener('input', () => { dirty = true; });
  $('qName').addEventListener('input', () => { if (current !== 'main') { q().name = $('qName').value; renderList(); } });
  $('newQueue').addEventListener('click', () => {
    readForm();
    const id = `q-${Date.now().toString(36)}`;
    queues.push({ id, name: t('sched.newName', { n: queues.length }), maxConcurrent: 1, schedule: { ...structuredClone(q().schedule), enabled: false } });
    current = id;
    dirty = true;
    render();
    $('qName').focus();
    $('qName').select();
  });
  $('deleteQueue').addEventListener('click', async () => {
    if (current === 'main') return;
    if (state.settings.queues.some(x => x.id === current)) await idm.invoke('deleteQueue', current);
    queues = queues.filter(x => x.id !== current);
    current = 'main';
    render();
  });
  $('up').addEventListener('click', () => move(-1));
  $('down').addEventListener('click', () => move(1));
  $('unqueue').addEventListener('click', () => selectedFile && idm.invoke('setQueue', [selectedFile], null));
  $('startNow').addEventListener('click', async () => { if (dirty) await apply(); idm.invoke('startQueue', current); });
  $('stopNow').addEventListener('click', () => idm.invoke('stopQueue', current));
  $('apply').addEventListener('click', apply);
  $('close').addEventListener('click', async () => { if (!dirty || await apply()) idm.invoke('close'); });

  idm.on('queues', (list) => { running = new Set(list); render(); });
  idm.on('item', (i) => { items.set(i.id, i); renderFiles(); });
  idm.on('remove', ({ id }) => { items.delete(id); renderFiles(); });
}

main();
