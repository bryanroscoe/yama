# Datasets and historical evidence

28 October 2026. Private ingestion and browsing are available under **Decks, Datasets**
(`/decks/datasets`). Each account sees its own imported evidence. Application release
and production imports are separate operator actions.

The browser searches names, filters the six evidence types, pages through records
and provenance, and downloads the retained original revision. **Explore history**
opens all evidence for a source entity, with complete-month summaries and adjustable
half-life/evaluation date. Browse links pin a revision so paging stays consistent
when a newer import arrives. Session admins can upload prepared JSON/gzip files;
the server validates the complete document atomically before saving. View as is read-only.

An import adds source evidence. It never records a game in a playgroup, edits a deck,
changes a research assessment or publishes a ranking. Every dataset belongs to an
account. Existing MCP grants gain read tools for that account's datasets, with no
administrative upload or publication capability.

## Import and read

The command line accepts `yama-dataset/1` JSON, optionally gzip compressed:

```sh
python3 scripts/datasets/prepare_playgroup.py /path/to/recovered-playgroup-data data/playgroup-dataset.json.gz
./target/debug/yama-server import-dataset data/playgroup-dataset.json.gz --owner you@example.com --dry-run
./target/debug/yama-server import-dataset data/playgroup-dataset.json.gz --owner you@example.com
```

The owner must already exist. The command is a local operator tool; the document
cannot select an owner. `--dry-run` validates the complete input without adding a
dataset or revision. The recovery converter makes no network requests, verifies
the retained input hashes, normalizes timestamp syntax and preserves source
references. It includes performance observations, the commander catalog, weekly
activity, sanitized commander histories, archetype references and extracted tables.
Full HTML, images, article prose, usernames, credentials and local paths are not
included by the converter. Original recovery evidence stays in its source folder.

Authenticated APIs:

| Route | Behavior |
|---|---|
| `GET /api/datasets` | Newest 100 datasets belonging to the caller, with active revision and record counts |
| `POST /api/datasets/import` | Session-authenticated admin upload into that admin's own account; JSON or gzip bytes |
| `GET /api/datasets/{id}` | Private metadata, paged records and optional monthly summaries |
| `GET /api/datasets/{id}/export` | Download the retained original document as gzip |

Read parameters are `revision`, `section=records|sources`, `kind`, exact `entity`,
name `search`, `offset`, `limit` (1–50, default 10), `as_of` (YYYY-MM-DD), and
`half_life_days` (1–3650, default 180). An omitted revision reads the active one.
The response supplies `next_offset`. Large record bodies have a compact projection
or an explicit omission; the original remains in the private export. Source
provenance is paged independently with `section=sources`.

HTTP uploads require `Content-Type: application/json` or `application/gzip`.

MCP `datasets` lists the same private datasets. `dataset` takes `id` and the same
read parameters. Ask Claude and external OAuth/script-key clients share the same
owner checks. OAuth, MCP keys and one-question tokens are refused by the admin
upload API, even if the account is an admin. Dataset API responses use `no-store`.
The existing View as guard refuses uploads. Account deletion cascades through all
dataset revisions and records.

## Format and storage

```json
{
  "schema": "yama-dataset/1",
  "id": "my-evidence",
  "title": "Dated source evidence",
  "generated_at": "2026-10-28T00:00:00Z",
  "source": {
    "name": "Source name",
    "url": "https://example.com/data",
    "attribution": "Required source credit",
    "license": "Source license or private use"
  },
  "method": "Population, metric definition and collection method",
  "coverage": {"partial": true},
  "sources": [],
  "records": []
}
```

Each source document has a distinct lowercase SHA-256, optional HTTP(S) `url`,
`retrieved_at`, `source_as_of`, `captured_at`, `transformation`,
`original_response_sha256`, and a `flags` array. Dates are RFC 3339 timestamps.
An archived update date cannot be later than its capture. The server validates
hash syntax and reference integrity; it does not fetch URLs or attest that a
publisher supplied the submitted bytes. Uploader identity and source attribution
are separate. The converter verifies actual local bytes before preparing them.

A record has a distinct `id`, `kind`, stable source `entity`, a nonempty `sources`
array of document hashes and object `data`. Kinds are `performance`,
`weekly_activity`, `commander`, `commander_history`, `archetype` and `source_table`.
Performance data validates identity, normalized percentage and sample size, cohort,
quality flags and an observation period. Complete calendar months require exact
start/end dates. Rolling windows require their duration and source update date.
Cumulative and unknown periods retain their separate semantics. Weekly activity
validates its entity, date, metric and nonnegative count. Other object records are
retained as source data without inventing a statistical interpretation.

Migration 0037 stores immutable revisions, their compressed original document,
source metadata and indexed records. Maximums: 32 MiB HTTP/compressed input,
128 MiB decoded JSON, 200,000 records, 10,000 source documents and 2 MiB per record.
No raw archive extraction or source URL fetching occurs during import. Every SQL
value is bound. The import and active-head update commit atomically.

Retrying the same decoded bytes returns the original revision without adding
records. Replaying an already known older revision leaves the newer head active.
New content creates a new revision; old revisions remain available by number.
Only the selected revision contributes to a read or average. Missing values are
not manufactured as zero. Stable source entities remain distinct from player
accounts and from Yama's own decks or games.

## Recency, overlap and interpretation

Bryan accepted a default **180-day exponential half-life** on 28 October 2026:

`recency weight = 2 ** (-age_days / half_life_days)`

The first descriptive summary uses complete calendar-month observations with the
same entity, entity kind, metric and declared cohort in one revision. A month's weight is its
reported sample size times recency at the month's midpoint. The result is an
average of the source's reported normalized percentages, not a pooled raw win
probability, validated prediction, causal upgrade effect or confidence interval.
Month-midpoint dating and reported-sample weighting are approximations.
The average rescales all weights by their common decay before exponentiation, so
old cohorts still produce a numeric result with a short half-life.

Duplicate representations of a month count once. Conflicting values or sample
counts for the same month exclude that month. Flagged records, partial source
captures, future months and zero-sample months are excluded. Cumulative snapshots,
overlapping rolling windows, unknown periods, weekly activity and undated ELO
sequences never enter that monthly average. A snapshot's download date does not
become the age of all games represented by it. Original evidence remains unweighted.

The recovered monthly treemaps cover only the 100 most-played commanders in each
month. Results describe that source population, with its pilot/opponent biases.
Rules, stock-list or upstream-method changes need separate cohorts or exclusions;
decay cannot repair incompatible populations. Forward-in-time validation remains
necessary before claiming predictive accuracy or choosing a different half-life.

Theme matching has no fixed card-overlap threshold. Commander configuration,
tribal/theme identity, synergy engine, win condition, tempo and interaction style
are separate signals. Archetype records are references, not automatic assignments.
Measured upgrade effects still need outcomes linked to exact lists as played.

## Follow-on work

Add scoped collector credentials using this import contract; do not give every
existing admin MCP connection upload powers. Then add
scheduled, dated source adapters with last-good-state retention, explicit dataset
promotion and a dedicated public projection. Current imports remain private and
do not change existing public precon or commander assessments.
