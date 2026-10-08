import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';

const testDir = await mkdtemp(path.join(os.tmpdir(), 'pelsa-import-test-'));
process.env.DATA_DIR = testDir;
process.env.DATA_KEY = randomBytes(32).toString('hex');
process.env.APP_URL = 'https://club.example.test';
const { db, decrypt } = await import('../server/db.mjs');
const { importMembersFromExcel } = await import('../scripts/import-members.mjs');

after(async () => {
  db.close();
  const target = path.resolve(testDir); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(target).startsWith('pelsa-import-test-'));
  await rm(target, { recursive:true, force:true });
});

test('Excel import approves every row, permits repeated DUI and is idempotent', async () => {
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Miembros');
  sheet.addRow(['NOMBRE','WHATSAPP','CORREO','DUI']);
  sheet.addRow(['Persona Uno',70000000,'uno@example.test','012345678']);
  sheet.addRow(['Persona Uno duplicada',70000000,'uno@example.test','012345678']);
  sheet.addRow(['Persona Dos','50371111111','dos@example.test','123456789']);
  const input = path.join(testDir,'miembros.xlsx'); await workbook.xlsx.writeFile(input);

  const first = await importMembersFromExcel(input);
  assert.equal(first.imported,3); assert.equal(first.duplicates,1); assert.equal(first.existing,0);
  const members = db.prepare('SELECT * FROM members ORDER BY number').all();
  assert.deepEqual(members.map(member => [member.number,member.status,member.front_file]),[[1,'approved',''],[2,'approved',''],[3,'approved','']]);
  assert.ok(members.every(member => member.branch_preference === 'san_salvador'));
  assert.equal(decrypt(members[0].dui_encrypted).toString(),'012345678'); assert.equal(members[0].whatsapp,'50370000000'); assert.equal(members[0].token.length,48);
  assert.equal(decrypt(members[1].dui_encrypted).toString(),'012345678'); assert.notEqual(members[0].dui_hash,members[1].dui_hash);
  const report = await readFile(first.reportPath,'utf8'); assert.match(report,/https:\/\/club\.example\.test\/m\//);

  const second = await importMembersFromExcel(input);
  assert.equal(second.imported,0); assert.equal(second.existing,3); assert.equal(second.duplicates,1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM members').get().count,3);

  const sanMiguelWorkbook = new ExcelJS.Workbook(); const sanMiguelSheet = sanMiguelWorkbook.addWorksheet('Respuestas de formulario 1');
  sanMiguelSheet.addRow(['Marca temporal','Nombre','Whatsapp','Correo','Sube una fotografía de tu DUI (frente y reverso)','DUI']);
  sanMiguelSheet.addRow([new Date(),'Persona San Miguel',72222222,'miguel@example.test','https://drive.example.test/1','987654321']);
  sanMiguelSheet.addRow([new Date(),'Persona San Miguel duplicada',73333333,'','','987654321']);
  sanMiguelSheet.addRow([new Date(),'Persona sin DUI',74444444,'','','']);
  const sanMiguelInput = path.join(testDir,'miembros-san-miguel.xlsx'); await sanMiguelWorkbook.xlsx.writeFile(sanMiguelInput);
  const sanMiguelResult = await importMembersFromExcel(sanMiguelInput,{defaultBranch:'san_miguel'}); assert.equal(sanMiguelResult.imported,3); assert.equal(sanMiguelResult.duplicates,1);
  const sanMiguelMembers = db.prepare("SELECT * FROM members WHERE branch_preference='san_miguel' ORDER BY number").all();
  assert.equal(sanMiguelMembers.length,3); assert.ok(sanMiguelMembers.every(member => member.status === 'approved'));
  assert.equal(sanMiguelMembers[1].email,''); assert.equal(decrypt(sanMiguelMembers[2].dui_encrypted).toString(),'');
});
