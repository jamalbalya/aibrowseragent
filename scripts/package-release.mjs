#!/usr/bin/env node
/**
 * Produces the artifact that would be uploaded to the Chrome Web Store, and
 * records its SHA-256.
 *
 * A digest is only worth recording if the same source produces the same
 * digest, and the ordinary way of making a ZIP does not: the format stores a
 * modification time per entry, and directory iteration order is not promised
 * to be stable. Two builds of identical source then differ, and the recorded
 * digest identifies the run rather than the code — which is the opposite of
 * what recording it is for.
 *
 * So the archive is written here rather than shelled out to `zip`, and three
 * things are pinned:
 *
 *  1. **Entry order** is the sorted path, not whatever the filesystem
 *     returned.
 *  2. **Timestamps** are a fixed DOS date, identical for every entry. The
 *     real mtime says when the build machine ran, which is not a property of
 *     the release.
 *  3. **Compression** is raw deflate at a fixed level, with no extra fields
 *     and no data descriptors.
 *
 * The result is that `npm run package:release` twice on the same commit
 * yields byte-identical archives, which `--verify` checks by doing exactly
 * that. Anyone can then confirm the published artifact is the one this
 * repository describes, rather than taking it on trust.
 *
 * Writing the archive by hand also means no dependency is added to produce
 * the one file that reaches users. A packaging library is an odd place to
 * accept supply-chain risk.
 *
 * This produces the artifact. It does not publish it, and nothing here can:
 * uploading needs a developer account, a paid registration and an accepted
 * agreement, none of which exist in a repository. See
 * `docs/release/chrome-web-store-submission-checklist.md`.
 */
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const outDir = resolve(root, 'release');

/**
 * 1980-01-01 00:00:00, the earliest a DOS timestamp can express.
 *
 * Any fixed value works; this one is conventional for reproducible archives
 * and is obviously not a real build time, which is the point — a reader
 * should not mistake it for one.
 */
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Builds the archive in memory, so nothing partial is ever written. */
function buildArchive(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, contents } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(contents, { level: 9 });
    // Only take the compression if it actually helped. A file that grows
    // under deflate is stored, which is both smaller and what every other
    // packer does.
    const stored = deflated.length >= contents.length;
    const body = stored ? contents : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags: none, so no data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(contents.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return Buffer.concat([...locals, directory, end]);
}

function collect() {
  if (!existsSync(dist)) {
    console.error('✗ dist/ does not exist. Run `npm run build:release` first.');
    process.exit(1);
  }
  const files = walk(dist)
    .map((full) => ({
      name: relative(dist, full).split('\\').join('/'),
      contents: readFileSync(full),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (files.length === 0) {
    console.error('✗ dist/ is empty.');
    process.exit(1);
  }
  if (!files.some((file) => file.name === 'manifest.json')) {
    console.error('✗ dist/ holds no manifest.json, so it is not an extension package.');
    process.exit(1);
  }
  return files;
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const files = collect();
const archive = buildArchive(files);
const digest = createHash('sha256').update(archive).digest('hex');

if (process.argv.includes('--verify')) {
  // Determinism is checked by building the archive a second time from the
  // same bytes. That covers what this script controls — ordering,
  // timestamps, compression. It does not cover whether `vite build` is
  // itself reproducible, which is checked by the two-build comparison in
  // `docs/release/README.md` and is a different claim.
  const again = createHash('sha256').update(buildArchive(collect())).digest('hex');
  if (again !== digest) {
    console.error(`✗ Archive is not deterministic: ${digest} then ${again}.`);
    process.exit(1);
  }
  console.log(`✓ Archive is deterministic over repeated packing: ${digest}`);
}

mkdirSync(outDir, { recursive: true });
const name = `${pkg.name}-${pkg.version}.zip`;
const zipPath = resolve(outDir, name);
rmSync(zipPath, { force: true });
writeFileSync(zipPath, archive);

const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const summary = {
  artifact: name,
  version: pkg.version,
  manifestVersion: manifest.manifest_version,
  sha256: digest,
  bytes: archive.length,
  entries: files.map((file) => ({ path: file.name, bytes: file.contents.length })),
};
writeFileSync(resolve(outDir, `${name}.sha256`), `${digest}  ${name}\n`);
writeFileSync(resolve(outDir, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);

console.log(`✓ Packaged ${name}`);
console.log(`  sha256:  ${digest}`);
console.log(`  bytes:   ${archive.length}`);
console.log(`  entries: ${files.length}`);
console.log('  This artifact has NOT been submitted or published anywhere.');
