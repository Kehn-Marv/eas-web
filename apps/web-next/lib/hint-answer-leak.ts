export type HintLeakSeverity = "none" | "partial" | "direct";

export interface HintAnswerLeakInput {
  questionType: string;
  question?: unknown;
  hint: unknown;
  answer: unknown;
  choices?: unknown[];
  slots?: string[];
}

export interface HintAnswerLeakResult {
  leaksAnswer: boolean;
  severity: HintLeakSeverity;
  reasons: string[];
  matchedTerms: string[];
  checkedTerms: string[];
}

export interface SanitizeGeneratedHintInput extends HintAnswerLeakInput {
  content?: unknown;
}

const GENERIC_SINGLE_TOKEN_TERMS = new Set([
  "a",
  "an",
  "the",
  "yes",
  "no",
  "true",
  "false",
  "correct",
  "incorrect",
  "right",
  "wrong",
]);

const ORDINAL_WORDS = ["first", "second", "third", "fourth"];

const COMMON_TOKENS = new Set([
  "about",
  "above",
  "across",
  "action",
  "actions",
  "after",
  "again",
  "against",
  "answer",
  "before",
  "between",
  "choice",
  "choices",
  "compare",
  "consider",
  "content",
  "correct",
  "described",
  "detail",
  "during",
  "each",
  "fact",
  "facts",
  "final",
  "finally",
  "first",
  "from",
  "hint",
  "into",
  "lesson",
  "look",
  "next",
  "order",
  "placing",
  "problem",
  "process",
  "question",
  "recall",
  "remember",
  "role",
  "roles",
  "second",
  "sequence",
  "step",
  "steps",
  "student",
  "that",
  "then",
  "third",
  "think",
  "through",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
]);

export function fallbackHintForQuestionType(questionType: string): string {
  if (questionType === "multiple-choice") {
    return "Look for the distinguishing detail that separates the supported option from the distractors.";
  }
  if (questionType === "true-false") {
    return "Compare the statement against the specific facts described in the lesson content.";
  }
  if (questionType === "flow-diagram" || questionType === "drag-drop") {
    return "Trace the sequence described in the lesson content before placing the steps.";
  }
  return "Focus on the specific term, number, or relationship described in the lesson content.";
}

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function tokenize(value: unknown): string[] {
  return text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[a-z0-9]+(?:\.[0-9]+)?%?/g) ?? [];
}

export function normalizeForHintLeak(value: unknown): string {
  return tokenize(value).join(" ");
}

function firstContentSentence(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^[^.!?\n]+[.!?]/);
  return match ? match[0].trim() : trimmed.substring(0, 120).trim();
}

export function sanitizeGeneratedHint(input: SanitizeGeneratedHintInput): string {
  const fallback = fallbackHintForQuestionType(input.questionType);

  // Ordering hints are high-risk: even abstract labels like "setup,
  // preprocessing, request" can reveal the answer without sharing tokens with
  // the choices. Keep them neutral instead of trying to chase synonyms.
  if (
    input.questionType === "true-false" ||
    input.questionType === "flow-diagram" ||
    input.questionType === "drag-drop"
  ) {
    return fallback;
  }

  const providedHint =
    typeof input.hint === "string" && input.hint.trim().length > 0
      ? input.hint.trim()
      : null;
  const hint = providedHint ?? firstContentSentence(input.content) ?? fallback;
  const leak = detectHintAnswerLeak({ ...input, hint });

  return leak.leaksAnswer ? fallback : hint;
}

function meaningfulTerm(termTokens: string[]): boolean {
  if (termTokens.length === 0) return false;
  if (termTokens.length === 1 && GENERIC_SINGLE_TOKEN_TERMS.has(termTokens[0])) {
    return false;
  }
  return termTokens.join("").length >= 3;
}

