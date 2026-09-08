# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities. Use GitHub's
private vulnerability reporting instead: go to the repository's **Security** tab
and choose **Report a vulnerability**
([direct link](https://github.com/ClemenceChee/canon/security/advisories/new)).
That opens a private advisory visible only to you and the maintainers.

Expect an acknowledgement within a few business days. Please include the version
or commit, the command you ran, and steps to reproduce.

## What canon stores on disk

canon is a local CLI with no server and no network listener. Everything it keeps
lives under `.canon/` in your working directory.

**Your Langfuse secret key is stored in plaintext.** `canon connect` writes the
connection block, including `secretKey`, to `.canon/config.json`. The file is
written atomically and chmod'ed to `0600`, inside a directory created `0700`, but
it is not encrypted. Consequences:

- Anyone who can read your home directory as your user can read the key.
- Do not commit `.canon/`. It is gitignored in this repo; make sure it is
  gitignored in whatever directory you run canon from.
- Back-up and sync tools (Dropbox, Time Machine, container volume mounts) will
  copy the key with the rest of the directory.
- Prefer `CANON_LANGFUSE_PUBLIC_KEY` / `CANON_LANGFUSE_SECRET_KEY` in the
  environment over `--public-key` / `--secret-key` on the command line, which
  leak into your shell history and process list.
- Use a project-scoped Langfuse key, not an organization key, and rotate it in
  Langfuse if a checkout is ever shared.

## Trace content and redaction

canon reads your Langfuse traces, which routinely contain prompts, completions,
tool arguments and whatever your users typed. Two separate switches control what
happens to that content, and their defaults differ:

| Setting | Default | Effect |
| --- | --- | --- |
| `settings.redact.views` | **on** | Anything canon prints, exports or writes into a proposal is redacted to `[redacted:<digest>]`. |
| `settings.redact.ingest` | **off** | Raw observation `input`/`output` is archived verbatim into `.canon/archive/*.jsonl` (mode `0600`). |

Ingest redaction is off by default so that analysis can key on real content.
The tradeoff is that a copy of your trace content lands on local disk. Turn it on
with `canon connect --redact` (or `settings.redact.ingest: true` in
`.canon/config.json`) when the source project carries regulated or personal data,
and treat `.canon/archive/` with the same controls as the Langfuse project it
came from: disk encryption, access control, retention.

The effective settings for a store are in its `.canon/config.json` under
`settings.redact`. `canon status` does not print them, but it does report whether
`config.json` still has the expected `0600` permissions.

## A note for secret scanners

`tests/fixtures/archive/edge-rows/observations.jsonl` contains the literal string
`password=hunter2` inside a synthetic trace. It is deliberate test input for the
redactor, not a credential. All fixture keys are placeholders
(`pk-lf-placeholder`, `sk-lf-placeholder`) and all fixture identities are
synthetic (`reviewer@acme`, `prj-refunds`).
