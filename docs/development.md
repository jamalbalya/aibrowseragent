# Development

## Requirements

Node.js 20.11+, Chrome 116+ (the Side Panel API's minimum).

## Setup

```bash
npm install
npm run build
```

Load `dist/` as an unpacked extension at `chrome://extensions` with Developer
mode enabled.

## Commands

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm run dev`       | Rebuild on change. Reload the extension in Chrome to pick up changes |
| `npm run build`     | Production build into `dist/`                                        |
| `npm run typecheck` | Strict TypeScript, no emit                                           |
| `npm run lint`      | ESLint with type-aware rules                                         |
| `npm test`          | Full test suite                                                      |
| `npm run verify`    | Everything CI runs, in the same order                                |

After a rebuild, click the reload icon on the extension card in
`chrome://extensions`. A service-worker change needs that reload; a side-panel
change needs the panel reopened.

## Build layout

Two passes, because they produce different module formats:

1. `vite.config.ts` — side panel (HTML + React) and service worker, as ES
   modules. MV3 supports `"type": "module"` for the worker.
2. `vite.content.config.ts` — content script as a single self-contained IIFE. A
   script registered under `content_scripts` is a **classic script** and cannot
   use ES module syntax. `scripts/validate-package.mjs` fails the build if
   module syntax appears in the emitted content script.

`scripts/build.mjs` runs both, then rewrites the manifest's side-panel path to
where Vite actually emitted the HTML.

## Debugging

| Surface        | How to open its console                                    |
| -------------- | ---------------------------------------------------------- |
| Service worker | `chrome://extensions` → the extension → **service worker** |
| Side panel     | Right-click inside the panel → **Inspect**                 |
| Content script | The page's own DevTools console                            |

Set the log level to `debug` in Settings for verbose output. The logger
redacts every message and context object, so debug logging cannot leak a
credential.

## Conventions

### Strict TypeScript

`exactOptionalPropertyTypes` is on, so an optional property is spread
conditionally rather than assigned `undefined`:

```ts
// Correct
return { ...base, ...(value === undefined ? {} : { value }) };

// Rejected by the compiler
return { ...base, value };
```

`any` is banned. `unknown` plus a type guard, or a Zod schema, instead.

### Logging

`console` is banned outside `src/logging/logger.ts`. Use a category logger:

```ts
import { getLogger } from '@/logging/logger';
const log = getLogger('browser');

log.info('Navigated.', { url: tab.url });
```

Every message and context object is redacted before any sink sees it.

### Errors

Tools throw `ToolError` with a canonical code from `ERROR_CODES`. The registry
converts it into an envelope. Never let a raw exception escape a tool: its
message may contain page content, and it would become untrusted text in model
context.

```ts
throw new ToolError('ELEMENT_NOT_FOUND', 'No element matches that handle.', {
  userMessage: 'That element is no longer on the page. Read the page again.',
  retryable: true,
});
```

`userMessage` reaches the model and the UI. `technicalDetails` does not.

## Adding a tool

1. Create it in the matching `src/tools/<area>/` directory.
2. Define a Zod schema. Every field gets a `.describe()` — that text is what
   the model sees, and a vague description produces bad tool calls.
3. Declare the **lowest** risk the tool can have. Use `classify` to raise it
   based on arguments. The floor is what applies when nothing is known, so it
   must still be safe.
4. Return a `ToolExecutionResult`. Report taint if the tool read private data.
5. Register it in `service-worker.ts`.
6. Write tests: happy path, each failure path, and the policy interaction.

```ts
const input = z.object({
  target: z.string().min(1).describe('What to act on, from browser.read_page.'),
});

export function createExampleTool(deps: Deps): AgentTool<typeof input> {
  return {
    name: 'browser.example',
    version: '1.0.0',
    description: 'One sentence the model can act on.',
    inputSchema: input,
    risk: 'R1',
    executionMode: 'requires_page',
    sideEffects: ['Describes what changes.'],
    timeoutMs: 15_000,
    idempotent: false,
    classify: (args) => ({ summary: `Do the thing to ${args.target}.` }),
    async execute(args, context) {
      // ...
      return { success: true, data: { done: true } };
    },
  };
}
```

Full detail: [tool-architecture.md](tool-architecture.md).

## Adding a provider

Implement `AIProviderAdapter` in `src/providers/adapters/`, register its
factory in `service-worker.ts`, and write tests against a stubbed `fetch`.

Do not add provider-specific logic anywhere else. If the agent runtime needs to
know which provider it is talking to, the abstraction has leaked.

Full detail: [provider-architecture.md](provider-architecture.md).

## Before you push

```bash
npm run verify
```

This runs format check, lint, typecheck, tests, build and package validation —
the same sequence CI runs, so a green `verify` means a green pipeline.
