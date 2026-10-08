import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { audit, dataDir, db, duiHash, encrypt } from '../server/db.mjs';

const appUrl = new URL(process.env.APP_URL || 'http://localhost:4173').origin;
const expectedHeaders = ['NOMBRE', 'WHATSAPP', 'CORREO', 'DUI'];
const cleanText = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const normalizeBranch = value => {
  const clean = cleanText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('_', ' ');
  if (['san salvador', 'ss'].includes(clean)) return 'san_salvador';
  if (['san miguel', 'sm'].includes(clean)) return 'san_miguel';
  if (['ambas', 'ambos', 'san salvador y san miguel'].includes(clean)) return 'ambas';
  return '';
};
const cellDigits = cell => {
  const value = cell.value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return cleanText(cell.text || value).replace(/\D/g, '');
};
const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;

export async function importMembersFromExcel(filePath, { defaultBranch = 'san_salvador' } = {}) {
  if (!['san_salvador', 'san_miguel', 'ambas'].includes(defaultBranch)) throw new Error('La sucursal predeterminada debe ser san_salvador, san_miguel o ambas.');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(filePath));
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('El archivo no contiene ninguna hoja.');
  const headers = expectedHeaders.map((_, index) => cleanText(sheet.getCell(1, index + 1).text).toUpperCase());
  if (headers.some((header, index) => header !== expectedHeaders[index])) throw new Error(`La primera fila debe contener: ${expectedHeaders.join(', ')}.`);
  const optionalHeader = cleanText(sheet.getCell(1, 5).text).toUpperCase();
  if (optionalHeader && optionalHeader !== 'SUCURSAL') throw new Error('La quinta columna opcional debe llamarse SUCURSAL.');

  const candidates = []; const issues = []; const duplicateRows = []; const seenDui = new Map(); const seenRecord = new Map();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const name = cleanText(row.getCell(1).text);
    let whatsapp = cellDigits(row.getCell(2));
    const email = cleanText(row.getCell(3).text).toLowerCase();
    const dui = cellDigits(row.getCell(4));
    const branch = optionalHeader ? normalizeBranch(row.getCell(5).text) : defaultBranch;
    if (![name, whatsapp, email, dui].some(Boolean)) continue;
    if (whatsapp.length === 8) whatsapp = `503${whatsapp}`;
    const rowIssues = [];
    if (name.length < 3 || name.length > 120) rowIssues.push('nombre inválido');
    if (!/^503[267]\d{7}$/.test(whatsapp)) rowIssues.push('WhatsApp inválido');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) rowIssues.push('correo inválido');
    if (!/^\d{9}$/.test(dui)) rowIssues.push('DUI inválido');
    if (!branch) rowIssues.push('sucursal inválida');
    if (rowIssues.length) { issues.push(`Fila ${rowNumber}: ${rowIssues.join(', ')}`); continue; }
    if (seenDui.has(dui)) duplicateRows.push({ row: rowNumber, keptRow: seenDui.get(dui) });
    else seenDui.set(dui, rowNumber);
    const signature = [name.toLowerCase(), whatsapp, email, dui].join('|');
    const occurrence = (seenRecord.get(signature) || 0) + 1; seenRecord.set(signature, occurrence);
    candidates.push({ rowNumber, name, whatsapp, email, dui, branch, importKey:duiHash(`legacy-excel-v2|${signature}|${occurrence}`) });
  }
  if (issues.length) throw new Error(`No se importó ningún miembro. Corrige estos problemas:\n${issues.slice(0, 20).join('\n')}${issues.length > 20 ? `\n…y ${issues.length - 20} más.` : ''}`);
  if (!candidates.length) throw new Error('No encontramos filas válidas para importar.');

  const imported = []; const existing = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE counters SET value=MAX(value,COALESCE((SELECT MAX(number) FROM members),0)) WHERE name='member'").run();
    const findImported = db.prepare('SELECT id,number FROM members WHERE import_key=?');
    const updateImportedBranch = db.prepare('UPDATE members SET branch_preference=? WHERE id=?');
    const findMember = db.prepare('SELECT id,number,name,email,whatsapp,import_key FROM members WHERE dui_hash=?');
    const claimExisting = db.prepare('UPDATE members SET import_key=?,branch_preference=? WHERE id=? AND import_key IS NULL');
    const nextNumber = db.prepare("UPDATE counters SET value=value+1 WHERE name='member' RETURNING value");
    const insert = db.prepare("INSERT INTO members (name,email,whatsapp,dui_hash,dui_encrypted,front_file,back_file,branch_preference,status,number,token,review_note,consent_at,consent_version,approved_at,import_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const member of candidates) {
      const alreadyImported = findImported.get(member.importKey);
      if (alreadyImported) { updateImportedBranch.run(member.branch, alreadyImported.id); existing.push({ rowNumber:member.rowNumber, number:alreadyImported.number == null ? '' : String(alreadyImported.number).padStart(6, '0') }); continue; }
      const baseHash = duiHash(member.dui); const found = findMember.get(baseHash);
      if (found && found.import_key == null && found.name === member.name && found.email === member.email && found.whatsapp === member.whatsapp) {
        claimExisting.run(member.importKey, member.branch, found.id);
        existing.push({ rowNumber:member.rowNumber, number:found.number == null ? '' : String(found.number).padStart(6, '0') });
        continue;
      }
      const hash = found ? duiHash(`legacy-excel-duplicate-v2|${member.importKey}`) : baseHash;
      const number = nextNumber.get().value; const token = randomBytes(24).toString('hex'); const now = new Date().toISOString();
      const result = insert.run(member.name, member.email, member.whatsapp, hash, encrypt(Buffer.from(member.dui)), '', '', member.branch, 'approved', number, token, 'Importado desde Excel como miembro aprobado; los DUI repetidos fueron autorizados para el padrón inicial.', now, 'legacy-excel-import-2026-10', now, member.importKey);
      audit('system:excel-import', 'member.imported', result.lastInsertRowid);
      imported.push({ name:member.name, number:String(number).padStart(6, '0'), profileUrl:`${appUrl}/m/${token}` });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  const reportDir = path.join(dataDir, 'imports'); await mkdir(reportDir, { recursive:true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const reportPath = path.join(reportDir, `miembros-importados-${stamp}.csv`);
  const report = ['NOMBRE,NUMERO_MIEMBRO,URL_PERFIL', ...imported.map(item => [item.name,item.number,item.profileUrl].map(csvCell).join(','))].join('\r\n');
  await writeFile(reportPath, `\uFEFF${report}`, 'utf8');
  return { sourceRows:sheet.rowCount - 1, imported:imported.length, existing:existing.length, duplicates:duplicateRows.length, duplicateRows, reportPath };
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const filePath = process.argv[2]; const defaultBranch = process.argv[3] || 'san_salvador';
  if (!filePath) { console.error('Uso: npm run import-members -- "ruta\\archivo.xlsx" [san_salvador|san_miguel|ambas]'); process.exitCode = 1; }
  else {
    try {
      const result = await importMembersFromExcel(filePath, { defaultBranch });
      console.log(`Importación completada: ${result.imported} miembros nuevos, ${result.existing} ya existentes y ${result.duplicates} filas con DUI repetido incluidas.`);
      if (result.duplicateRows.length) console.log(`Filas con DUI repetido incluidas: ${result.duplicateRows.map(item => `${item.row} (repite la ${item.keptRow})`).join(', ')}.`);
      console.log(`Reporte privado: ${result.reportPath}`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
