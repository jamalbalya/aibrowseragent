# §91 — Downloads (P-011)

Not a specification section. This package exists because the P-011 capability
audit found the recorded blocker for downloads to be wrong, and the thing that
is genuinely blocked turned out to need a written procedure that had nowhere
to live.

Read [README.md](README.md) first: the three verdicts, and why none of them is
`PASS`.

| Item | Subject                         | Verdict                                                       |
| ---- | ------------------------------- | ------------------------------------------------------------- |
| D-1  | Refusal without the permission  | `AUTOMATED`                                                   |
| D-2  | The granted download path       | `AUTOMATED`                                                   |
| D-3  | Granting the permission by hand | `MANUAL` — Chrome's own dialog is not drivable by any harness |

---

### What was believed, and what is true

The roadmap recorded the blocker as _"granted-path E2E needs a real user
gesture"_. Three experiments in real Chromium settled it, and it is wrong in
both halves.

**It is not the gesture.** A Playwright `page.click()` on the Settings button
supplies a real user activation, and Chrome accepts the
`chrome.permissions.request` call made from that handler — the call does not
reject for lack of activation. What happens next is that Chrome raises its own
confirmation dialog. That dialog is browser chrome, not page content: there is
no frame to address it in, no accessibility tree exposed to the automation
protocol, and no CDP domain that answers it. The promise simply never settles.
So the obstacle is the **dialog**, one step later than recorded.

**It is not the granted path.** Nothing downstream of the grant needs a
gesture at all; it needs a permission that is already present. A permission
declared as required in the manifest is granted by Chrome at install, which is
a build-time fact and not a runtime mutation. `dist-downloads/` is the shipped
bundle with that one change, and running against it exercises the real policy
engine, the real R3 confirmation, the real filename gate, the real
`chrome.downloads` call and the real audit write.

So the automatable surface was much larger than the blocker claimed, and the
un-automatable surface is one dialog.

---

## D-1. Refusal without the permission

> With `downloads` not granted, `browser.download` must refuse, explain, and
> write nothing to disk.

**Verdict: `AUTOMATED`.**

Against the shipped bundle, where `downloads` is optional and a fresh profile
has it off:

- EVIDENCE: tests/e2e/file-transfer.spec.ts :: downloading is refused until the optional permission is granted
- EVIDENCE: tests/e2e/file-transfer.spec.ts :: Chrome itself refuses a traversal filename, and the extension never sends one

---

## D-2. The granted download path

> With `downloads` granted, a download must be gated by a confirmation, honour
> the filename rules, write the requested bytes to disk, and be recorded.

**Verdict: `AUTOMATED`.**

Against `dist-downloads/`, in real Chromium, with a real local HTTP server
supplying the file and Chrome writing it to a real directory:

- EVIDENCE: tests/e2e/download-granted.spec.ts :: the fixture bundle differs from the shipped one only in where “downloads” is declared
- EVIDENCE: tests/e2e/download-granted.spec.ts :: the downloads permission reads as granted through the extension’s own port
- EVIDENCE: tests/e2e/download-granted.spec.ts :: an approved download writes the real bytes to disk and records one allowed event
- EVIDENCE: tests/e2e/download-granted.spec.ts :: a refused filename is still refused once the permission is granted
- EVIDENCE: tests/e2e/download-granted.spec.ts :: denying the confirmation leaves nothing on disk
- EVIDENCE: tests/e2e/download-granted.spec.ts :: a standing site grant at the highest grantable risk still does not cover a download
- EVIDENCE: tests/e2e/download-granted.spec.ts :: the granted permission and the download path both survive worker eviction

The first of those is load-bearing for all the others: it re-derives the
difference between the two manifests inside the run and fails if anything
beyond `permissions` and `optional_permissions` differs. Without it, a fixture
that had quietly widened `host_permissions` would make every result below it a
statement about a bundle nobody described.

**What this does not establish.** That a person can turn the permission on.
That is D-3, and no evidence here substitutes for it.

---

## D-3. Granting the permission by hand

> A person must be able to turn `downloads` on from the side panel, and the
> agent must not be able to turn it on for them.

**Verdict: `MANUAL` — Chrome's permission dialog cannot be driven by
Playwright, by CDP, or by the extension itself, and mutating the permission
another way would test something other than what this item asks.**

The automated suite establishes the state on either side of this step — refused
before (D-1), working after (D-2). What no harness reaches is the transition,
because Chrome deliberately puts it behind a dialog only a person can answer.

### Procedure D-3-1 — manual (granting, using, and revoking)

Setup as in the README, with the **shipped** build — `dist/`, not
`dist-downloads/` — and a provider configured.

**Initial state.** A fresh Chrome profile with the extension loaded unpacked
from `dist/`. Confirm at `chrome://extensions` → _Details_ → _Permissions_
that no downloads permission is listed, and that `chrome://settings/downloads`
names a directory you can inspect.

1. Open the side panel and go to **Settings**. Find the downloads row. It
   should read that saving a file needs Chrome's downloads permission, that it
   is off, and that the button has to be pressed by you.
2. **Before pressing it**, ask the agent: _Download
   `https://example.org/robots.txt` for me._
   - Expected: a confirmation prompt naming `browser.download`. Approve it.
   - Expected: the task does not complete the download, and the message says
     the downloads permission is off and has to be turned on in Settings.
   - Expected: no new file in the download directory.
3. Press the button in Settings. This is the gesture.
   - Expected: **Chrome's own dialog** appears, outside the panel, asking
     whether the extension may manage downloads. This is the step under test:
     note that it is browser chrome and that nothing in the page produced it.
4. Choose **Allow**.
   - Expected: the Settings row now reports the permission as granted.
   - Expected: `chrome://extensions` → _Details_ → _Permissions_ now lists it.
5. Ask the agent again: _Download `https://example.org/robots.txt` for me._
   - Expected: a confirmation prompt naming `browser.download`, again. A
     download is R3 and the risk floor confirms every time; no standing grant
     removes it.
   - Approve it.
   - Expected: a file appears in the download directory whose contents are the
     real body of that URL.
   - Expected: in the panel's audit view, one `file.downloaded` event for that
     task, outcome _allowed_, naming the saved filename and `example.org`.
6. Ask the agent: _Download `https://example.org/robots.txt` and save it as
   `setup.exe`._
   - Expected: refused, with the reason naming the filename rather than the
     permission.
   - Expected: no new file, and a `file.downloaded` event with outcome
     _denied_.
7. Revoke: at `chrome://extensions` → _Details_ → _Permissions_, turn the
   downloads permission off.
   - Expected: the Settings row reports it as off again without a reload.
   - Expected: repeating step 2 refuses exactly as it did the first time.

**Criterion.** Step 3 shows a dialog the extension did not and could not
produce; step 5 writes a real file and records it; step 7 returns the product
to the refusing state. Any step where the agent obtains the permission without
the person pressing the button is a failure of the whole item, whatever the
rest of the run showed.

**Cleanup.** Delete the downloaded files and discard the profile.
