# Submitting PortCast as an Independent Submission RFC

This is the operator playbook for getting `draft-trimplayer-portcast-00`
posted as an Internet-Draft and then accepted by the Independent
Submissions Editor (ISE) for publication as an Informational RFC.

Only an author can submit. The steps below are written for Trimplayer
(`trimplayerapp@gmail.com`) to perform.

---

## 0. Prerequisites (one-time)

Create a free Datatracker account if you do not already have one:

- https://datatracker.ietf.org/accounts/create/

Set up a local toolchain (or rely on the GitHub Action in
`.github/workflows/draft.yml`, which builds the I-D on every push to
`drafts/`):

```bash
gem install kramdown-rfc      # Markdown -> xml2rfc XML
pip install xml2rfc           # XML -> .txt / .html
# optional: pip install idnits
```

## 1. Build the draft locally

```bash
cd drafts
make            # produces draft-trimplayer-portcast-00.txt and .html
```

The `.txt` rendering is the authoritative submission artifact. Open it
and read it end to end — the I-D submission tool is strict about
formatting (page breaks, line lengths, boilerplate).

## 2. Validate before uploading

Two checks worth doing:

1. **Author tools.** Drop the `.xml` (or `.md`) at
   https://author-tools.ietf.org/ — it runs `idnits`, the same lint
   the submission tool uses, and shows the errors inline.
2. **idnits CLI** (optional but useful in CI):
   ```bash
   idnits drafts/draft-trimplayer-portcast-00.txt
   ```
   Treat any `Error` as blocking. `Warning`s are usually fine for an
   I-D; resolve obvious ones (date in past, missing reference).

The CI workflow attaches the built `.txt` / `.html` / `.xml` as an
artifact on every push, so you can also pull them from a green build.

## 3. Upload as an Internet-Draft

1. Go to https://datatracker.ietf.org/submit/.
2. Choose **Upload submission**.
3. Upload `draft-trimplayer-portcast-00.txt` (or `.xml` — both are
   accepted). The tool will run `idnits` and reject anything that does
   not pass.
4. Confirm the metadata: title, authors, abstract, intended stream
   (**Independent**), intended status (**Informational**). The
   `submissiontype: independent` and `category: info` lines in the
   YAML frontmatter pre-fill these.
5. The tool emails the author address (`trimplayerapp@gmail.com`) a
   confirmation link. Click it to actually post the I-D.

Once posted, the draft is publicly visible at:

- https://datatracker.ietf.org/doc/draft-trimplayer-portcast/
- https://www.ietf.org/archive/id/draft-trimplayer-portcast-00.txt

## 4. Request publication via the Independent Submission stream

Posting an I-D is not the same as requesting publication. To actually
ask for it to become an RFC:

1. Read the ISE's instructions:
   https://www.rfc-editor.org/authors/rfc-independent-submissions/
2. Email the Independent Submissions Editor at
   **rfc-ise@rfc-editor.org** with:
   - The I-D name (`draft-trimplayer-portcast-00`).
   - A short cover note: what the document is, why it should be an RFC,
     what stream you are targeting (Independent / Informational), and a
     short statement that you (the authors) hold the rights to grant
     the trust IPR per RFC 5378 and RFC 5744.
   - Any deployed implementations or interoperability evidence.

A suggested cover-note template lives in `drafts/cover-letter.md` (see
below) — adjust before sending.

## 5. After the ISE acks

Expect:

- An initial editorial review from the ISE.
- A request to address any conflicts, gaps, or open questions (often
  IANA considerations and security considerations get the most
  scrutiny).
- A formal "AD" (Area Director) review for routing — Independent
  Submissions still get cross-checked against IETF working-group work
  in adjacent areas.
- Editorial passes by the RFC Production Center once accepted.

Plan on several months end to end. Iterate the draft in this repo and
bump the version suffix (`-00` -> `-01` -> ...) for each new upload.

## 6. Updating the draft

```bash
# 1. Edit drafts/draft-trimplayer-portcast-00.md
# 2. Rename the file and the docname field for the new revision:
git mv drafts/draft-trimplayer-portcast-00.md \
       drafts/draft-trimplayer-portcast-01.md
# Update `docname: draft-trimplayer-portcast-01` in the YAML frontmatter.
# 3. Re-run `make` and re-upload via the submission tool.
```

## What this repo gives you

| File                                            | Purpose                                            |
| ----------------------------------------------- | -------------------------------------------------- |
| `SPECIFICATION.md`                              | Developer-facing spec, lives on GitHub             |
| `drafts/draft-trimplayer-portcast-00.md`        | kramdown-rfc source for the Internet-Draft         |
| `drafts/Makefile`                               | Local build (`make txt`, `make html`)              |
| `drafts/cover-letter.md`                        | Cover-letter template for the ISE                  |
| `.github/workflows/draft.yml`                   | CI build of the I-D on every push                  |

The GitHub-facing `SPECIFICATION.md` and the kramdown-rfc draft will
inevitably drift. Treat the I-D source as the canonical text once you
have submitted; backport changes from there into `SPECIFICATION.md`
rather than the other way around.
