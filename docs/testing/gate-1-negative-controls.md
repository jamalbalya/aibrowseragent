# Gate 1 — negative-control record

A test that asserts an absence is worthless until it has been shown to fail
when the absence is removed. Every control below was run that way: the
protection was deliberately removed, the target suite was run, the failure was
recorded, and the protection was restored. A control that did **not**
discriminate is recorded here too, along with what was changed to make it real
— hiding one would defeat the point of keeping this file.

Run on 2026-09-24, against `src/` as it stands in the Gate 1 commit.

| #     | Protection removed                                                             | File                                | Target                                     | Result                                        |
| ----- | ------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------ | --------------------------------------------- |
| NC-1  | `SAFE_FALLBACK_CLASS` changed from `UNKNOWN` to `ORDINARY`                     | `policy/field-sensitivity.ts`       | `tests/security/field-sensitivity.test.ts` | **7 failed** / 43 passed — discriminates      |
| NC-2  | `PASSWORD` and `OTP` dispositions changed from `REFUSE` to `ALLOW_AT_BASELINE` | `policy/field-sensitivity.ts`       | `tests/security/field-sensitivity.test.ts` | **4 failed** / 46 passed — discriminates      |
| NC-3  | `PAYMENT_INSTRUMENT` downgraded from `PROHIBIT` to `RAISE_RISK: R2`            | `policy/field-sensitivity.ts`       | `tests/security/field-sensitivity.test.ts` | **2 failed** / 48 passed — discriminates      |
| NC-4  | `validateFieldObservations` returns the raw array for any array input          | `messaging/protocol.ts`             | `tests/security/field-sensitivity.test.ts` | **4 failed** / 47 passed — discriminates      |
| NC-5  | An unrecognised control type classified `ORDINARY` instead of `UNKNOWN`        | `policy/field-sensitivity.ts`       | `tests/security/field-sensitivity.test.ts` | **1 failed** / 49 passed — discriminates      |
| NC-6  | `exceedsCeiling` trusts its argument instead of normalising it                 | `policy/field-sensitivity.ts`       | `tests/security/field-sensitivity.test.ts` | **1 failed** / 49 passed — discriminates      |
| NC-7  | Generation binding dropped from `FieldObservationStore.lookup`                 | `policy/field-observation-store.ts` | `tests/security/field-sensitivity.test.ts` | **1 failed** / 50 passed — discriminates      |
| NC-8  | `sanitiseSitePolicyState` made a no-op                                         | `policy/site-policy.ts`             | `tests/security/field-sensitivity.test.ts` | **1 failed** / 49 passed — discriminates      |
| NC-9  | `page.fields` added to what `browser.read_page` returns to the model           | `tools/browser/browser-tools.ts`    | `tests/security/field-sensitivity.test.ts` | **1 failed** — discriminates                  |
| NC-10 | `refuseIfAboveCeiling` removed from the `content.type` handler                 | `content/content-script.ts`         | `tests/e2e/field-sensitivity.spec.ts`      | **2 failed** in real Chromium — discriminates |

## The one that did not discriminate first time

**NC-7** was run twice.

The first run left the suite green. The reason is worth recording rather than
patching over: element handles encode their own generation (`e{generation}-
{index}`), so a handle from an earlier snapshot almost always misses the
observation map by its key alone, and case 12 was passing on that rather than
on the generation check it claimed to cover.

What the check actually defends is narrower and was untested: a page read whose
**declared generation disagrees with the handles it minted**. Nothing in a
well-behaved content script produces that; a confused or substituted one does,
and without the check the map key would hit and the store would answer for an
element identity that never existed.

Case `12b` was added to exercise exactly that, and includes the positive half —
the same store answers normally once the two agree — so it cannot pass by the
store simply answering nothing. NC-7 then failed as required.

The check was **not** removed. It is real defence in depth; what was wrong was
the test's claim to be covering it.

## How to re-run

Each control is a one-line edit. The driver used was a throwaway script that
copies the file, applies one `str.replace`, runs one target, and restores the
file unconditionally — so a crashed run cannot leave a weakened source behind.
For NC-10 the extension must be rebuilt (`npm run build`) before and after the
mutation, because Playwright loads `dist/`, not `src/`.