function stemToken(token: string): string {
  if (/\d/.test(token)) return token;
  if (token.length > 5 && token.endsWith("ing")) {
    let stem = token.slice(0, -3);
    if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
    return stem;
  }
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function stemTokenVariants(token: string): string[] {
  const variants = new Set([token, stemToken(token)]);

  if (!/\d/.test(token)) {
    if (token.length > 5 && token.endsWith("ing")) {
      let stem = token.slice(0, -3);
      if (stem.length > 3 && stem.at(-1) === stem.at(-2)) stem = stem.slice(0, -1);
      variants.add(stem);
      variants.add(`${stem}e`);
    }
    if (token.length > 3 && token.endsWith("e")) {
      variants.add(token.slice(0, -1));
    }
  }

  return [...variants].filter((variant) => variant.length > 0);
}

function distinctiveStem(token: string): boolean {
  if (COMMON_TOKENS.has(token)) return false;
  return /\d/.test(token) || token.length >= 4;
}

function distinctiveStemSet(value: unknown): Set<string> {
  return new Set(
    tokenize(value)
      .flatMap((token) => (COMMON_TOKENS.has(token) ? [] : stemTokenVariants(token)))
      .filter(distinctiveStem)
  );
}

function distinctiveStemPositions(value: unknown): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  tokenize(value).forEach((token, index) => {
    if (COMMON_TOKENS.has(token)) return;
    for (const stem of stemTokenVariants(token).filter(distinctiveStem)) {
      const existing = positions.get(stem) ?? [];
      existing.push(index);
      positions.set(stem, existing);
    }
  });
  return positions;
}

function findPhrase(haystack: string[], needle: string[]): number {
  if (!meaningfulTerm(needle) || needle.length > haystack.length) return -1;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function selectedChoice(answer: unknown, choices?: unknown[]): unknown {
  if (!Array.isArray(choices)) return undefined;
  const index = typeof answer === "number" ? answer : Number(answer);
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) return undefined;
  return choices[index];
}

function orderedChoices(answer: unknown, choices?: unknown[]): unknown[] {
  if (!Array.isArray(answer) || !Array.isArray(choices)) return [];
  return answer
    .map((choiceIndex) => {
      const index = typeof choiceIndex === "number" ? choiceIndex : Number(choiceIndex);
      return Number.isInteger(index) && index >= 0 && index < choices.length
        ? choices[index]
        : undefined;
    })
    .filter((value) => value != null);
}

function explicitTruthValueLeak(hint: string, answer: unknown): string | null {
  if (typeof answer !== "boolean") return null;
  const hintNorm = ` ${normalizeForHintLeak(hint)} `;
  const truePatterns = [
    /\b(?:statement|claim|question|answer)\s+(?:is|would be)\s+(?:true|correct|right)\b/,
    /\b(?:correct|right)\s+(?:statement|claim|answer)\b/,
    /\b(?:correct|right)\s+(?:answer|choice)\s+(?:is|would be)\s+true\b/,
  ];
  const falsePatterns = [
    /\b(?:statement|claim|question|answer)\s+(?:is|would be)\s+(?:false|incorrect|wrong)\b/,
    /\b(?:incorrect|wrong)\s+(?:statement|claim|answer)\b/,
    /\b(?:not|isnt|isn t)\s+true\b/,
    /\b(?:correct|right)\s+(?:answer|choice)\s+(?:is|would be)\s+false\b/,
  ];
  const patterns = answer ? truePatterns : falsePatterns;
  return patterns.some((pattern) => pattern.test(hintNorm))
    ? `hint explicitly gives the true/false verdict (${answer})`
    : null;
}

function multipleChoiceOrdinalLeak(hintTokens: string[], answer: unknown): string | null {
  const index = typeof answer === "number" ? answer : Number(answer);
  if (!Number.isInteger(index) || index < 0 || index >= ORDINAL_WORDS.length) return null;

  const hintNorm = ` ${hintTokens.join(" ")} `;
  const ordinal = ORDINAL_WORDS[index];
  const numeric = String(index + 1);
  const patterns = [
    new RegExp(`\\b${ordinal}\\s+(?:option|choice|answer)\\b`),
    new RegExp(`\\b(?:option|choice|answer)\\s+${numeric}\\b`),
  ];
  return patterns.some((pattern) => pattern.test(hintNorm))
    ? `hint identifies the correct multiple-choice position (${ordinal})`
    : null;
}

