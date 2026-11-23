// main.ts is mend, the CLI SPEC.md specifies: the command line, the output and exit codes, safe paths, format
// detection, JSON edits and the all-or-nothing write (sections 1 to 4, 9 and 10), and line matching at three tiers
// (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches (section 8). Node 22,
// the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, so the output can print `R old -> new` lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file split into lines: its own line break, and whether it ends with one. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line as a tier reads it: tier 0 exact, tier 1 trailing spaces and tabs off, tier 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at a tier; overlaps count. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > file.length) return out;
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(file[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at least once, with its positions; null when none. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line) or a fresh line. */
type NewLine = { ctx: true; oIdx: number } | { ctx: false; text: string };

/** Replace O's lines at pos by N, re-indenting fresh lines at tier 2 (SPEC.md section 5). */
function applyReplace(file: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out = file.slice(0, pos);
  let leadF = '';
  let leadP = '';
  if (tier === 2 && o.length > 0) {
    leadF = /^[\t ]*/.exec(file[pos]!)![0];
    leadP = /^[\t ]*/.exec(o[0]!)![0];
  }
  for (const item of n) {
    if (item.ctx) out.push(file[pos + item.oIdx]!);
    else if (tier === 2 && item.text !== '' && !/^[ \t]+$/.test(item.text) && item.text.startsWith(leadP)) out.push(leadF + item.text.slice(leadP.length));
    else out.push(item.text);
  }
  out.push(...file.slice(pos + o.length));
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A leading a/ or b/ is removed from either path (SPEC.md section 6). */
function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

const devNull = (p: string): string | null => (p === '/dev/null' ? null : p);

/** Parse a unified diff into its sections (SPEC.md section 6). */
function unifiedSections(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hunk: Hunk | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameOld: string | null = null;
  let renameNew: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let createFlag = false;
  let removeFlag = false;

  const endBody = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const b = hunk.body[hunk.body.length - 1]!;
      if ((b.kind === ' ' || b.kind === '') && b.text === '') hunk.body.pop();
      else break;
    }
    hunk = null;
  };
  const endSection = (): void => {
    endBody();
    if (cur === null) return;
    cur.oldPath = pairOld ?? renameOld ?? diffOld;
    cur.newPath = pairNew ?? renameNew ?? diffNew;
    cur.create = createFlag;
    cur.remove = removeFlag;
    sections.push(cur);
    cur = null;
    inHeader = false;
  };
  const startSection = (dOld: string | null, dNew: string | null): void => {
    endSection();
    cur = { oldPath: null, newPath: null, create: false, remove: false, hunks: [] };
    inHeader = true;
    pairOld = null;
    pairNew = null;
    renameOld = null;
    renameNew = null;
    diffOld = dOld;
    diffNew = dNew;
    createFlag = false;
    removeFlag = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!.trim());
      i++;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      const oldP = devNull(stripPrefix(headerPath(line)));
      const newP = devNull(stripPrefix(headerPath(next)));
      if (cur === null) {
        startSection(null, null);
        pairOld = oldP;
        pairNew = newP;
      } else if (inHeader && pairOld === null) {
        pairOld = oldP;
        pairNew = newP;
      } else {
        startSection(null, null);
        pairOld = oldP;
        pairNew = newP;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      if (hunk !== null) {
        hunk.body.push({ kind: '-', text: line.slice(1) });
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      endBody();
      hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      inHeader = false;
      i++;
      continue;
    }
    if (hunk !== null) {
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line === '') hunk.body.push({ kind: '', text: '' });
        else hunk.body.push({ kind: line[0] as ' ' | '-' | '+' | '\\', text: line.slice(1) });
        i++;
        continue;
      }
      endBody();
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) createFlag = true;
      else if (line.startsWith('deleted file mode')) removeFlag = true;
    }
    i++;
  }
  endSection();
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoFinal(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const b = body[j]!;
    if (b.kind === ' ' || b.kind === '' || b.kind === '+') {
      const after = body[j + 1];
      return after !== undefined && after.kind === '\\';
    }
  }
  return false;
}

/** Split a hunk body into its old lines O and its new lines N. */
function hunkON(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '') {
      o.push(b.text);
      n.push({ ctx: true, oIdx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ ctx: false, text: b.text });
  }
  return { o, n };
}

