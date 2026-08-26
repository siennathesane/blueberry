---
id: 5c1e07
title: Lifecycle coverage map — design ids, JUnit-first ingestion, failure-only context
status: decided
id_note: ids minted at decide 2026-08-26, collision-checked against live DAG (a742d8 93fb93 4ccba8 db227e) and retired needles (0bceba 56f858)
date: 2026-08-26
parent: 004-feature-lifecycle-template.md
source: user directives (2026-08-26): trailing [hex6] ids everywhere; simplified technical English with one trailing reference per paragraph; uniform interior DAG anchors; failure-only context injection; JUnit-only MVP with lcov read opportunistically when a file exists; 004 retrofitted as the first acceptance test
---

# Lifecycle coverage map

## Audience

Blueberry's maintainer and the resident model. This defines how decided
designs connect to the tests that prove them, so the harness can build
that context deterministically. The model authors documents and tests;
the harness owns the mapping. No LLM participates in building, joining,
or verifying the map.

## Problem

004 fixed the lifecycle ritual but left coverage soft: a decided design's
requirements ("MUSTs") have no machine-readable link to the plan steps,
todo cards, or tests that implement and prove them. The gap shows up as
three failures. Plans can claim coverage that no test enforces. Failing
tests reach the model as anonymous red — no statement of which decided
requirement just broke, no pointer to its design paragraph, no open cards
that relate to it. And the seams between design, plan, DAG, and test
suite are held together by prose memory, which drifts across sessions.

Today's artifacts already carry almost enough surface to fix this
mechanically: design docs are markdown, plans are markdown, the todo DAG
exists with forever breadcrumbs, and `deno test --junit-path` emits
machine-readable results natively. What's missing is one shared
identifier grammar, a DAG node to anchor it, and an injection rule for
when failures surface their provenance.

## Goal

A single identifier grammar — a trailing `[hex6]` tag — minted at design
decide time and carried unchanged through design paragraphs, plan GWT
rows, DAG anchor nodes, and acceptance-test names. The harness scans,
joins, and renders this with one pattern and no model involvement. When
a tagged test fails, the session receives exactly that requirement's
provenance: paragraph, doc path, GWT row, open cards. When everything
passes, the machinery is silent.

## Non-goals

- No re-numbering or restructuring of design docs into requirement lists;
  prose stays primary and the id is the only marker.
- No per-test coverage attribution in the MVP; lcov is read only when a
  file is already present, and only in aggregate.
- No ambient context: the lifecycle map is never injected unless a
  tagged test fails.
- No new test-runner, no CI service, no dashboard. The map is built from
  files that already exist in the repo.
- No LLM in the loop for extraction, joining, or verification.

## The identifier grammar

Ids are exactly six lowercase hex characters inside square brackets, at
the end of their host, preceded by a space: ` [0-9a-f]{6}` then end of
line or end of string. The harness extraction pattern is
`/\[([0-9a-f]{6})\]\s*$/` and this is the only pattern it ever uses.
Every surface uses the identical form — design paragraph ends, plan row
ends, DAG anchor labels, test-name ends. Identical format and position
everywhere is what makes joins deterministic and context assembly cheap.
[a01d2e]

## Design-time minting

Ids are assigned when a design is decided, one per requirement
paragraph, and only by the decide step. A requirement paragraph is a
paragraph that ends with a minted id; every other paragraph carries none.
One reference per paragraph, at the end — context and rationale
paragraphs stay unmarked. Ids are immutable once minted: never renamed,
never re-minted for the same requirement, never recycled after
supersession. If a design is superseded, its ids retire with it.
[b02e3f]

## Design prose

Design docs are simplified, condensed technical English. The paragraph
itself must state the requirement completely — no inline markers, no
numbered lists, no headings required to locate a requirement. If a
paragraph needs its tag to be understood, it is badly written. The
trailing id is the only structural signal: present means contract,
absent means explanation.

## Plan inheritance

The plan's GWT rows and steps carry the same trailing id as the design
paragraph they decompose. Each row states its acceptance as
Given/When/Then, in plain technical English, ending with the inherited
id. The plan never mints ids: a row ending in an id no design paragraph
owns is invalid and must be rejected at plan approval. [b02e3f]

## DAG anchors

Every decided design id gets one interior node in the todo DAG — the
anchor — created when the plan seeds the DAG. Anchors are uniform: one
id always gets exactly one anchor, whether it decomposes to one card or
many. An anchor is not work; it holds the id and links design and plan
to its children. Implementation cards hang beneath an anchor as plain
leaf cards and carry no design id themselves. The DAG therefore shows
directly which impls relate to which design tag, and the harness walks
anchor edges when building failure context. Ad-hoc cards outside any
plan remain untagged threads. [c03e4b]

