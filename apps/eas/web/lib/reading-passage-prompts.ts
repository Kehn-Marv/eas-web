/**
 * What a learner can ask of a selected passage in one click.
 *
 * Each one is an ordinary message in the reading conversation, sent with the
 * passage attached the way "Ask" attaches it. They used to be extensions with
 * their own model call, their own JSON schema and their own result card beside
 * the conversation: an answer the learner could not follow up on, that was not
 * kept, and that failed on its own whenever the task model returned anything
 * but the exact JSON it asked for. The reading chat already sees the page, the
 * passage and the whole material, so it answers these better as well.
 *
 * The visible text is the whole instruction. The passage rides in the turn's
 * viewport, so nothing hidden is added to what the learner sees they sent.
 */

import type { TFunction } from "i18next";

export type PassagePromptKey = "explain" | "translate" | "guide";

export interface PassagePrompt {
  key: PassagePromptKey;
  /** Chip text on the selection popover. */
  label: string;
  /** The message sent. */
  message: string;
}

/**
 * Extension actions the prompts above replaced. The workspace hides them so
 * the same verb is not offered twice; hosts without a conversation (the young
 * learners' toolbar) still run them as extensions.
 */
export const CHAT_ROUTED_READING_ACTIONS = new Set([
  "vocabulary:explain",
  "translation:translate_en",
  "guided_learning:guide",
  "quiz:start",
]);

/**
 * "Quiz me" on the page in view, as a turn in the quiz mode of the reading
 * conversation — the same engine the composer's Quiz mode runs, with the
 * settings card skipped: a few questions, difficulty and types left to the
 * planner. The page reaches it through the turn's reading viewport.
 */
export const PAGE_QUIZ_CAPABILITY = "deep_question";
export const PAGE_QUIZ_CONFIG = {
  mode: "custom",
  num_questions: 3,
  difficulty: "",
  question_types: [],
  per_type_counts: {},
} as const;

export function passagePrompts(t: TFunction): PassagePrompt[] {
  return [
    {
      key: "explain",
      label: t("Explain"),
      message: t("Explain this passage"),
    },
    {
      key: "translate",
      label: t("Translate"),
      message: t("Translate this passage into {{language}}", {
        language: "English",
      }),
    },
    {
      key: "guide",
      label: t("Guide me"),
      message: t(
        "Guide me through this passage step by step, without giving the answer away",
      ),
    },
  ];
}
