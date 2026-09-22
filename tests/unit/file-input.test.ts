/**
 * @vitest-environment jsdom
 *
 * TEST-FILE-003 — file inputs in the page model, and the attachment logic.
 *
 * Two behaviours drove this work and are worth naming. A file input used to
 * be reported as a `textbox`, which told the model to type a path into it —
 * an action that cannot work. And a file input the page had hidden got no
 * handle at all, because the snapshot skips invisible elements, which is the
 * *normal* way upload controls are built: a styled button beside a hidden
 * input.
 *
 * **What this file cannot prove.** jsdom has no layout, so
 * `getBoundingClientRect` returns zeros and every element reads as invisible;
 * and it implements no `DataTransfer`, which is the only way to populate
 * `input.files`. So the visible/hidden discrimination and the real assignment
 * mechanism are proven in `tests/e2e/file-transfer.spec.ts`, against real
 * Chromium. Here the shims below stand in, and what is tested is the logic
 * around them: roles, reported attributes, resolution rules, `accept` and
 * `multiple` handling, event dispatch and the post-assignment verification.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ElementRegistry, extractSemanticPage, roleOf } from '@/content/semantic-tree';
import {
  performAttachFiles,
  performClearFiles,
  resolveActionable,
  resolveFileInput,
} from '@/content/interaction-engine';

Element.prototype.scrollIntoView = vi.fn();

/**
 * Minimal stand-ins for two things jsdom does not implement.
 *
 * Deliberately thin, and deliberately not clever: they collect files and hand
 * them back, which is the contract `performAttachFiles` relies on. They are
 * not evidence that Chromium behaves this way — the end-to-end test is.
 */
beforeAll(() => {
  class FakeDataTransfer {
    private readonly collected: File[] = [];
    readonly items = {
      add: (file: File): void => {
        this.collected.push(file);
      },
    };
    get files(): FileList {
      const list = this.collected;
      return Object.assign([...list], {
        item: (index: number) => list[index] ?? null,
        length: list.length,
      });
    }
  }
  vi.stubGlobal('DataTransfer', FakeDataTransfer);

  // jsdom's `files` is a read-only accessor, so assignment is a silent no-op
  // and the verification inside `performAttachFiles` would report a refusal.
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get(this: HTMLInputElement & { _files?: FileList }) {
      return this._files ?? Object.assign([], { item: () => null, length: 0 });
    },
    set(this: HTMLInputElement & { _files?: FileList }, value: FileList) {
      this._files = value;
    },
  });
});

function registryFor(html: string): { registry: ElementRegistry; element: HTMLInputElement } {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as HTMLInputElement;
  const registry = new ElementRegistry();
  // Registered directly rather than through a snapshot: the snapshot's
  // visibility filter is meaningless under jsdom, and what is under test here
  // is `resolveFileInput`, not the filter.
  registry.beginSnapshot();
  registry.register(element, 0);
  return { registry, element };
}

function input(html: string): HTMLInputElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLInputElement;
}

const FILE = { name: 'cv.pdf', mimeType: 'application/pdf', dataBase64: 'QUJD' };

describe('the page model', () => {
  it('reports a file input as its own role, not as a textbox', () => {
    // A model told this is a textbox will call browser.type on it.
    expect(roleOf(input('<input type="file">'))).toBe('file');
  });

  it.each([
    ['text', 'textbox'],
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['file', 'file'],
  ])('maps input type %s to role %s', (type, role) => {
    expect(roleOf(input(`<input type="${type}">`))).toBe(role);
  });

  it('reports accept and multiple so the model can pick the right file', () => {
    document.body.innerHTML = '<input type="file" accept=".pdf,image/*" multiple>';
    const page = extractSemanticPage(document, new ElementRegistry(), { includeText: false });
    const element = page.elements.find((e) => e.role === 'file');

    expect(element?.accept).toBe('.pdf,image/*');
    expect(element?.multiple).toBe(true);
  });

  it('omits the browser’s fake path instead of reporting it as a value', () => {
    // A file input's `value` is a synthesised "C:\fakepath\..." that says
    // nothing useful and looks like a real local path to a model.
    document.body.innerHTML = '<input type="file">';
    const page = extractSemanticPage(document, new ElementRegistry(), { includeText: false });
    expect(page.elements.find((e) => e.role === 'file')?.value).toBeUndefined();
  });

  it('reports a disabled file input as disabled', () => {
    document.body.innerHTML = '<input type="file" disabled>';
    const page = extractSemanticPage(document, new ElementRegistry(), { includeText: false });
    expect(page.elements.find((e) => e.role === 'file')?.enabled).toBe(false);
  });
});

