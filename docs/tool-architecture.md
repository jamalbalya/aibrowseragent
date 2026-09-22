# Tool architecture

## Why tools exist

The model cannot touch a Chrome API, run a script, or make an HTTP request. It
can only ask for a canonical tool by name, with arguments that must satisfy a
schema. The tool registry is the only bridge between model output and a real
effect, and it is not bypassable: the runtime holds no direct reference to any
tool implementation.

## The contract

```ts
interface AgentTool<TSchema extends z.ZodType> {
  name: string; // canonical, dotted: "browser.click"
  version: string;
  description: string; // the model reads this
  inputSchema: TSchema; // Zod; converted to JSON Schema for the provider
  risk: RiskLevel; // the FLOOR, not the ceiling
  executionMode: ExecutionMode;
  sideEffects: readonly string[];
  timeoutMs: number;
  idempotent: boolean;

  classify?(input, context): CallClassification;
  execute(input, context): Promise<ToolExecutionResult>;
}
```

`execute` receives **parsed, validated** input. It never sees raw model output.

## The gate

Every call goes through `ToolRegistry.dispatch()`:

```text
lookup → schema validation → classification → policy → permission
       → execution → sanitisation → evidence
```

`dispatch` never throws. Every failure path returns an envelope, because an
unhandled exception here would surface as untrusted text in model context.

## Risk is a floor

`risk` is the **lowest** level the tool can ever have. `classify` may raise it
and can never lower it (`maxRisk(floor, classified)`).

The floor is what applies when nothing about the arguments is known, so it must
be safe on its own.

Two worked examples:

```ts
// browser.type: typing is R1, but submitting a form is a different order of
// state change.
risk: 'R1',
classify: (input) => ({
  ...(input.submit ? { risk: 'R2' as const } : {}),
}),
```

```ts
// tabs.close: R1 for a tab this task opened, R3 for one the user opened —
// closing the user's tab can destroy their work.
//
// The floor is R1 rather than R3 on purpose: making the agent prompt before
// closing each of its own scratch tabs teaches users to approve reflexively,
// which costs more safety than it buys.
risk: 'R1',
classify: (input, context) => ({
  risk: ownership.owns(context.taskId, input.tabId) ? 'R1' : 'R3',
}),
```

## Classification

`classify` tells the policy engine about _this specific call_:

| Field              | Purpose                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `risk`             | Argument-aware risk; raises the floor                                                                    |
| `prohibited`       | Hard-prohibited categories this call falls into                                                          |
| `targetUrl`        | The URL policy should evaluate. For `browser.navigate` this is the **destination**, not the current page |
| `writeDestination` | Where data is going, if the call sends data outward                                                      |
| `writePayload`     | What is being sent, for the exfiltration guard                                                           |
| `summary`          | One line shown in the permission prompt                                                                  |

## Schemas

Zod, converted to JSON Schema via `z.toJSONSchema()`.

Describe every field. That text is what the model sees, and a vague description
produces bad tool calls:

```ts
const input = z.object({
  elementId: z
    .string()
    .min(1)
    .describe('Element handle from the most recent browser.read_page result.'),
  text: z.string().max(10_000).describe('Text to enter.'),
  submit: z
    .boolean()
    .optional()
    .describe('Press Enter and submit the containing form after typing.'),
});
```

Bound every input. `max()` on strings and arrays, `min`/`max` on numbers. An
unbounded field is a way for a confused model to produce an enormous request.

## Results

```ts
interface ToolExecutionResult<T> {
  success: boolean;
  data?: T; // redacted before it reaches the model
  error?: AgentError;
  evidence?: readonly EvidenceReference[];
  metadata?: Record<string, unknown>;
  taint?: readonly TaintSource[]; // private sources this call read from
}
```

Report `taint` whenever a tool reads data the user would consider private. The
exfiltration guard uses it, and a tool that under-reports taint weakens that
control for the whole task.

### Do not echo sensitive input back

`browser.type` returns a character count, never the text. The typed value may
be something the user would not want repeated into model context, and the model
already knows what it asked to type.

### Files are metadata to the model, bytes only to the page

