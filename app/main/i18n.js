'use strict';

// Interface language: English or Brazilian Portuguese ("auto" follows Windows).

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'locales');
const dicts = {};
for (const lang of ['en', 'pt-BR']) dicts[lang] = JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'));

function resolve(setting, systemLocales = []) {
  if (setting === 'en' || setting === 'pt-BR') return setting;
  return systemLocales.some(l => /^pt\b/i.test(l)) ? 'pt-BR' : 'en';
}

function dict(lang) {
  return { ...dicts.en, ...dicts[lang] };
}

function translator(lang) {
  const d = dict(lang);
  return (key, vars = {}) => String(d[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

module.exports = { resolve, dict, translator, LANGS: Object.keys(dicts) };