/** One unified section as one edit. */
function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const kind = sec.create ? 'create' : sec.remove ? 'delete' : sec.oldPath !== sec.newPath ? 'move' : 'change';
  return (tree) => {
    if (kind === 'create') {
      const p = sec.newPath;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '/dev/null');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let lastPlusHunk = -1;
      let lastPlus = -1;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((b, bi) => {
          if (b.kind === '+') {
            lines.push(b.text);
            lastPlusHunk = hi;
            lastPlus = bi;
          }
        });
      });
      let noFinal = false;
      if (lastPlusHunk >= 0) {
        const after = sec.hunks[lastPlusHunk]!.body[lastPlus + 1];
        if (after !== undefined && after.kind === '\\') noFinal = true;
      }
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = sec.oldPath;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '/dev/null');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = sec.oldPath;
    if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '/dev/null');
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let newP: string | null = null;
    if (kind === 'move') {
      newP = sec.newPath;
      if (newP === null || !safe(newP)) throw new Fail('unsafe', newP ?? '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
    }
    let { lines, br, final } = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = hunkON(h.body);
      const noFinal = hunkNoFinal(h.body);
      if (o.length === 0) {
        const pos = Math.max(0, Math.min(h.a + d, lines.length));
        const atEnd = pos === lines.length;
        lines.splice(pos, 0, ...n.map((x) => (x.ctx ? '' : x.text)));
        if (atEnd) final = !noFinal;
        d += n.length;
      } else {
        const found = findTier(lines, o, strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let pos = found.occ[0]!;
        let best = Math.abs(pos - target);
        for (const q of found.occ) {
          const dist = Math.abs(q - target);
          if (dist < best) {
            best = dist;
            pos = q;
          }
        }
        const runsToEnd = pos + o.length === lines.length;
        lines = applyReplace(lines, pos, o, n, found.tier);
        if (runsToEnd) final = !noFinal;
        d += n.length - o.length;
      }
    }
    const after = joinFile(lines, br, final);
    if (kind === 'move') {
      tree.now.set(p, null);
      tree.now.set(newP!, after);
      tree.moves.push([p, newP!]);
    } else {
      tree.now.set(p, after);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedSectionEdit(s, strict));
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceBlocks(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as one edit. */
function searchReplaceBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const { lines: fl, br, final } = splitFile(before);
    const found = findTier(fl, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const n: NewLine[] = b.newLines.map((t) => ({ ctx: false, text: t }));
    tree.now.set(b.path, joinFile(applyReplace(fl, found.occ[0]!, b.oldLines, n, found.tier), br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return searchReplaceBlocks(lines).map((b) => searchReplaceBlockEdit(b, strict));
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4AChunk[];
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4aSectionPath(line: string, kind: 'add' | 'delete' | 'update'): string {
  const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
  return line.slice(prefix.length).trim();
}

/** Parse a V4A patch into its sections (SPEC.md section 8). */
function v4aSections(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const sk = v4aSectionKind(l);
    if (sk === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = v4aSectionPath(l, sk);
    const headerLine = i + 1;
    i++;
    if (sk === 'add') {
      const fileLines: string[] = [];
      while (i < last) {
        const m = lines[i]!;
        if (v4aSectionKind(m) !== null || m.trimEnd() === '*** End Patch') break;
        if (m.startsWith('+')) {
          fileLines.push(m.slice(1));
          i++;
        } else if (m === '') {
          fileLines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      sections.push({ kind: 'add', path, moveTo: null, lines: fileLines, chunks: [] });
    } else if (sk === 'delete') {
      while (i < last) {
        const m = lines[i]!;
        if (v4aSectionKind(m) !== null || m.trimEnd() === '*** End Patch') break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let chunk: V4AChunk | null = null;
      while (i < last) {
        const m = lines[i]!;
        if (v4aSectionKind(m) !== null || m.trimEnd() === '*** End Patch') break;
        if (m.startsWith('@@')) {
          chunk = { anchor: m.slice(2).trim() === '' ? null : m.slice(2).trim(), eof: false, body: [] };
          chunks.push(chunk);
          i++;
          continue;
        }
        if (m.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          chunk.eof = true;
          chunk = null;
          i++;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (chunk === null) {
            if (chunks.length === 0) {
              chunk = { anchor: null, eof: false, body: [] };
              chunks.push(chunk);
            } else throw new Exit2(`error: parse ${i + 1}`);
          }
          chunk.body.push(m === '' ? { kind: '', text: '' } : { kind: m[0] as ' ' | '-' | '+', text: m.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.body.length > 0) {
            const b = lc.body[lc.body.length - 1]!;
            if ((b.kind === ' ' || b.kind === '') && b.text === '') lc.body.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks });
    }
  }
  return sections;
}

/** One V4A section as one edit. */
function v4aSectionEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt: number | null = null;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && foundAt === null; t++) {
          for (let k = cursor; k < lines.length; k++) {
            if (norm(lines[k]!, t) === norm(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
        }
        if (foundAt === null) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ' || b.kind === '') {
          o.push(b.text);
          n.push({ ctx: true, oIdx: o.length - 1 });
        } else if (b.kind === '-') o.push(b.text);
        else if (b.kind === '+') n.push({ ctx: false, text: b.text });
      }
      if (o.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines.splice(pos, 0, ...n.map((x) => (x.ctx ? '' : x.text)));
        cursor = pos + n.length;
      } else {
        const top = strict ? 0 : 2;
        let found: { tier: number; pos: number } | null = null;
        for (let t = 0; t <= top && found === null; t++) {
          for (const pos of occurrences(lines, o, t)) {
            if (pos < cursor) continue;
            if (ch.eof && pos + o.length !== lines.length) continue;
            found = { tier: t, pos };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', sec.path);
        lines = applyReplace(lines, found.pos, o, n, found.tier);
        cursor = found.pos + n.length;
      }
    }
    const after = joinFile(lines, br, final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, after);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((s) => v4aSectionEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Rows: one per changed path, sorted in UTF-8 byte order; a successful move prints
  // `R old -> new` (keyed by the new path) instead of the D and A lines it covers.
  const movedOld = new Set(tree.moves.map(([o]) => o));
  const movedNew = new Map(tree.moves.map(([o, n]) => [n, o]));
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const oldPath = movedNew.get(p);
    if (oldPath !== undefined && tree.original(oldPath) !== null && tree.now.get(oldPath) === null) {
      rows.push({ key: p, text: `R ${oldPath} -> ${p}` });
      continue;
    }
    if (movedOld.has(p) && now === null) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