function multipleChoiceUniqueTermLeak({
  hintText,
  question,
  answer,
  choices,
}: {
  hintText: string;
  question: unknown;
  answer: unknown;
  choices?: unknown[];
}): { reason: string; terms: string[] } | null {
  const correctChoice = selectedChoice(answer, choices);
  if (correctChoice == null || !Array.isArray(choices) || choices.length < 2) return null;

  // This heuristic is only safe when the question is available. Terms already
  // present in the question are fair game for hints, e.g. "32k context model".
  const questionStems = distinctiveStemSet(question);
  if (questionStems.size === 0) return null;

  const hintStems = distinctiveStemSet(hintText);
  const correctStems = distinctiveStemSet(correctChoice);
  const distractorStems = new Set<string>();
  const answerIndex = typeof answer === "number" ? answer : Number(answer);

  choices.forEach((choice, index) => {
    if (index === answerIndex) return;
    for (const stem of distinctiveStemSet(choice)) distractorStems.add(stem);
  });

  const leakedTerms = [...correctStems].filter(
    (stem) =>
      hintStems.has(stem) &&
      !questionStems.has(stem) &&
      !distractorStems.has(stem) &&
      (/\d/.test(stem) || stem.length >= 5)
  );

  if (leakedTerms.length === 0) return null;

  return {
    reason: "hint uses terms unique to the correct multiple-choice option",
    terms: leakedTerms,
  };
}

function strongerSeverity(a: HintLeakSeverity, b: HintLeakSeverity): HintLeakSeverity {
  if (a === "direct" || b === "direct") return "direct";
  if (a === "partial" || b === "partial") return "partial";
  return "none";
}

