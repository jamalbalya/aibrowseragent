# File handling

## Four operations, not one

A file reaching a website is four events. Collapsing them into a single
"upload" hides three of them, and three is where the decisions are.

|       | Operation                             | Where                           | What it means                                          |
| ----- | ------------------------------------- | ------------------------------- | ------------------------------------------------------ |
| **A** | The user selects a local file         | the side panel's file picker    | the only route to local bytes                          |
| **B** | The extension reads it                | the side panel, into the worker | task-derived data appears — the task becomes tainted   |
| **C** | The extension puts it in a page input | the content script              | the bytes cross into the page — **this is the egress** |
| **D** | The site transmits it                 | the page's own form submit      | an ordinary page action, gated by the existing tools   |

`files.select` is A and B. `browser.attach_file` is C. D is whatever the page
does next, reached through `browser.click` or `browser.type` with `submit`,
both of which already pass the gate.

### Why C is the boundary and not D

A page can read `input.files` with its own JavaScript the moment the files are
set. Waiting until the form is submitted would gate an event that has already
happened. So the egress gate fires at assignment, and the later submit is a
separate action rather than the one that mattered.

This is not the same as assuming a submit is harmless. It is not gated _as the
file transfer_ because by then the transfer is done.

## Local file access

**The extension has no filesystem access and asks for none.** There is no
`file://` host permission, no filesystem API, and no tool that takes a path —
`files.select` accepts a `purpose` and nothing else, so a model cannot express
"read `~/.ssh/id_rsa`" even as a proposal.

A file arrives one way: a person presses a button in the side panel, chooses
something in Chrome's own picker, and the panel reads what they chose. The
model says why a file is wanted; the user decides what that is.

What the extension therefore cannot do, by construction rather than by policy:
scan a filesystem, enumerate a directory, read a credential store, a browser
profile, a cookie jar, an SSH key or a cloud credential file.

### The paths a model might propose

`purpose` is model output. It is rendered as text in the prompt and never
resolved, so a model that writes `/etc/shadow` there has described its request
misleadingly and changed nothing about what can be read.

## What is kept, and for how long

Bytes live in the service worker's memory and are written nowhere: not to
`chrome.storage`, not to evidence, not to the audit trail, not to a log.

The consequence is deliberate. When the MV3 worker is evicted the bytes are
gone, and a task that resumes afterwards finds its staged file missing and
says so. The alternative — persisting a user's document so a resumed task
could carry on — would leave it in extension storage for the life of the task
to save one re-pick.

The **security state does** survive: task taint is persisted separately, so a
task that read a file stays tainted by having read one whether or not the file
is still held.

## The file record

Per specification §68, a file carries origin, path, mimeType, size,
sensitivity and taskId. The record here carries all of them, with one note on
`path`: a browser's file picker never exposes a full path to an extension, so
the record holds a **basename**. That is also what this design wants — a path
says where a person keeps their files, which is not needed to attach one.

Names are reduced to a basename and stripped of control characters before they
go anywhere. A newline in a filename can otherwise make a permission prompt
appear to ask about something else.

## Taint

Reading a local file adds a `local_file` source at `confidential`, with **no
site**. The missing site is the point: a source with no site can never match a
destination, so sending the file anywhere is a transfer to somewhere the data
did not come from, and needs consent rather than a same-origin pass.

Taint is monotone, as everywhere else. Page data plus a local file plus model
output keeps every source; nothing removes one. A file's provenance therefore
travels with the task to any provider it later talks to.

A download adds a `download` source at `internal`, attributed to the site that
**served** it rather than the site it was requested from. Chrome follows
redirects itself and the tool never sees the hops, so the only place the real
source appears is the finished download item's final URL. When the two differ,
both are added: the serving site because that is where the bytes came from, and
the requested site because that is what the redirect was reached through.

Attributing only the requested site would have the rest of the task reason
about an origin that never served the file — the confirmation the person
answered would be right, and every later egress decision resting on it wrong.

## Uploads and the gate

`browser.attach_file` declares a `page_write` egress to the page's own origin,
carrying the file **names and sizes** as its payload — never the bytes. A
digest over megabytes of file would tell nobody anything while putting the file
through the redaction scanner.

Every attachment therefore passes destination canonicalisation, the credential
scan, policy, permission and consent, and produces an evidence record. Changing
the destination's scheme, host or port produces a different identity and
invalidates any consent given for the old one.

The prompt names the file and the destination, because "attach a file" gives a
user nothing to judge.

## Downloads

`browser.download` takes a URL and an optional **plain filename**. It is an
egress in its own right: the browser fetches a URL the model chose, and a URL
carries whatever the model put in its query string.

### Filenames

