---
document: FREEZE-M0-PROMPT-A
status: FROZEN
product_name: ReproAgent
prompt_a_file: prompt-a.txt
prompt_a_sha256: eabe7754a4c6d0dcc80f8efda4dc71114ffb48088e37734fe9fd8dec5d5a0d4a
prompt_a_bytes: 24984
prompt_a_lines: 634
canonicalization: UTF-8 without BOM, LF line endings, exactly one final newline
recovered: 2026-09-11
authorized_scope: M0 through M8
---

# FREEZE-M0-PROMPT-A — the frozen originating brief

This document freezes the originating brief ("Prompt A") that defines ReproAgent. It exists
because the M0 completion audit found that no Prompt A freeze package had ever been created: the
brief governed every architectural decision in `docs/` but was not itself under version control,
so nothing could prove that the architecture still answered the brief it claimed to answer.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
interprets and prioritizes evidence. Humans authorize consequential transitions.

## The frozen bytes

`docs/prompt-a.txt` holds the brief verbatim. It was recovered byte-for-byte from this project's
own session transcript, not reconstructed, summarized, or corrected. Two deliberate consequences:

- The brief contains statements that later human decisions superseded — most importantly its
  three-phase execution plan, which halts after M1. Those statements are **left exactly as
  written**. A frozen document records what was asked at the time; it is not edited to match what
  was later decided. `docs/m0-decisions.md` records the supersessions.
- The brief refers to the product by description rather than by name. The name **ReproAgent** was
  fixed by a later human decision and is recorded in `docs/m0-decisions.md`, not retrofitted into
  the frozen text.

## Integrity

```bash
cd docs && sha256sum -c prompt-a.sha256
```

Expected output: `prompt-a.txt: OK`

The checksum is computed over the canonical bytes of `docs/prompt-a.txt`. Canonical form is UTF-8
without a byte-order mark, LF line endings, and exactly one final newline; all other whitespace is
preserved as received.

Two mechanisms protect those bytes:

- `.gitattributes` marks the file `-text`, so Git performs no end-of-line conversion on checkout.
  Without this, a checkout on Windows would rewrite LF to CRLF and every byte of the checksum
  would be wrong through no fault of the content.
- `.prettierignore` excludes the file, so `npm run format` cannot reflow it.

## Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Checksum reproduces | `sha256sum docs/prompt-a.txt` | `eabe7754a4c6d0dcc80f8efda4dc71114ffb48088e37734fe9fd8dec5d5a0d4a` |
| Checksum file verifies | `cd docs && sha256sum -c prompt-a.sha256` | `prompt-a.txt: OK` |
| No BOM | byte inspection | absent |
| No CR bytes | byte inspection | 0 |
| Exactly one final newline | byte inspection | 1 |
| Frozen text unaltered by formatter | `npm run format:check` | file excluded via `.prettierignore` |

## Relationship to the other freeze documents

| Document | Freezes |
| --- | --- |
| `docs/FREEZE-M0-PROMPT-A.md` | the originating brief, byte-for-byte |
| `docs/m0-decisions.md` | the human decisions, including those that supersede the brief |
| `docs/FREEZE-M0.md` | the M0 architecture, its sign-off, and the amendment log |
