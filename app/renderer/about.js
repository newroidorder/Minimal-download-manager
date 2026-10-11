import { idm, t, boot } from './common.js';

async function main() {
  const state = await boot();
  document.getElementById('version').textContent = t('about.version', { v: state.version });
  for (const b of document.querySelectorAll('[data-link]')) b.addEventListener('click', () => idm.invoke('external', b.dataset.link));
  document.getElementById('close').addEventListener('click', () => idm.invoke('close'));
}

main();