A filename is reduced to a basename with **no directory component at all**.
Chrome's downloads API accepts a relative subdirectory; supporting that would
mean reasoning about which relative paths are safe, and refusing every
separator removes the question.

Refused outright, with the reason reported:

| Rejection           | Example                                                                                |
| ------------------- | -------------------------------------------------------------------------------------- |
| `TRAVERSAL`         | `../escape.txt`                                                                        |
| `ABSOLUTE`          | `/etc/passwd`, `C:\Windows\...`, `\\server\share`                                      |
| `PATH_SEPARATOR`    | `sub/dir/file.txt`                                                                     |
| `CONTROL_CHARACTER` | a name containing a NUL or newline                                                     |
| `RESERVED_NAME`     | `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without an extension |
| `TOO_LONG`          | over 200 characters                                                                    |
| `EXECUTABLE`        | `.exe`, `.msi`, `.sh`, `.ps1`, `.vbs`, `.dll`, `.jar`, `.app`, `.dmg`, …               |
| `BROWSER_EXTENSION` | `.crx`, `.xpi`                                                                         |

A trailing dot or space is stripped before the extension is read, because
Windows drops them — `payload.exe.` and `payload.exe` name the same file, and
checking the raw string would walk straight past the extension rule.

Refusing executables is an agent-scope decision rather than a virus check.
Nothing a browser task legitimately needs is delivered as an executable, and
the choice of what to download is made by a model reasoning over page content
an attacker may have written.

**Chrome's own behaviour is not assumed.** The extension validates
independently and refuses before Chrome is involved. What Chrome does with a
traversal filename anyway is observed in `tests/e2e/file-transfer.spec.ts`
rather than asserted from documentation.

### Overwriting

`conflictAction: 'uniquify'`. A download never replaces an existing file, and
the name reported back is the one that actually landed — Chrome may have
renamed it.

### Redirects

Chrome resolves them. The confirmation names the site that was asked for,
because that is what a person is agreeing to; the audit record and the taint
name the site that served the file, because that is what happened. When they
differ the record says so in as many words, so neither fact is lost.

### Nothing is executed

A downloaded file is untrusted content. Nothing reads it back, interprets it,
loads it into an extension page, or lets it influence extension behaviour. The
tool returns metadata; there is no code path to the contents.

## Permissions

No manifest permission was added for this work.

`downloads` was already declared **optional** and stays optional: it is not
granted at install, the agent cannot request it, and a person turns it on from
Settings under their own gesture. Until then every download is refused with an
explanation. Uploads need no permission at all — they use the content script
that already exists.

`<all_urls>` is still absent, and `all_frames` is still `false`.

### Known limitation: file inputs inside iframes

A file input in a cross-origin iframe is not reachable, because the content
script runs only in the top frame. This is **documented rather than fixed**:
enabling `all_frames` would inject into every frame of every page, which is a
materially larger surface than an upload feature justifies, and the Stage 2
finding that removed `<all_urls>` applies to the same reasoning.

## Hidden file inputs

The page model normally leaves invisible elements out, so the model cannot act
on something the user cannot see. File inputs are the one exception: the usual
way to build an upload control is a styled button beside an
`input[type=file]` that is deliberately hidden, and excluding those would mean
uploads work on almost no real form.

Attaching to one is not the same as clicking something invisible. The file was
chosen by the user in a picker, the attach passes the egress gate, and the
prompt names both the file and the origin. The element is reported with
`visible: false` rather than described as if it were visible, and the audit
record says the input was hidden.

A file input is also reported with its own role — `file`, not `textbox`. The
old behaviour told the model to type a path into it.

## What the trail records

`file.selected`, `file.attached` and `file.downloaded` carry the task, a
basename, a MIME type, a size, an origin, a destination and a decision. Every
field goes through the same redaction as the rest of the audit log, so a key
pasted into a filename does not survive in the trail.

There is no field for contents, and the audit log rejects a record that tries
to carry one rather than storing a stripped version.

Evidence is unchanged: HMAC-SHA256 under the per-task salt, epoch-aware,
payload-free.

## Limitations worth knowing

**Synthesised events are not trusted events.** The `change` event dispatched
after an attachment has `isTrusted: false`, because nothing an extension
synthesises is trusted. A page that requires `isTrusted` will ignore it. This
cannot be worked around, so the assignment is verified afterwards and a failure
is reported rather than assumed away.

**Size.** Bytes travel as base64 over extension messaging, which is a JSON
channel, so a file costs roughly 4/3 its size per hop. The caps are 20 MB per
file and 40 MB per attachment, and a file over the cap is refused with its size
rather than truncated.

**No drag-and-drop uploader support.** A control that only accepts a `drop`
event, with no underlying file input, is not reachable.