`files.select` returns a file's name, type, size and an id. The contents never
enter model context: they go into a memory-only store and come out again only
when `browser.attach_file` hands them to a content script. The id is the
model's whole handle on the file, and it resolves only within the task that
selected it.

The split is the point. Reading a file, sending it to a page, and the page
transmitting it are three separate events with three separate decisions; a
single "upload" tool would have gated only the last. See
[file-handling.md](file-handling.md).

### Evidence, not payloads

`browser.screenshot` stores the image as evidence and returns only its id. A
screenshot entering model context implicitly would be both a privacy problem
and an enormous context cost.

The capture runs over the DevTools protocol (`Page.captureScreenshot`), not
`chrome.tabs.captureVisibleTab`. `captureVisibleTab` demands the literal
`<all_urls>` host permission, which was measured to also grant this extension
read access to local files; see "Why not `<all_urls>`" in `docs/security.md`.
`Page.captureScreenshot` is already on the DevTools allowlist and needs no host
permission, so the tool attaches the debugger for the duration of the capture
and detaches again — leaving a session that another tool had already opened
untouched. A payload that is not a well-formed PNG is refused rather than
filed: a corrupt image stored as evidence reads as a record of what the page
showed.

## Failures

Throw `ToolError` with a canonical code:

```ts
throw new ToolError('ELEMENT_NOT_FOUND', 'No element matches that handle.', {
  userMessage: 'That element is no longer on the page. Read the page again.',
  retryable: true,
});
```

`userMessage` reaches the model and the UI. `technicalDetails` does not — it
may contain page content.

An unexpected exception becomes `INTERNAL_ERROR` with a generic user message,
and its real text is kept in `technicalDetails`. That is deliberate: raw
exception text is a leak channel.

**Never fake success.** If a tool fails, say so. The result contract, the UI
and the model all depend on a failed action being reported as failed.

## Current tools

### Browser — `src/tools/browser/`

| Tool                             | Risk    | Notes                                               |
| -------------------------------- | ------- | --------------------------------------------------- |
| `browser.read_page`              | R0      | Semantic model; text wrapped as untrusted data      |
| `browser.click`                  | R1      |                                                     |
| `browser.type`                   | R1 / R2 | R2 when submitting                                  |
| `browser.select`                 | R1      | Matches by value, then by visible label             |
| `browser.navigate`               | R1      | Classifies the **destination**                      |
| `browser.go_back` / `go_forward` | R1      |                                                     |
| `browser.reload`                 | R1      |                                                     |
| `browser.scroll`                 | R0      |                                                     |
| `browser.wait`                   | R0      | Page load, or a CSS selector                        |
| `browser.screenshot`             | R0      | Debugger capture; stored as evidence, returns an id |

### Tabs — `src/tools/tabs/`

| Tool                       | Risk    | Notes                            |
| -------------------------- | ------- | -------------------------------- |
| `tabs.list`                | R0      | Flags which tabs are automatable |
| `tabs.get_active`          | R0      |                                  |
| `tabs.create`              | R1      | Claims ownership for the task    |
| `tabs.close`               | R1 / R3 | R3 for a tab the user opened     |
| `tabs.activate`            | R1      |                                  |
| `tabs.reload`              | R1      |                                  |
| `tabs.group` / `ungroup`   | R1      |                                  |
| `tabs.wait_for_navigation` | R0      |                                  |

### Debugger — `src/tools/debugger/`

| Tool                  | Risk | Notes                               |
| --------------------- | ---- | ----------------------------------- |
| `debugger.console`    | R0   | Redacted at collection time         |
| `debugger.network`    | R0   | Headers redacted by name            |
| `debugger.dom`        | R0   | Rendered HTML, wrapped as untrusted |
| `debugger.page_state` | R0   | History position and layout metrics |
| `debugger.detach`     | R0   | Dismisses the debugging banner      |

There is deliberately no `debugger.command`: the model cannot name a CDP
method. See [security.md](security.md#t6--devtools-access).

## Not implemented

`browser.upload`, `browser.download` and `browser.execute_script` are named in
the specification but are not implemented, and nothing fakes them.

`browser.execute_script` in particular would make the entire gate bypassable —
arbitrary script from model output is the thing this architecture exists to
prevent. If it is ever added it needs its own threat model, not just a policy
flag.
