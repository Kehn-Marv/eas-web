"""Synthetic numbered-exercise parsing, source scope and retrieval regressions."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from eas.services.rag.pipelines.llamaindex.exercise_lookup import (
    _source_hash,
    collect_exercises,
    lookup_exercises,
    requested_exercises,
)


def text(s, page=1, **kwargs):
    return {"type": "text", "text": s, "original_page": page, **kwargs}


class ExerciseLookupTests(unittest.TestCase):
    def test_number_intent_and_exclusions(self):
        self.assertEqual(requested_exercises("2-13 2-14")[0], [(2, 13), (2, 14)])
        self.assertEqual(requested_exercises("find Chapter 2 problem 13")[0], [(2, 13)])
        self.assertEqual(requested_exercises("Exercise 9.1")[0], [(9, 1)])
        self.assertEqual(requested_exercises("find 2-13")[0], [(2, 13)])
        self.assertEqual(requested_exercises("exercises 2-13 to 2-15")[0], [(2, 13), (2, 14), (2, 15)])
        for query in [
            "explain equation 2-13",
            "what does figure 2-13 mean",
            "what does section 2.13 cover",
            "calculate 2-3",
            "gravitational acceleration 9.8",
            "explain random error",
        ]:
            self.assertEqual(requested_exercises(query)[0], [], query)

    def test_join_cross_page_table_and_stop_at_next_problem(self):
        blocks = [
            text("Chapter 2 Measurement"),
            text("Exercises"),
            text("2-14 Measured values are as follows:"),
            {"type": "equation", "text": "A = 20", "original_page": 1},
            text("56", type="page_number"),
            {"type": "header", "text": "Chapter 2 Measurement", "original_page": 2},
            {"type": "table", "table_body": "<table>B = 25</table>", "original_page": 2},
            text("Find the measurement result.", 2),
            text("2-15 Next problem", 2),
        ]
        found = collect_exercises(blocks)
        self.assertEqual(len(found), 2)
        self.assertEqual(found[0].pages, {1, 2})
        self.assertEqual(len(found[0].parts), 4)
        self.assertNotIn("56", "\n".join(found[0].parts))

    def test_chapter_only_numbers_multiple_questions_and_footer(self):
        found = collect_exercises(
            [
                text("Contents\nChapter 2 Analytic Functions...13"),
                text("Chapter 2 Analytic Functions"),
                text("Exercises"),
                text("13. Problem 1\n14. Problem 2"),
                {"type": "header", "text": "Exercises"},
                text("Continuation text"),
                text("Chapter 3 Complex Integration"),
                text("13. Not an exercise"),
            ]
        )
        self.assertEqual([(x.chapter, x.number) for x in found], [(2, 13), (2, 14)])
        self.assertIn("Continuation text", found[1].parts)

    def test_figure_equation_and_section_numbers_are_not_questions(self):
        found = collect_exercises(
            [
                text("Chapter 2 Measurement"),
                text("2.13 Section Heading", text_level=2),
                text("Figure 2-13"),
                text("Exercises"),
                text("2-13 Find numerical value"),
                text("Figure 2-14"),
                {"type": "equation", "text": "Equation 2-16"},
                text("50.82, 50.83;"),
                text("2-14 Next problem"),
            ]
        )
        self.assertEqual([(x.chapter, x.number) for x in found], [(2, 13), (2, 14)])
        self.assertIn("Equation 2-16", found[0].parts)
        self.assertIn("50.82, 50.83;", found[0].parts)

    def test_problem_types_and_images_are_preserved(self):
        found = collect_exercises(
            [
                text("Chapter 2 Magnetic Field"),
                text("Questions"),
                text("2-13 Electron"),
                {"type": "image", "image_caption": ["Question 2-13"], "original_page": 2},
                text("Continuation text"),
                text("Exercises"),
                text("2-13 Sphere"),
            ]
        )
        self.assertEqual([x.kind for x in found], ["Questions", "Exercises"])
        self.assertTrue(found[0].images)
        self.assertFalse(found[1].images)

    def test_missing_chapter_title_and_body_cross_reference(self):
        found = collect_exercises(
            [
                text("Chapter 1 Introduction"),
                text("Exercises"),
                text("1.1 First question"),
                text("Chapter 2 Magnetic Field", text_level=2),
                text("As proven in Chapter 1 Section 4.6, the condition holds."),
                text("Exercises"),
                text("2-13 Sphere"),
                text("9.1 Linearization", text_level=2),
                text("Exercises"),
                text("9.1 Disturbance"),
            ]
        )
        self.assertEqual([(x.chapter, x.number) for x in found], [(1, 1), (2, 13), (9, 1)])

    def test_missing_next_label_does_not_merge_distinct_question(self):
        found = collect_exercises(
            [
                text("Chapter 2 Magnetic Field"),
                text("Exercises"),
                text("2-18 Question content"),
                text("Exercise 2-19"),
                text("Fragmented second half of another question"),
                text("2-20 Next problem"),
            ]
        )
        self.assertEqual(found[0].parts, ["2-18 Question content"])

    def test_cache_scope_incomplete_parse_and_missing_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            kb = root / "knowledge_bases" / "one"
            raw = kb / "raw"
            raw.mkdir(parents=True)
            source = raw / "book.pdf"
            source.write_bytes(b"fake pdf for hash")
            st = source.stat()
            digest = _source_hash(str(source), st.st_mtime_ns, st.st_size)
            cache = root / "parse_cache"
            folder = cache / digest[:2] / digest / "sig"
            folder.mkdir(parents=True)
            (folder / "full_content_list.json").write_text(
                json.dumps(
                    [
                        text("Chapter 2 Magnetic Field"),
                        text("Questions"),
                        text("2-13 Electron"),
                        text("Exercises"),
                        text("2-13 Sphere"),
                    ]
                )
            )
            self.assertIsNone(lookup_exercises("exercise 2-13", kb, cache))
            (folder / "manifest.json").write_text(json.dumps({"source_hash": digest}))
            result = lookup_exercises("2-13", kb, cache)
            self.assertEqual(result["exercise_status"][0]["status"], "ambiguous")
            self.assertEqual(len(result["sources"]), 2)
            result = lookup_exercises("exercise 2-13 2-14", kb, cache)
            self.assertEqual(
                [x["status"] for x in result["exercise_status"]], ["found", "not_found"]
            )
            self.assertIn("Sphere", result["content"])
            self.assertNotIn("Electron", result["content"])
            other = root / "knowledge_bases" / "two"
            (other / "raw").mkdir(parents=True)
            self.assertIsNone(lookup_exercises("exercise 2-13", other, cache))
            self.assertIsNone(lookup_exercises("Figure 2-13", kb, cache))


class PipelineRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_parse_keeps_existing_retrieval(self) -> None:
        from eas.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

        with tempfile.TemporaryDirectory() as tmp:
            pipeline = LlamaIndexPipeline(kb_base_dir=tmp)
            with patch.object(
                pipeline, "_configure_settings", side_effect=RuntimeError("normal retrieval")
            ):
                with self.assertRaisesRegex(RuntimeError, "normal retrieval"):
                    await pipeline.search("exercise 2-13", "no-parsed-source")

    async def test_lookup_error_keeps_existing_retrieval(self) -> None:
        from eas.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

        with tempfile.TemporaryDirectory() as tmp:
            pipeline = LlamaIndexPipeline(kb_base_dir=tmp)
            with (
                patch.object(
                    pipeline, "_configure_settings", side_effect=RuntimeError("normal retrieval")
                ),
                patch(
                    "eas.services.rag.pipelines.llamaindex.exercise_lookup.lookup_exercises",
                    side_effect=OSError("unreadable cache"),
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "normal retrieval"):
                    await pipeline.search("exercise 2-13", "kb")

    async def test_exact_lookup_precedes_embedding_and_topk(self):
        from eas.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

        expected = {
            "content": "all eight questions",
            "sources": list(range(8)),
            "retrieval_method": "exercise_exact",
        }
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "kb").mkdir()
            p = LlamaIndexPipeline(kb_base_dir=tmp)
            with patch.object(
                p, "_configure_settings", side_effect=AssertionError("No embedding allowed")
            ):
                with patch(
                    "eas.services.rag.pipelines.llamaindex.exercise_lookup.lookup_exercises",
                    return_value=expected,
                ):
                    result = await p.search("exercise 2-13", "kb", top_k=1)
            self.assertEqual(result, expected)

    async def test_concept_queries_keep_existing_retrieval(self):
        from eas.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

        p = LlamaIndexPipeline(kb_base_dir="/tmp")
        with patch.object(p, "_configure_settings", side_effect=RuntimeError("original path")):
            with self.assertRaisesRegex(RuntimeError, "original path"):
                await p.search("explain Gauss theorem", "kb")


if __name__ == "__main__":
    unittest.main(verbosity=2)
