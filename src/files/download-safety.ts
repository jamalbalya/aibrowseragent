/**
 * Download filename safety.
 *
 * A download filename is the one string in a file workflow that a model or a
 * page can choose and that ends up naming something on the user's disk. Left
 * alone it is a path-traversal primitive, an overwrite primitive, and — with
 * the right extension — a way to put something executable where a person is
 * likely to double-click it.
 *
 * Two decisions shape this module.
 *
 * The first is that a filename is reduced to a **basename with no directory
 * component at all**. Chrome's downloads API accepts a relative subdirectory,
 * and supporting that would mean reasoning about which relative paths are
 * safe. Refusing every separator removes the question: there is no traversal
 * to escape when there is no path.
 *
 * The second is that this validates independently of whatever Chrome does.
 * Chrome rejects some of these itself, but relying on that would make the
 * guarantee a property of a browser version rather than of this code. What
 * Chrome actually does is checked separately, in a real browser, and recorded
 * there rather than assumed here.
 */

export type FilenameRejection =
  | 'EMPTY'
  | 'PATH_SEPARATOR'
  | 'TRAVERSAL'
  | 'ABSOLUTE'
  | 'CONTROL_CHARACTER'
  | 'RESERVED_NAME'
  | 'TOO_LONG'
  | 'EXECUTABLE'
  | 'BROWSER_EXTENSION';

export type FilenameVerdict =
  | { readonly ok: true; readonly filename: string }
  | { readonly ok: false; readonly code: FilenameRejection; readonly reason: string };

/**
 * Extensions this agent will not write to disk.
 *
 * Not a virus list — an agent scope decision. Nothing a browser automation
 * task legitimately needs is delivered as an executable, an installer or a
 * script, and a download is chosen by a model reasoning over page content
 * that an attacker may have written. Refusing the category outright is a
 * smaller surface than trying to decide when one is safe.
 *
 * `crx` and `xpi` are here for a second reason: a downloaded browser
 * extension must never become a route to installing one.
 */
export const REFUSED_EXTENSIONS: readonly string[] = [
  'exe',
  'com',
  'scr',
  'pif',
  'cpl',
  'msi',
  'msp',
  'msc',
  'hta',
  'jar',
  'reg',
  'bat',
  'cmd',
  'vb',
  'vbs',
  'vbe',
  'js',
  'jse',
  'ws',
  'wsf',
  'wsc',
  'wsh',
  'ps1',
  'ps1xml',
  'ps2',
  'psc1',
  'sh',
  'bash',
  'zsh',
  'command',
  'app',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'run',
  'bin',
  'out',
  'dll',
  'so',
  'dylib',
  'sys',
  'drv',
  'lnk',
  'url',
  'desktop',
  'inf',
  'scf',
  'crx',
  'xpi',
];

const EXTENSION_SET = new Set(REFUSED_EXTENSIONS);

/**
 * Names Windows treats as devices rather than files.
 *
 * Reserved with or without an extension, so `CON.txt` is still `CON`. Checked
 * on every platform: the extension is cross-platform and a name that is
 * dangerous on one of them is not made safe by the machine that chose it.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Chrome's own limit is filesystem-dependent; this is the conservative one. */
const MAX_FILENAME_LENGTH = 200;

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

export function isRefusedExtension(filename: string): boolean {
  return EXTENSION_SET.has(extensionOf(filename));
}

/**
 * Validates a filename for `chrome.downloads.download`.
 *
 * Rejects rather than repairs. A silently corrected name would put a file
 * somewhere the caller did not ask for, and "the download succeeded" would
 * then be true of a different file than the one requested.
 */
export function checkDownloadFilename(raw: string): FilenameVerdict {
  const candidate = raw.trim();

  if (candidate.length === 0) {
    return { ok: false, code: 'EMPTY', reason: 'A download needs a filename.' };
  }

  // Absolute paths first, so the message names the actual problem rather than
  // reporting a Windows drive letter as a stray separator.
  if (
    candidate.startsWith('/') ||
    /^[a-zA-Z]:[\\/]/.test(candidate) ||
    candidate.startsWith('\\\\')
  ) {
    return {
      ok: false,
      code: 'ABSOLUTE',
      reason: 'A download filename must not be an absolute path. Give a name, not a location.',
    };
  }

  if (candidate.includes('..')) {
    return {
      ok: false,
      code: 'TRAVERSAL',
      reason: 'A download filename must not contain "..".',
    };
  }

  if (candidate.includes('/') || candidate.includes('\\')) {
    return {
      ok: false,
      code: 'PATH_SEPARATOR',
      reason:
        'A download filename must not contain a directory separator. Files are saved to the ' +
        'browser’s download folder under a plain name.',
    };
  }

  // eslint-disable-next-line no-control-regex -- detecting control characters is the point.
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    return {
      ok: false,
      code: 'CONTROL_CHARACTER',
      reason: 'A download filename must not contain control characters.',
    };
  }

  if (candidate.length > MAX_FILENAME_LENGTH) {
    return {
      ok: false,
      code: 'TOO_LONG',
      reason: `A download filename must be ${MAX_FILENAME_LENGTH} characters or fewer.`,
    };
  }

  // A trailing dot or space is dropped by Windows, so "report.txt." and
  // "report.txt" name the same file — which makes the extension check
  // bypassable if the raw name is trusted.
  const normalised = candidate.replace(/[. ]+$/, '');
  if (normalised.length === 0) {
    return { ok: false, code: 'EMPTY', reason: 'A download needs a filename.' };
  }

  const stem = normalised.slice(
    0,
    normalised.indexOf('.') === -1 ? undefined : normalised.indexOf('.'),
  );
  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    return {
      ok: false,
      code: 'RESERVED_NAME',
      reason: `"${stem}" is a reserved device name and cannot be used as a filename.`,
    };
  }

  const extension = extensionOf(normalised);
  if (extension === 'crx' || extension === 'xpi') {
    return {
      ok: false,
      code: 'BROWSER_EXTENSION',
      reason: 'This agent does not download browser extensions.',
    };
  }
  if (EXTENSION_SET.has(extension)) {
    return {
      ok: false,
      code: 'EXECUTABLE',
      reason:
        `This agent does not download ".${extension}" files. Executables, installers and ` +
        'scripts are refused because a browser task never needs one and the choice is made ' +
        'from page content.',
    };
  }

  return { ok: true, filename: normalised };
}

/**
 * Derives a filename for a URL that did not come with one.
 *
 * Falls back to a fixed name rather than inventing something from the URL's
 * query or fragment, both of which are attacker-controllable on a link a
 * model chose to follow.
 */
export function filenameFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'download';
  }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const decoded = safeDecode(last);
  return decoded.length === 0 ? 'download' : decoded;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not worth failing over; the raw segment is still
    // put through `checkDownloadFilename` by the caller.
    return value;
  }
}