function flowSequenceRisk(hintText: string, ordered: unknown[]): { reason: string; terms: string[] } | null {
  if (ordered.length < 2) return null;

  const hintNorm = ` ${normalizeForHintLeak(hintText)} `;
  const hintStems = distinctiveStemSet(hintText);
  const hintPositions = distinctiveStemPositions(hintText);
  const stepStemSets = ordered.map(distinctiveStemSet);
  const stemCounts = new Map<string, number>();

  for (const stems of stepStemSets) {
    for (const stem of stems) stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  const matchesAny = stepStemSets
    .map((stems, index) => ({
      index,
      matched: [...stems].some((stem) => hintStems.has(stem)),
    }))
    .filter((match) => match.matched);

  const matchesUnique = stepStemSets
    .map((stems, index) => ({
      index,
      matched: [...stems].some(
        (stem) => hintStems.has(stem) && stemCounts.get(stem) === 1
      ),
    }))
    .filter((match) => match.matched);

  const termPositions = stepStemSets
    .map((stems, index) => {
      const positions = [...stems]
        .flatMap((stem) => hintPositions.get(stem) ?? [])
        .sort((a, b) => a - b);
      return {
        index,
        term: text(ordered[index]),
        firstPosition: positions[0] ?? -1,
      };
    })
    .filter((match) => match.firstPosition >= 0);
  const answerOrderedTermPositions =
    termPositions.length >= 2 &&
    termPositions.every(
      (match, index) => index === 0 || match.firstPosition > termPositions[index - 1].firstPosition
    );

  const strongSequenceLanguage = [
    /\bfirst\b.*\bthen\b/,
    /\bthen\b.*\bfinally\b/,
    /\bfirst\b.*\bfinally\b/,
    /\bfrom\b.+\bto\b/,
    /\bbefore\b/,
    /\bafter\b/,
    /\bchronological\s+order\b/,
    /\bcorrect\s+order\b/,
    /\bmoves?\s+from\b/,
    /\bbegins?\s+(?:by|with)\b/,
    /\bstarts?\s+(?:by|with)\b/,
    /\bends?\s+(?:by|with)\b/,
    /\bfinally\b/,
    /\blastly\b/,
  ].some((pattern) => pattern.test(hintNorm));
  const weakSequenceLanguage =
    strongSequenceLanguage ||
    /\b(?:order|sequence|workflow|pipeline|stage|process|chronological)\b/.test(hintNorm);
  const listLike =
    (hintText.match(/[,;]/g)?.length ?? 0) >= 1 ||
    /\b(?:and|then)\b/.test(hintNorm);
  const fullAnswerTermList =
    answerOrderedTermPositions && termPositions.length >= Math.min(3, ordered.length);

  if (
    (strongSequenceLanguage && matchesAny.length >= 1) ||
    (weakSequenceLanguage && matchesUnique.length >= 2) ||
    (listLike && weakSequenceLanguage && matchesAny.length >= 1) ||
    (listLike && fullAnswerTermList)
  ) {
    if (listLike && fullAnswerTermList) {
      return {
        reason: "hint lists answer-step terms in answer order",
        terms: termPositions.map((match) => match.term),
      };
    }
    const matchedIndexes = matchesUnique.length >= 2 ? matchesUnique : matchesAny;
    return {
      reason: "hint uses sequence language with answer-step terms",
      terms: matchedIndexes.map((match) => text(ordered[match.index])),
    };
  }

  return null;
}

export function detectHintAnswerLeak(input: HintAnswerLeakInput): HintAnswerLeakResult {
  const hintText = text(input.hint);
  const hintTokens = tokenize(hintText);
  const reasons: string[] = [];
  const matchedTerms: string[] = [];
  const checkedTerms: string[] = [];
  let severity: HintLeakSeverity = "none";

  const mark = (nextSeverity: Exclude<HintLeakSeverity, "none">, reason: string, term?: unknown) => {
    severity = strongerSeverity(severity, nextSeverity);
    reasons.push(reason);
    if (term != null) matchedTerms.push(text(term));
  };

  const checkDirectTerm = (term: unknown, reason: string) => {
    const termText = text(term);
    const termTokens = tokenize(termText);
    if (!meaningfulTerm(termTokens)) return;
    checkedTerms.push(termText);
    if (findPhrase(hintTokens, termTokens) >= 0) {
      mark("direct", reason, termText);
    }
  };

  if (hintTokens.length === 0) {
    return { leaksAnswer: false, severity, reasons, matchedTerms, checkedTerms };
  }

  if (input.questionType === "short-answer") {
    checkDirectTerm(input.answer, "hint repeats the short-answer text");
  } else if (input.questionType === "multiple-choice") {
    checkDirectTerm(
      selectedChoice(input.answer, input.choices),
      "hint repeats the correct multiple-choice option"
    );
    const ordinalReason = multipleChoiceOrdinalLeak(hintTokens, input.answer);
    if (ordinalReason) mark("direct", ordinalReason);
    const uniqueTermLeak = multipleChoiceUniqueTermLeak({
      hintText,
      question: input.question,
      answer: input.answer,
      choices: input.choices,
    });
    if (uniqueTermLeak) {
      mark("partial", uniqueTermLeak.reason);
      matchedTerms.push(...uniqueTermLeak.terms);
    }
  } else if (input.questionType === "true-false") {
    const truthReason = explicitTruthValueLeak(hintText, input.answer);
    if (truthReason) mark("direct", truthReason);
  } else if (input.questionType === "flow-diagram" || input.questionType === "drag-drop") {
    const ordered = orderedChoices(input.answer, input.choices);
    const positions = ordered.map((choice) => {
      const choiceText = text(choice);
      const choiceTokens = tokenize(choiceText);
      if (meaningfulTerm(choiceTokens)) checkedTerms.push(choiceText);
      return { choice, position: findPhrase(hintTokens, choiceTokens) };
    });
    const present = positions.filter((p) => p.position >= 0);

    if (
      positions.length > 0 &&
      present.length === positions.length &&
      positions.every((p, i) => i === 0 || p.position > positions[i - 1].position)
    ) {
      mark("direct", "hint lists all ordered answer choices in the correct order");
      matchedTerms.push(...ordered.map(text));
    } else if (
      present.length >= 2 &&
      present.every((p, i) => i === 0 || p.position > present[i - 1].position)
    ) {
      mark("partial", "hint lists multiple answer choices in answer order");
      matchedTerms.push(...present.map((p) => text(p.choice)));
    }

    if (Array.isArray(input.slots) && ordered.length > 0) {
      input.slots.forEach((slot, index) => {
        const slotPosition = findPhrase(hintTokens, tokenize(slot));
        const choicePosition = findPhrase(hintTokens, tokenize(ordered[index]));
        if (slotPosition >= 0 && choicePosition >= 0) {
          mark(
            "partial",
            `hint maps answer choice to slot "${text(slot)}"`,
            ordered[index]
          );
        }
      });
    }

    const sequenceRisk = flowSequenceRisk(hintText, ordered);
    if (sequenceRisk) {
      mark("partial", sequenceRisk.reason);
      matchedTerms.push(...sequenceRisk.terms);
    }
  }

  return {
    leaksAnswer: severity !== "none",
    severity,
    reasons: [...new Set(reasons)],
    matchedTerms: [...new Set(matchedTerms)],
    checkedTerms: [...new Set(checkedTerms)],
  };
}
