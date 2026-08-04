#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const root = process.cwd();
const backups = path.join(root, '.date-patch-backup');
const required = ['app.js', 'data-model.js', 'validation-engine.js', 'as-of-date-engine.js'];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}. Run this script in the repository root.`);
}
fs.mkdirSync(backups, { recursive: true });

function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function write(file, text) {
  fs.copyFileSync(path.join(root, file), path.join(backups, file));
  fs.writeFileSync(path.join(root, file), text, 'utf8');
}
function replaceFunction(source, name, replacement) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Could not find function ${name}.`);
  const brace = source.indexOf('{', start);
  let depth = 0, end = -1, quote = null, escape = false;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error(`Could not read function ${name}.`);
  return source.slice(0, start) + replacement + source.slice(end);
}

const dateHelpers = `
// ---- canonical date-only helpers (added by true-date patch) -------------
function normaliseEffectiveDate(value) {
  if (value instanceof Date && !isNaN(value)) {
    return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  }
  var s = String(value == null ? '' : value).trim();
  var iso = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/);
  var dmy = s.match(/^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})$/);
  var key = s.match(/^(\\d{4})(\\d{2})(\\d{2})$/);
  var y, m, d;
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; }
  else if (key) { y = +key[1]; m = +key[2]; d = +key[3]; }
  else throw new Error('Invalid Effective Date: ' + s);
  var check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) throw new Error('Invalid calendar date: ' + s);
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function effectiveDateToKey(value) { return normaliseEffectiveDate(value).replace(/-/g, ''); }
function formatEffectiveDate(value) { var iso = normaliseEffectiveDate(value).split('-'); return iso[2] + '.' + iso[1] + '.' + iso[0]; }
`;