describe('resolving a file input', () => {
  it('resolves an input that is not visible', () => {
    // The whole point of the separate resolver: the usual upload control
    // hides its input behind a styled button.
    const { registry } = registryFor('<input type="file" style="display:none">');
    expect(resolveFileInput(registry, 'e1-0').ok).toBe(true);
  });

  it('is refused by the ordinary resolver, which is why it has its own', () => {
    const { registry } = registryFor('<input type="file" style="display:none">');
    const ordinary = resolveActionable(registry, 'e1-0');
    expect(ordinary.ok).toBe(false);
    if (!ordinary.ok) expect(ordinary.error.failure).toBe('NOT_VISIBLE');
  });

  it('refuses a disabled input', () => {
    const { registry } = registryFor('<input type="file" disabled>');
    const resolved = resolveFileInput(registry, 'e1-0');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.failure).toBe('NOT_ENABLED');
  });

  it.each(['<input type="text">', '<textarea></textarea>', '<button>Go</button>'])(
    'refuses %s, which is not a file input',
    (html) => {
      const { registry } = registryFor(html);
      const resolved = resolveFileInput(registry, 'e1-0');
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) expect(resolved.error.failure).toBe('WRONG_ELEMENT_TYPE');
    },
  );

  it('refuses a handle from an earlier snapshot', () => {
    const { registry } = registryFor('<input type="file">');
    registry.beginSnapshot();
    const resolved = resolveFileInput(registry, 'e1-0');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.failure).toBe('STALE_HANDLE');
  });

  it('refuses a handle that was never issued', () => {
    // Same generation, so this is not staleness — the index simply does not
    // exist, and the two are reported differently because the fixes differ.
    const { registry } = registryFor('<input type="file">');
    const resolved = resolveFileInput(registry, 'e1-9');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.failure).toBe('UNKNOWN_HANDLE');
  });
});

describe('attaching', () => {
  it('puts the file into the input and reports its name back', () => {
    const element = input('<input type="file">');
    const result = performAttachFiles(element, [FILE]);

    expect(result.attached).toBe(1);
    expect(result.names).toEqual(['cv.pdf']);
    expect(element.files?.[0]?.name).toBe('cv.pdf');
    expect(element.files?.[0]?.type).toBe('application/pdf');
  });

  it('decodes the bytes rather than carrying the base64 through', () => {
    // "hello" is 5 bytes; its base64 is 8 characters. The size distinguishes
    // a decoded file from one holding the encoded string.
    const element = input('<input type="file">');
    performAttachFiles(element, [{ ...FILE, dataBase64: btoa('hello') }]);
    expect(element.files![0]!.size).toBe(5);
  });

  it('fires input and change so the page’s own code sees the attachment', () => {
    const element = input('<input type="file">');
    const seen: string[] = [];
    element.addEventListener('input', () => seen.push('input'));
    element.addEventListener('change', () => seen.push('change'));

    performAttachFiles(element, [FILE]);
    expect(seen).toEqual(['input', 'change']);
  });

  it('attaches several files when the input takes them, in order', () => {
    const element = input('<input type="file" multiple>');
    const result = performAttachFiles(element, [
      { ...FILE, name: 'first.pdf' },
      { ...FILE, name: 'second.pdf' },
    ]);
    expect(result.names).toEqual(['first.pdf', 'second.pdf']);
  });

  it('refuses several files on a single-file input rather than silently dropping one', () => {
    const element = input('<input type="file">');
    expect(() =>
      performAttachFiles(element, [
        { ...FILE, name: 'a.pdf' },
        { ...FILE, name: 'b.pdf' },
      ]),
    ).toThrow(/accepts one file/);
    expect(element.files).toHaveLength(0);
  });

  it('refuses a file the input’s accept excludes', () => {
    const element = input('<input type="file" accept=".pdf">');
    expect(() =>
      performAttachFiles(element, [
        { name: 'photo.png', mimeType: 'image/png', dataBase64: 'QQ==' },
      ]),
    ).toThrow(/does not match/);
    expect(element.files).toHaveLength(0);
  });

  it('honours accept by mime pattern as well as by extension', () => {
    const element = input('<input type="file" accept="image/*">');
    expect(() =>
      performAttachFiles(element, [
        { name: 'photo.png', mimeType: 'image/png', dataBase64: 'QQ==' },
      ]),
    ).not.toThrow();
  });

  it('reports the input as hidden when it was, which the trail records', () => {
    const element = input('<input type="file" style="display:none">');
    expect(performAttachFiles(element, [FILE]).inputWasHidden).toBe(true);
  });

  it('refuses an empty list rather than reporting an empty success', () => {
    const element = input('<input type="file">');
    expect(() => performAttachFiles(element, [])).toThrow();
  });

  it('reports a refusal when the page does not take the files', () => {
    // A page can define its own `files` accessor. A silent no-op would
    // otherwise be reported to the model as a successful upload.
    const element = input('<input type="file">');
    Object.defineProperty(element, 'files', {
      configurable: true,
      get: () => Object.assign([], { item: () => null, length: 0 }) as unknown as FileList,
      set: () => undefined,
    });

    expect(() => performAttachFiles(element, [FILE])).toThrow(/did not accept/);
  });

  it('clears an attachment, so a wrong file can be undone without a reload', () => {
    const element = input('<input type="file">');
    performAttachFiles(element, [FILE]);
    expect(element.files).toHaveLength(1);

    performClearFiles(element);
    expect(element.files).toHaveLength(0);
  });
});
