// The source the Linux leg hands to its container: a tar of exactly the
// commit's tree.
//
// `git archive` applies the archived tree's own .gitattributes: export-ignore
// drops paths and export-subst rewrites file contents, while GitHub's checkout
// ignores both. A ref could hide a failing test or a broken workflow that
// way, and `/.github export-ignore` is common in real repositories. So the
// archive is made from a scratch repository that borrows the commit's objects
// and unsets, in its info/attributes (which outranks every .gitattributes),
// each attribute that makes archive output differ from the blobs. Then the
// tar is read back and compared with `git ls-tree`: every path, mode, and
// content hash must match, and nothing else may be there. Anything the first
// step misses fails the leg instead of changing what the jobs test.
//
// Paths are compared as raw bytes (strings decoded as latin1), so names that
// are not valid UTF-8 stay distinct; messages show them decoded as UTF-8.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// text, eol, and working-tree-encoding would convert line endings and
// encodings, ident expands $Id$, and filter runs the host's filter drivers.
export const NEUTRAL_ATTRIBUTES =
  '* -export-ignore -export-subst -text -eol -ident -filter -working-tree-encoding\n';

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${r.stderr?.toString().trim() || r.error?.message}`);
  return r.stdout;
}

/**
 * Writes a tar of `sha`'s tree to `tar` and proves it holds that tree and
 * nothing else. On any failure the tar is removed, so a partial or unproven
 * archive never reaches a container.
 */
export function archiveCommit({ repo, sha, tar }) {
  try {
    makeArchive({ repo, sha, tar });
    const problems = compareArchive(readTar(readFileSync(tar)), treeEntries(repo, sha), {
      hash: objectHasher(repo),
    });
    if (problems.length) {
      const shown = problems.slice(0, 20).join('; ');
      throw new Error(
        `the archive of ${sha} differs from its tree (${problems.length}): ${shown}${problems.length > 20 ? '; ...' : ''}`
      );
    }
  } catch (err) {
    rmSync(tar, { force: true });
    throw err;
  }
}

function makeArchive({ repo, sha, tar }) {
  const objects = resolve(
    git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim(),
    'objects'
  );
  const format = git(['-C', repo, 'rev-parse', '--show-object-format']).toString().trim();
  const scratch = mkdtempSync(join(tmpdir(), 'abci-archive-'));
  try {
    git(['init', '-q', '--bare', `--object-format=${format}`, scratch]);
    writeFileSync(join(scratch, 'objects', 'info', 'alternates'), `${objects}\n`);
    mkdirSync(join(scratch, 'info'), { recursive: true });
    writeFileSync(join(scratch, 'info', 'attributes'), NEUTRAL_ATTRIBUTES);
    git(['--git-dir', scratch, 'archive', '--format=tar', '-o', tar, sha]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Path (raw bytes as latin1) to { mode, type, oid } for every entry of the commit's tree. */
export function treeEntries(repo, sha) {
  const out = git(['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', sha]).toString('latin1');
  const entries = new Map();
  for (const rec of out.split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    entries.set(rec.slice(tab + 1), { mode, type, oid });
  }
  return entries;
}

export function objectHasher(repo) {
  const format = git(['-C', repo, 'rev-parse', '--show-object-format']).toString().trim();
  return (content) =>
    createHash(format === 'sha256' ? 'sha256' : 'sha1')
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest('hex');
}

/** Entries of a ustar/pax archive as { path, type, mode, data, linkpath }, names as latin1. */
export function readTar(buf) {
  const entries = [];
  let pax = {};
  let off = 0;
  const str = (start, len) => {
    const s = buf.subarray(off + start, off + start + len);
    const end = s.indexOf(0);
    return s.subarray(0, end === -1 ? s.length : end).toString('latin1');
  };
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const type = str(156, 1) || '0';
    const prefix = str(345, 155);
    const name = str(0, 100);
    const mode = Number.parseInt(str(100, 8).trim() || '0', 8);
    const linkname = str(157, 100);
    const size = Number(pax.size ?? Number.parseInt(str(124, 12).trim() || '0', 8));
    const data = buf.subarray(off + 512, off + 512 + size);
    if (data.length !== size) throw new Error('truncated tar');
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'g') continue;
    if (type === 'x') {
      pax = parsePax(data);
      continue;
    }
    entries.push({
      path: pax.path ?? (prefix ? `${prefix}/${name}` : name),
      type,
      mode,
      data,
      linkpath: pax.linkpath ?? linkname,
    });
    pax = {};
  }
  return entries;
}

function parsePax(data) {
  const fields = {};
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const len = Number(data.subarray(i, space).toString());
    const [key, ...value] = data
      .subarray(space + 1, i + len - 1)
      .toString('latin1')
      .split('=');
    fields[key] = value.join('=');
    i += len;
  }
  return fields;
}

/**
 * Differences between archive entries and tree entries. Directories only need
 * to exist for submodules (git archive writes them empty); every blob must be
 * there with its executable bit and content, every symlink with its target.
 */
export function compareArchive(archived, tree, { hash }) {
  const problems = [];
  const show = (path) => Buffer.from(path, 'latin1').toString('utf8');
  const seen = new Set();
  for (const e of archived) {
    const path = e.path.replace(/\/$/, '');
    if (e.type === '5') {
      if (tree.get(path)?.type === 'commit') seen.add(path);
      continue;
    }
    const want = tree.get(path);
    if (!want || want.type !== 'blob') {
      problems.push(`${show(path)}: not in the tree`);
      continue;
    }
    seen.add(path);
    if (want.mode === '120000') {
      if (e.type !== '2') problems.push(`${show(path)}: not a symlink`);
      else if (hash(Buffer.from(e.linkpath, 'latin1')) !== want.oid)
        problems.push(`${show(path)}: symlink target differs`);
      continue;
    }
    if (e.type !== '0') {
      problems.push(`${show(path)}: not a regular file`);
      continue;
    }
    if (((e.mode & 0o100) !== 0) !== (want.mode === '100755'))
      problems.push(`${show(path)}: executable bit differs`);
    if (hash(e.data) !== want.oid) problems.push(`${show(path)}: content differs`);
  }
  for (const path of tree.keys()) if (!seen.has(path)) problems.push(`${show(path)}: missing`);
  return problems;
}