let model = read('data-model.js');
if (!model.includes('canonical date-only helpers (added by true-date patch)')) {
  const old = model;
  model = replaceFunction(model, 'parseDateToKey', `function parseDateToKey(dateValue) {\n  try { return effectiveDateToKey(dateValue); } catch (e) { return ''; }\n}`);
  model = model.replace('function parseDateToKey(dateValue)', dateHelpers + '\nfunction parseDateToKey(dateValue)');
  model = model.replace(/function createMovement\(flatRec, sourceType\)\s*\{/, '$&\n  flatRec.dateISO = normaliseEffectiveDate(flatRec.dateISO || flatRec.date);\n  flatRec.date = formatEffectiveDate(flatRec.dateISO);');
  model = model.replace(/function updateMovementFromFlat\(existing, flatRec, sourceType\)\s*\{/, '$&\n  flatRec.dateISO = normaliseEffectiveDate(flatRec.dateISO || flatRec.date);\n  flatRec.date = formatEffectiveDate(flatRec.dateISO);');
  model = model.replace(/effectiveDate:\s*flatRec\.date\s*,/g, 'effectiveDate: flatRec.dateISO,');
  if (model === old) throw new Error('data-model.js was not patched.');
  write('data-model.js', model);
}

let validation = read('validation-engine.js');
if (!validation.includes('true-date patch')) {
  validation = replaceFunction(validation, 'valParseDateKey', `function valParseDateKey(dateValue) {\n  // true-date patch: accepts YYYY-MM-DD and legacy D.M.YYYY\n  try { return typeof effectiveDateToKey === 'function' ? effectiveDateToKey(dateValue) : ''; } catch (e) { return ''; }\n}`);
  validation = validation.replace('Date does not follow DD.MM.YYYY format.', 'Date must be YYYY-MM-DD (legacy D.M.YYYY is accepted during migration).');
  write('validation-engine.js', validation);
}

let engine = read('as-of-date-engine.js');
if (!engine.includes('getOccupancyAtDate(inputDate)')) {
  engine = replaceFunction(engine, 'getOccupancyAtDisplayDate', `function getOccupancyAtDisplayDate(displayDate) {\n  return getOccupancyAtDate(displayDate);\n}\n\nfunction getOccupancyAtDate(inputDate) {\n  var dk;\n  try { dk = effectiveDateToKey(inputDate); } catch (e) { dk = formatTodayKey(); }\n  return getOccupancySnapshot(dk);\n}`);
  write('as-of-date-engine.js', engine);
}

let app = read('app.js');
if (!app.includes('normaliseLocalRecordDates')) {
  const appHelpers = `
// ---- true-date patch ------------------------------------------------------
function normaliseLocalRecordDates(list) {
  return (list || []).map(function(r) {
    try {
      r.dateISO = normaliseEffectiveDate(r.dateISO || r.date);
      r.date = formatEffectiveDate(r.dateISO); // screen display only
    } catch (e) { r.dateISO = ''; }
    return r;
  });
}
records = normaliseLocalRecordDates(records);
`;
  const marker = 'let sortState';
  const at = app.indexOf(marker);
  if (at < 0) throw new Error('Could not find app.js initialisation marker.');
  app = app.slice(0, at) + appHelpers + '\n' + app.slice(at);
  app = app.replace(/function parseDateKey\(dateStr\)\s*\{[\s\S]*?\n\}/, `function parseDateKey(dateValue) {\n  try { return effectiveDateToKey(dateValue); } catch (e) { return ''; }\n}`);
  app = app.replace(/async function doSaveToSheets\(\)\s*\{/, '$&\n  records = normaliseLocalRecordDates(records);');
  app = app.replace(/r\.date, r\.remark, r\.postingnotice/g, '(r.dateISO || normaliseEffectiveDate(r.date)), r.remark, r.postingnotice');
  app = app.replace(/date:\s*colMap\.date !== undefined \? String\(row\[colMap\.date\]\)\.trim\(\) : ''/g, `date: colMap.date !== undefined ? String(row[colMap.date]).trim() : '',\n      dateISO: colMap.date !== undefined ? normaliseEffectiveDate(row[colMap.date]) : ''`);
  write('app.js', app);
}

let gas = read('Google-App-Script.txt');
if (!gas.includes('function toSheetEffectiveDate(value)')) {
  const gasHelpers = `
function toSheetEffectiveDate(value) {
  var iso = normaliseEffectiveDate(value);
  var p = iso.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function sheetDateToIso(value) {
  if (!(value instanceof Date) || isNaN(value)) return '';
  return value.getFullYear() + '-' + String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
}
`;
  gas = gas.replace('function rowVal(', gasHelpers + '\nfunction rowVal(');
  gas = gas.replace(/textCols:\s*\[7,\s*8\]/, 'textCols: [8]');
  gas = gas.replace(/function writeSheetWithHeaders\(name, schema, rows\)\s*\{/, `$&\n  if (name === 'Movements' && rows && rows.length) {\n    rows = rows.map(function(row) { var copy = row.slice(); copy[6] = toSheetEffectiveDate(copy[6]); return copy; });\n  }`);
  gas = gas.replace(/function formatMasterSheet\(name, schema, rowCount\)\s*\{/, `$&\n  if (name === 'Movements' && rowCount > 1) {\n    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name).getRange(2, 7, rowCount - 1, 1).setNumberFormat('dd.MM.yyyy');\n  }`);
  gas += `\n\nfunction migrateMovementDatesToRealDates() {\n  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Movements');\n  if (!sheet || sheet.getLastRow() < 2) return;\n  var range = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1);\n  var values = range.getValues();\n  for (var i = 0; i < values.length; i++) if (values[i][0] !== '') values[i][0] = toSheetEffectiveDate(values[i][0]);\n  range.setValues(values).setNumberFormat('dd.MM.yyyy');\n}\n`;
  write('Google-App-Script.txt', gas);
}

console.log('Patch complete. Backups are in .date-patch-backup/. Review changes with: git diff');
