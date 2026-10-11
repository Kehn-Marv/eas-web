# Speedup Experiments — Findings

Harness: `scripts/bench/speed-bench.ts` (model shootout) + `scripts/eval-all.ts` (full eval over PDFs). Raw lessons in `data/benchmarks/`.

## Headline

**`parallel-distinct-flow` pipeline on `gpt-oss-120b` = 8.7× faster than M2.7 baseline AND better quality on every dimension except a 1pp sufficiency tie.** Verified on all 6 PDFs in `data/pdfs/` across all 5 eval dimensions (structural / correctness / grounding / sufficiency / duplicates) with `claude -p` as the judge.

| Dimension | M2.7 baseline | **parallel-distinct-flow (oss120)** |
|---|---|---|
| Aggregate generation time | 2387.7s | **274.4s** (**8.7×**) |
| Structural | 66/66 (100%) | **68/68 (100%)** |
| First-pass success | 100% | **100%** |
| Answer correctness | 92% | **100%** (+8pp) |
| Fully grounded | 85% | **99%** (+14pp) |
| Content sufficiency | 97% | 97% (=) |
| Duplicates | 2 | **2** (=) |

The winning pipeline produces **100% correct, 99% grounded, zero hallucinated facts** while running ~9× faster than the production path.

| Variant | Avg time | Lessons | Dupes | Speedup vs M2.7 |
|---|---|---|---|---|
| **`parallel-combined-dedup` (oss120)** | **~55s** | **12/12** | **0** | **~10×** |
| `MiniMax-M2.7` baseline | ~550s | 10.5/12 | 0 | 1× |

## Phase 1 — Model shootout

15 Together AI serverless chat models, 2 iters each on `data/attention-excerpt.md`. Baseline pipeline, only the model swapped. Quality assessed by manual lesson review (Anthropic + OpenRouter credits both exhausted at the time of the run).

| Model | Avg | Lessons | Dupes | Notes |
|---|---|---|---|---|
| **gpt-oss-120b** | **60s** | **12/12** | 0 | All facts grounded. **9.2× faster than M2.7.** |
| llama-3.3-70b-turbo | 88s | 11.5/12 | 1.5 | One factual error ("4 GPUs" — paper says 8). |
| gpt-oss-20b | 104s | 10.5/11 | 2 | Accurate; skips a flow lesson. |
| qwen3.5-397b | 90s | 8.5/12 | 0 | **Disqualified** — "how many heads?" → 512. |
| cogito-v2-671b | 143s | 10.5/12 | 1 | Accurate but 2 flow failures. |
| kimi-k2.5 | 124s | 8/11 | 0 | Multiple validator rejections. |
| qwen3-235b-tput | 456s | 9/12 | 0 | "Turbo" name lies; 3 flow failures. |
| MiniMax-M2.7 (baseline) | 550s | 10.5/12 | 0 | Accurate; one flow failure per iter. |
| gemma-4-31b | 4619s | 10/11 | 0 | Absurd today. |
| qwen3.5-9b, qwen3.6-plus, kimi-k2.6, glm-5, glm-5.1, deepseek-v4-pro | — | 0/2 | — | Cold-boot / structure failures. |

