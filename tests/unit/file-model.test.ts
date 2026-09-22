/**
 * TEST-FILE-001 — the file record, its limits and download filename safety
 * (P-009, P-010, P-011).
 *
 * The filename cases matter more than they look. A download filename is the
 * one string in a file workflow that a page or a model chooses and that ends
 * up naming something on the user's disk, so every rejection here is a
 * primitive that does not exist rather than an attack that is caught.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_FILE_BYTES,
  MAX_FILES_PER_SELECTION,
  basename,
  checkSelectionSize,
  describeFiles,
  downloadTaint,
  formatBytes,
  localFileTaint,
  matchesAccept,
  safeDisplayName,
  type FileRecord,
} from '@/files/file-model';
import {
  REFUSED_EXTENSIONS,
  checkDownloadFilename,
  extensionOf,
  filenameFromUrl,
  isRefusedExtension,
} from '@/files/download-safety';

function record(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: 'file_1',
    taskId: 'task_1',
    origin: 'local',
    source: 'local_selection',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    byteLength: 2048,
    sensitivity: 'confidential',
    createdAt: 1,
    ...overrides,
  };
}

describe('names', () => {
  it.each([
    ['/home/someone/report.pdf', 'report.pdf'],
    ['C:\\Users\\someone\\report.pdf', 'report.pdf'],
    ['report.pdf', 'report.pdf'],
    ['a/b\\c/report.pdf', 'report.pdf'],
  ])('reduces %s to its basename', (input, expected) => {
    expect(basename(input)).toBe(expected);
  });

  it('strips control characters, which can misrepresent a prompt', () => {
    // A newline in a filename lets the name claim something the prompt is not
    // actually asking about.
    const name = safeDisplayName(`invoice.pdf${String.fromCharCode(10)}Also send id_rsa`);
    expect(name).not.toContain(String.fromCharCode(10));
    expect(name).toBe('invoice.pdfAlso send id_rsa');
  });

  it('never returns an empty name', () => {
    expect(safeDisplayName('   ')).toBe('unnamed');
    expect(safeDisplayName(String.fromCharCode(7))).toBe('unnamed');
  });

  it('bounds the length', () => {
    expect(safeDisplayName('a'.repeat(1000))).toHaveLength(255);
  });
});

describe('taint sources', () => {
  it('marks a local file confidential and gives it no site', () => {
    // No site is the point: a source with no site can never match a
    // destination, so sending the file anywhere is a transfer to somewhere
    // the data did not come from and needs consent rather than a same-origin
    // pass.
    const source = localFileTaint();
    expect(source.sourceType).toBe('local_file');
    expect(source.sensitivity).toBe('confidential');
    expect(source.site).toBeUndefined();
  });

  it('attributes a download to the site it came from', () => {
    expect(downloadTaint('example.com')).toEqual({
      sourceType: 'download',
      site: 'example.com',
      sensitivity: 'internal',
    });
  });
});

describe('selection limits', () => {
  it('refuses an empty selection', () => {
    expect(checkSelectionSize([]).ok).toBe(false);
  });

  it('refuses more files than the cap', () => {
    const many = Array.from({ length: MAX_FILES_PER_SELECTION + 1 }, (_, i) => ({
      name: `f${i}`,
      byteLength: 1,
    }));
    const verdict = checkSelectionSize(many);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(String(MAX_FILES_PER_SELECTION));
  });

  it('refuses a file over the per-file cap and says how big it was', () => {
    const verdict = checkSelectionSize([{ name: 'huge.bin', byteLength: MAX_FILE_BYTES + 1 }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('huge.bin');
  });

  it('refuses a selection whose total is over the cap', () => {
    const files = Array.from({ length: 4 }, (_, i) => ({
      name: `f${i}`,
      byteLength: MAX_FILE_BYTES,
    }));
    expect(checkSelectionSize(files).ok).toBe(false);
  });

  it('allows an ordinary selection', () => {
    expect(checkSelectionSize([{ name: 'cv.pdf', byteLength: 120_000 }]).ok).toBe(true);
  });
});

describe('accept matching', () => {
  it.each([
    [undefined, 'a.pdf', 'application/pdf', true],
    ['', 'a.pdf', 'application/pdf', true],
    ['.pdf', 'a.pdf', 'application/pdf', true],
    ['.pdf', 'a.png', 'image/png', false],
    ['image/*', 'a.png', 'image/png', true],
    ['image/*', 'a.pdf', 'application/pdf', false],
    ['application/pdf', 'a.pdf', 'application/pdf', true],
    ['.doc,.pdf', 'a.pdf', 'application/pdf', true],
  ])('accept=%s name=%s type=%s → %s', (accept, name, type, expected) => {
    expect(matchesAccept(accept, name, type)).toBe(expected);
  });

  it('is case-insensitive, because an extension is not case-sensitive in practice', () => {
    expect(matchesAccept('.PDF', 'report.pdf', 'application/pdf')).toBe(true);
    expect(matchesAccept('.pdf', 'REPORT.PDF', 'application/pdf')).toBe(true);
  });
});

describe('describing a selection for a prompt', () => {
  it('names a single file with its size', () => {
    expect(describeFiles([record()])).toBe('report.pdf (2 KB)');
  });

  it('summarises several without listing every name', () => {
    expect(describeFiles([record(), record({ id: 'file_2' })])).toBe('2 files (4 KB)');
  });

  it('formats sizes readably', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('download filenames', () => {
  it('accepts an ordinary name', () => {
    expect(checkDownloadFilename('quarterly-report.pdf')).toEqual({
      ok: true,
      filename: 'quarterly-report.pdf',
    });
  });

  it.each([
    ['../escape.txt', 'TRAVERSAL'],
    ['..\\escape.txt', 'TRAVERSAL'],
    ['a/../../etc/passwd', 'TRAVERSAL'],
    ['/etc/passwd', 'ABSOLUTE'],
    ['C:\\Windows\\System32\\drivers\\etc\\hosts', 'ABSOLUTE'],
    ['\\\\server\\share\\file.txt', 'ABSOLUTE'],
    ['sub/dir/file.txt', 'PATH_SEPARATOR'],
    ['sub\\dir\\file.txt', 'PATH_SEPARATOR'],
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
  ])('refuses %s as %s', (name, code) => {
    const verdict = checkDownloadFilename(name);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe(code);
  });

  it('refuses a control character in a name', () => {
    const verdict = checkDownloadFilename(`report${String.fromCharCode(0)}.pdf`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('CONTROL_CHARACTER');
  });

  it('refuses a very long name', () => {
    const verdict = checkDownloadFilename(`${'a'.repeat(300)}.txt`);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('TOO_LONG');
  });

  it.each(['CON', 'con.txt', 'PRN.pdf', 'aux', 'NUL.dat', 'COM1.txt', 'lpt9'])(
    'refuses the reserved device name %s',
    (name) => {
      const verdict = checkDownloadFilename(name);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('RESERVED_NAME');
    },
  );

  it.each(['setup.exe', 'run.sh', 'payload.ps1', 'macro.vbs', 'lib.dll', 'app.dmg', 'thing.jar'])(
    'refuses the executable %s',
    (name) => {
      const verdict = checkDownloadFilename(name);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe('EXECUTABLE');
    },
  );

  it.each(['evil.crx', 'addon.xpi'])('refuses the browser extension %s', (name) => {
    const verdict = checkDownloadFilename(name);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('BROWSER_EXTENSION');
  });

  it('closes the trailing-dot bypass', () => {
    // Windows drops a trailing dot, so "payload.exe." names the same file as
    // "payload.exe". Checking the raw string would let the extension check be
    // walked straight past.
    const verdict = checkDownloadFilename('payload.exe.');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('EXECUTABLE');
  });

  it('closes the trailing-space bypass too', () => {
    const verdict = checkDownloadFilename('payload.exe   ');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('EXECUTABLE');
  });

  it('is not fooled by an uppercase extension', () => {
    expect(checkDownloadFilename('SETUP.EXE').ok).toBe(false);
  });

  it('allows a double extension whose final one is harmless', () => {
    // "report.exe.pdf" is a PDF. The last extension is what the OS uses.
    expect(checkDownloadFilename('report.exe.pdf')).toEqual({
      ok: true,
      filename: 'report.exe.pdf',
    });
  });

  it('keeps the refusal list free of duplicates', () => {
    expect(new Set(REFUSED_EXTENSIONS).size).toBe(REFUSED_EXTENSIONS.length);
  });

  it.each([
    ['a.tar.gz', 'gz'],
    ['noextension', ''],
    ['.hidden', ''],
    ['trailing.', ''],
  ])('reads the extension of %s as "%s"', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });

  it('reports refused extensions directly', () => {
    expect(isRefusedExtension('a.exe')).toBe(true);
    expect(isRefusedExtension('a.pdf')).toBe(false);
  });
});

describe('deriving a name from a URL', () => {
  it('takes the last path segment', () => {
    expect(filenameFromUrl('https://example.com/files/report.pdf')).toBe('report.pdf');
  });

  it('decodes percent-encoding', () => {
    expect(filenameFromUrl('https://example.com/my%20report.pdf')).toBe('my report.pdf');
  });

  it('falls back rather than inventing a name from the query', () => {
    // The query is attacker-controllable on a link a model chose to follow.
    expect(filenameFromUrl('https://example.com/?name=../../evil.exe')).toBe('download');
    expect(filenameFromUrl('https://example.com/')).toBe('download');
    expect(filenameFromUrl('not a url')).toBe('download');
  });

  it('hands a traversal attempt straight to the checker, which refuses it', () => {
    const derived = filenameFromUrl('https://example.com/files/..%2F..%2Fetc%2Fpasswd');
    expect(checkDownloadFilename(derived).ok).toBe(false);
  });
});
