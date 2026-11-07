/**
 * Cek urutan deklarasi: variabel `const`/`let` yang dipakai **sebelum**
 * dideklarasikan di blok yang sama akan meledak saat runtime
 * ("Cannot access 'x' before initialization") — dan `tsc` tidak menangkapnya
 * kalau pemakaiannya ada di dalam callback yang dieksekusi langsung
 * (mis. `.map(...)`).
 *
 * Skrip ini menelusuri AST `src/*.ts`, dan melaporkan pemakaian yang berada di
 * jalur eksekusi langsung (`const skills` dipakai `.map()` sebelum dibuat =
 * error, sudah pernah kejadian).
 *
 *   npm run check:order          # semua berkas di src/
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const roots = process.argv.slice(2);
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (full.endsWith('.ts')) files.push(full);
  }
};
for (const root of roots.length ? roots : ['src']) walk(root);

/** Blok terdekat (tempat `const` hidup). */
function scopeOf(node) {
  let p = node.parent;
  while (p && !ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isModuleBlock(p) && !ts.isCaseBlock(p)) {
    p = p.parent;
  }
  return p;
}

/** True kalau node ada di jalur eksekusi langsung (bukan closure yang ditunda). */
function eager(node) {
  let cur = node;
  while (cur && cur.parent) {
    const parent = cur.parent;
    if (ts.isFunctionLike(parent)) {
      const gp = parent.parent;
      // .map(cb) / forEach(cb) / IIFE => jalan sekarang
      if (gp && (ts.isCallExpression(gp) || ts.isNewExpression(gp))) {
        // .then()/.catch()/.finally() jalan belakangan: bukan jalur langsung.
        const callee = gp.expression;
        if (callee && ts.isPropertyAccessExpression(callee) && ['then', 'catch', 'finally'].includes(callee.name.text)) {
          return false;
        }
        if (gp.expression === parent) return true;
        if (gp.arguments && gp.arguments.includes(parent)) return true;
      }
      if (gp && ts.isPropertyAccessExpression(gp) && gp.parent && ts.isCallExpression(gp.parent)) {
        const call = gp.parent;
        // .then()/.catch()/.finally() jalan belakangan: bukan jalur langsung.
        if (['then', 'catch', 'finally'].includes(gp.name.text)) return false;
        if (call.arguments && call.arguments.includes(parent)) return true;
      }
      return false;
    }
    cur = parent;
  }
  return true;
}

/** Pemakaian di dalam for/for-of dilewati: di situ variabel loop menutupi. */
function insideLoop(node) {
  let cur = node;
  while (cur) {
    if (ts.isForOfStatement(cur) || ts.isForStatement(cur) || ts.isForInStatement(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

const problems = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const line = (pos) => src.getLineAndCharacterOfPosition(pos).line + 1;
  const decls = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = node.parent;
      const statement = list?.parent;
      // hanya `const x = ...` / `let x = ...`, bukan variabel loop
      if (ts.isVariableDeclarationList(list) && ts.isVariableStatement(statement)) {
        decls.push({ name: node.name.text, pos: node.getStart(src), scope: scopeOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);

  const report = (node) => {
    if (insideLoop(node) || !eager(node)) return;
    const parent = node.parent;
    const isDeclaration =
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && parent.name === node);
    if (isDeclaration) return;
    // Telusuri blok pemakaian lalu blok induknya. Deklarasi pertama yang
    // ditemukan menutupi nama itu; kalau letaknya sesudah pemakaian = masalah.
    let later = null;
    for (let scope = scopeOf(node); scope; scope = scope.parent ? scopeOf(scope) : null) {
      const decl = decls.find((d) => d.name === node.text && d.scope === scope);
      if (!decl) continue;
      if (decl.pos > node.getStart(src)) later = decl;
      break;
    }
    if (!later) return;
    problems.push(
      `${file}:${line(node.getStart(src))}  '${node.text}' dipakai sebelum dibuat (dideklarasikan baris ${line(later.pos)})`,
    );
  };
  const visit2 = (node) => {
    if (ts.isIdentifier(node)) report(node);
    ts.forEachChild(node, visit2);
  };
  visit2(src);
}

if (problems.length) {
  console.error('❌ ada variabel yang dipakai sebelum dideklarasikan:');
  for (const p of [...new Set(problems)]) console.error('  ' + p);
  process.exit(1);
}
console.log(`✅ urutan deklarasi aman (${files.length} berkas)`);