## Acceptance tests

A test whose name ends with a design id proves that requirement's
acceptance; that test is the contract's witness. Interior unit tests
carry no id — the tag is meaningful precisely because it is rare. One
test proves one requirement id; a MUST may have several tagged tests
approaching from different angles. The tagged test's Given/When/Then is
the GWT row in the plan that shares its id. [d04f5c]

## Ingestion

Results arrive as JUnit XML — `deno test --junit-path` is native and the
format is the universal interchange. The harness reads the JUnit file,
extracts each testcase name's trailing id, and records
id → tests → outcomes. If an lcov file is present at its conventional
path, aggregate coverage is read opportunistically and attached to the
map; if absent, nothing happens. There is no lcov generation step in the
MVP — reading it is strictly conditional on the file existing.
[e05f6d]

## Failure-only context

The harness injects lifecycle context exactly when a tagged test fails.
The injected block is small and contains only that id's chain: the
requirement paragraph verbatim, the design doc path, the matching GWT
rows, and any open cards beneath the anchor. Green tags render nothing.
No tag present in the run renders nothing. Silence is the healthy state;
context spends only when a contract breaks. [f06a7e]

## System prompt

The system prompt carries a short, static section explaining the scheme:
what a trailing design id means, that a tagged test failing means a
decided requirement broke (not "a red test"), that the design doc must
change before a tagged test's meaning may change, and that untagged
tests are interiors free to refactor. It states what the failure block
is and that it is harness-generated and trustworthy like git status. It
contains no per-session state — state arrives only in failure blocks.
[07b8fa]

## Retrofit 004

Design 004's seven requirement paragraphs are retrofitted with ids at
this design's decide time, and the retrofit is the harness's first
acceptance test. The retrofit proves, end to end on real artifacts: id
extraction from design prose, anchor seeding, GWT inheritance into the
plan, and JUnit joins — before any new feature depends on the machinery.
machinery before any feature depends on it. [18c9ab]

## Risks

- **Id collision between design ids and card hex6s.** Both are six-hex
  strings. Mitigation: design ids draw from the same per-project id
  space as todo cards, checked at mint time — a collision is refused,
  never silently allowed.
- **Suffix regex false positives** from prose that happens to end in a
  bracketed hex string. Mitigation: the mint registry is authoritative —
  joins only recognize registered ids; unknown trailing hexes render
  nothing and are ignored.
- **Stale tags after refactors** — a renamed test keeps its id only if
  the rename preserves the trailing tag; tests moved between files keep
  working because JUnit names carry the id, not file paths.
- **Failure-block size** on a run where many tagged tests fail at once.
  Mitigation: one block per id, hard cap on concurrent blocks — beyond
  the cap, an index of ids with doc paths replaces full blocks.
- **lcov drift** — an lcov file can be stale relative to the JUnit run.
  It is labeled with its mtime in the map and never gates anything.

## MUSTs

Every decided requirement of this design, as paragraphs, minted at
decide. These eight ids are final and collision-checked; future designs
mint through the registry once it exists.

One id per requirement paragraph, trailing, in the single shared
grammar, identical across design prose, plan rows, DAG anchors, and
test names — the harness joins on one pattern and nothing else.
[a01d2e]

Ids are minted only at decide time, are immutable, and are never
recycled; plans inherit ids and never create them — an unowned id in a
plan is rejected. [b02e3f]

Every decided id gets exactly one uniform DAG anchor node; impl cards
are plain leaves beneath it and carry no id. [c03e4b]

Only tests that prove acceptance criteria carry a trailing id; tagged
tests map one-to-one to a requirement id and their GWT lives in the
plan. [d04f5c]

Ingestion is JUnit-first: results are read from a JUnit XML file; an
lcov file, if present, is read in aggregate and labeled with its mtime,
and its absence changes nothing. [e05f6d]

Lifecycle context is injected only on tagged-test failure, contains only
that id's chain — paragraph, doc path, GWT rows, open cards — and is
silent otherwise. [f06a7e]

The system prompt explains the scheme statically, with no per-session
state, and describes the failure block as harness-generated truth.
[07b8fa]

The 004 retrofit runs end to end as the first acceptance test of the
machinery before any feature depends on it. [18c9ab]

## Open questions

None blocking. The plan owns: GWT row layout inside plan bodies; the
failure block's exact render budget and concurrent-block cap; anchor
node representation in the todo store's existing schema.
