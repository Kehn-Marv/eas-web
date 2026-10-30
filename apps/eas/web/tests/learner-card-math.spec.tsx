import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AskUserOptions } from "@/components/chat/home/AskUserOptions";
import { MasteryQuestionCard } from "@/components/chat/home/MasteryQuestionCard";
import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import { initI18n } from "@/i18n/init";
import type { MasteryQuestion } from "@/lib/mastery-question";

initI18n();

/**
 * The cards a learner answers on are written by the same tutor that writes the
 * prose above them, and on a maths or physics path that prose is LaTeX. Both
 * cards printed it verbatim — a Bellman-equation stem reached the reader as
 * `$G_t = R_{t+1} + \gamma G_{t+1}$`, and a bolded cue as `**understood**`.
 */
function masteryQuestion(): MasteryQuestion {
  return {
    questionId: "q1",
    prompt: "Given $G_t = R_{t+1} + \\gamma G_{t+1}$, what is the equation for $V^\\pi$?",
    questionType: "multiple_choice",
    objectiveName: "Bellman",
    difficulty: "medium",
    attempt: 1,
    options: [
      { label: "A", body: "Bootstrap: $V^\\pi(s) = E_\\pi[R_{t+1}]$" },
      { label: "B", body: "Monte Carlo sampling" },
    ],
    allowFreeText: false,
  };
}

describe("learner-facing cards render the tutor's markup", () => {
  it("renders KaTeX in a mastery question stem, its options and its verdict", async () => {
    const { container } = render(
      <MasteryQuestionCard
        question={masteryQuestion()}
        grade={{
          questionId: "q1",
          isCorrect: true,
          learnerAnswer: "A",
          correctLabel: "A",
          correctBody: "",
          explanation: "Substitution yields $V^\\pi(s)$.",
        }}
        answered
        submittedAnswer="A"
        onSubmit={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
        4,
      );
    });
    expect(container).not.toHaveTextContent("$V^\\pi$");
  });

  it("renders math and emphasis on an ask_user card", async () => {
    const { container } = render(
      <AskUserOptions
        data={{
          resolved: false,
          answers: [],
          payload: {
            intro: "First confirm one thing: did you **understand**?",
            questions: [
              {
                id: "goal",
                prompt: "What does $e^{i\\pi} + 1 = 0$ show?",
                header: "Goal",
                multi_select: false,
                allow_free_text: false,
                placeholder: null,
                options: [
                  { label: "Relation between $\\pi$ and $e$", description: null },
                  { label: "Other", description: null },
                ],
              },
            ],
          },
        }}
        onSubmit={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(
        2,
      );
    });
    expect(container).not.toHaveTextContent("**understand**");
  });

  it("renders math in a trace bubble", async () => {
    const { container } = render(
      <MarkdownRenderer
        content="Characteristic equation $r^2 + 2r + 5 = 0$, discriminant $\\Delta = -16 < 0$."
        variant="trace"
      />,
    );

    await waitFor(() => {
      expect(container.querySelectorAll(".katex")).toHaveLength(2);
    });
    expect(container).not.toHaveTextContent("$r^2 + 2r + 5 = 0$");
  });
});