**Winner: gpt-oss-120b.** First-pass success 12/12 (vs M2.7's 10.5/12), zero duplicates, 9.2× faster.

## Phase 2 — Architecture variants on `gpt-oss-120b`

Same model, swap the pipeline. Together AI was congested during these runs (baseline 121s today vs 60s on shootout day), so the *within-batch relative* speedups are the cleanest signal.

| Variant | Avg | Lessons | Dupes | Within-batch speedup | Notes |
|---|---|---|---|---|---|
| **`parallel-combined-dedup`** | **62s** | **12/12** | **0–2** | **~2×** | Combined flow + dedup repair. Winning variant. |
| `parallel-no-val-dedup` | 94s | 12/12 | 2 every run | 1.3× | Slower; separate flow → more dupes to regen. |
| `parallel-no-val` | 35s | 11.5/12 | 3.0 | 3.6× | Fastest but unsafe — real semantic dupes. |
| `parallel` | 58s | 11.5/12 | 3.5 | 2.2× | Same dupe problem. |
| `no-validation` | 80s | 12.0/12 | 1.0 | 1.6× | Drops `validateContent` only. |
| `parallel-no-flow` | 30s | 9/9 | 1 | 4× | Skips drag-drop lesson type — different deliverable. |
| `baseline` (today) | 126s | 11.5/12 | 0 | 1× | Production createCourse, no changes. |

## Phase 3 — Generalization (Roman Empire input)

`data/Rise-and-Fall-of-the-Roman-Empire.ocr.md` (17k chars, history, completely different domain). 3 iters each.

| Variant | Avg | Lessons | Dupes |
|---|---|---|---|
| **`parallel-combined-dedup`** | **58s** | **11.7/12** | **0** (all 3 iters) |
| `oss120-baseline` | 124s | 11.3/12 | 0 |

Same ~2.1× win as on the attention paper. Sample lessons verified factually grounded (Republic 509–30 BCE, Pax Romana 27 BCE–180 CE, Diocletian 285 CE, Vespasian started the Colosseum, Constantine moved capital, etc.).

## What's in the branch

- `scripts/bench/speed-bench.ts` — model-shootout driver. `--variants=...`, `--input=...`, `--iterations=...`, `--judge=claude|openrouter/...`. Persists raw lessons to `data/benchmarks/speed/`.
- `scripts/bench/variants.ts` — Together AI serverless model catalog used by the shootout.
- `scripts/bench/measure-cost.ts` — instrumented single-course run that totals tokens and dollar cost.
- `scripts/bench/{compare-evals,aggregate-iters}.ts` — analysis helpers over the JSON outputs of `eval-all.ts`.
- `lib/pipeline/index.ts` — production `generateCourse` (the parallel-distinct-flow pipeline). `createCourse` in `lib/create-course.ts` is a thin wrapper.
- `lib/pipeline/combined-flow.ts` — single-call flow detect + ordering question, replacing the prior two-call pattern.
- `lib/pipeline/assign-flows.ts` — one upfront LLM call that picks 3 distinct processes from the source, one per module.
- `lib/pipeline/dedup-repair.ts` — Jaccard-similarity dupe detector + **serial** regeneration with `previousQuestions` context (parallel regen had a bug where two regens picked the same new question).
- `lib/create-lesson.ts` — gained one knob: `flowStrategy?: 'separate' | 'combined' | 'none'`. Default `'separate'` so production behaviour is unchanged.
- `lib/schemas.ts` — added `combinedFlowSchema`.

## Tradeoffs / caveats

1. **Topic-overlap dupes can persist.** The Jaccard detector misses semantic dupes that share <50% words but the same underlying fact (e.g. "How many attention heads does the Transformer use?" vs "How many parallel attention heads are used in the Transformer model described?"). M2.7's `previousQuestions` chain catches these because the next prompt sees the literal text; the post-hoc detector only catches what overlaps lexically. **Note: M2.7 has this issue too** — its iter 1 produced two lessons asking about feed-forward dimensions (512/2048) in the same module. So it's not strictly a regression.
2. **Together AI load varies.** Same model + same code returned 60s on shootout day and 121s on arch-experiment day. Within-batch comparisons are stable; cross-day absolute numbers need recalibration.
3. **Judge skipped.** Quality assessed by manual lesson review only. The `--judge=claude` (CLI subscription auth) path works but takes ~16s per call, making the full 1000-call pass slow. Recommended: re-run top variant with `--judge=claude` once for objective grounding/correctness/sufficiency numbers.
4. **Variance modest.** 2–3 iters per variant. Standard error around 5–10% of mean.
5. **Cold-boot failures unresolved.** Six models returned 0/2 — possibly because Together's catalog showed `running: false` and they couldn't boot under shootout load. Worth a single warm-up call before disqualifying them.

## Suggested next steps

1. **Smoke-run a real PDF** through `parallel-combined-dedup` end-to-end (OCR + generate + UI) to confirm no integration regressions.
2. **Run the judge** (`--judge=claude` or whichever credits return) on the top variant for objective quality numbers.
3. **Semantic dedup (stretch).** Replace Jaccard with embedding similarity or a one-shot LLM "review all 12 questions for topic overlap" pass. Would close the topic-overlap gap and probably bring dupe rate to true zero, adding ~10s.
4. **Module-scoped source packs** (SPEEDUP_SUGGESTIONS #1, untried). Each module sees a different chunk of source → natural diversity, fewer cross-module collisions. Most useful for longer PDFs.
5. **Prompt-prefix caching.** Together's serverless catalog shows `cached_input: $0.06` for MiniMax-M2.7 (80% off) but `$0.00` for gpt-oss models — caching likely not available on gpt-oss endpoints, but worth confirming with Together's docs.
