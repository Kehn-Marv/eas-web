"use client";

import { useEffect, useMemo, useState } from "react";
import { Lightbulb, Eye, X, Info, KeyRound, CheckCircle2, XCircle } from "lucide-react";
import { DragDropQuestion } from "./drag-drop-question";
import { FlowDiagram } from "./flow-diagram";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { Loader } from "@/components/ai-elements/loader";
import { detectHintAnswerLeak } from "@/lib/hint-answer-leak";
import type { LessonData, Step } from "@/lib/types";

interface LessonScreenProps {
  step: Step;
  moduleIndex: number;
  moduleTitle: string;
  lessonData: LessonData;
  successfulLessonsCount: number;
  userAnswer: string | boolean | number | number[] | null;
  showResult: boolean;
  isGrading?: boolean;
  gradingError?: string | null;
  gradingErrorCode?: string | null;
  answerResult?: { id: number; isCorrect: boolean } | null;
  onAnswerChange: (answer: string | boolean | number | number[]) => void;
  canContinue: boolean;
  onContinue: () => void;
  onRetryGrading?: () => void;
  onUpdateApiKey?: () => void;
  getButtonText: () => string;
}

const OPTION_TRANSITION =
  "transition-[background-color,border-color,box-shadow] duration-200 ease-standard";

function LessonScreen({
  step,
  moduleIndex,
  moduleTitle,
  lessonData,
  successfulLessonsCount,
  userAnswer,
  showResult,
  isGrading = false,
  gradingError = null,
  gradingErrorCode = null,
  answerResult = null,
  onAnswerChange,
  canContinue,
  onContinue,
  onRetryGrading,
  onUpdateApiKey,
  getButtonText,
}: LessonScreenProps) {
  const [shouldAnimateOnLoad, setShouldAnimateOnLoad] = useState(true);
  const questionKey = `${moduleIndex}:${lessonData.title}:${lessonData.question}`;
  const [hintState, setHintState] = useState({ key: "", visible: false });
  const [answerState, setAnswerState] = useState({ key: "", visible: false });
  const [dismissedAnswerToastId, setDismissedAnswerToastId] = useState<number | null>(null);
  const showHint = hintState.key === questionKey && hintState.visible;
  const showAnswer = answerState.key === questionKey && answerState.visible;
  const isInvalidApiKeyError = gradingErrorCode === "invalid_api_key";
  const isTrueFalseQuestion = lessonData.questionType === "true-false";
  const trueFalseExplanation = isTrueFalseQuestion
    ? lessonData.explanation?.trim()
    : "";
  const hasTrueFalseExplanation = !!trueFalseExplanation;
  const isDragDropQuestion =
    lessonData.questionType === "drag-drop" || lessonData.questionType === "flow-diagram";
  const isWrongMultipleChoiceAnswer =
    step === "answer" &&
    showResult &&
    lessonData.questionType === "multiple-choice" &&
    (answerResult?.isCorrect === false ||
      (typeof userAnswer === "number" &&
        typeof lessonData.answer === "number" &&
        userAnswer !== lessonData.answer));
  const isWrongShortAnswer =
    step === "answer" &&
    showResult &&
    lessonData.questionType === "short-answer" &&
    lessonData.gradingResult?.isCorrect === false &&
    !isGrading &&
    !gradingError;
  const isWrongDragDropAnswer =
    step === "answer" &&
    showResult &&
    isDragDropQuestion &&
    answerResult?.isCorrect === false;
  const effectiveShowAnswer =
    showAnswer || isWrongMultipleChoiceAnswer || isWrongShortAnswer || isWrongDragDropAnswer;
  const showSupplementalAnswerContext =
    effectiveShowAnswer &&
    lessonData.questionType !== "short-answer" &&
    lessonData.questionType !== "multiple-choice" &&
    (!isTrueFalseQuestion || !hasTrueFalseExplanation) &&
    !isDragDropQuestion;
  const visibleAnswerToast =
    step === "answer" &&
    showResult &&
    answerResult &&
    dismissedAnswerToastId !== answerResult.id
      ? answerResult
      : null;
  const visibleAnswerToastId = visibleAnswerToast?.id ?? null;
  const hintLeak = useMemo(
    () =>
      detectHintAnswerLeak({
        questionType: lessonData.questionType,
        question: lessonData.question,
        hint: lessonData.info,
        answer: lessonData.answer,
        choices: lessonData.choices,
        slots: lessonData.slots,
      }),
    [
      lessonData.answer,
      lessonData.choices,
      lessonData.info,
      lessonData.question,
      lessonData.questionType,
      lessonData.slots,
    ]
  );
  const canShowInfoHint = lessonData.info.trim().length > 0 && !hintLeak.leaksAnswer;
  const canShowFlowHint = lessonData.questionType === "flow-diagram" && !!lessonData.flowConfig;
  const canShowHint = canShowInfoHint || canShowFlowHint;
  const showInfoHint = showHint && canShowInfoHint;
  const showFlowHint = showHint && canShowFlowHint;
  const showHintButtonText =
    canShowFlowHint && !canShowInfoHint ? "Show process flow" : "Show hint";
  const hideHintButtonText =
    canShowFlowHint && !canShowInfoHint ? "Hide process flow" : "Hide hint";
  const revealButtonLabel = hasTrueFalseExplanation ? "Show explanation" : "Show answer";

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setShouldAnimateOnLoad(false);
    }, 320);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!visibleAnswerToastId) return;

    const timeoutId = window.setTimeout(() => {
      setDismissedAnswerToastId(visibleAnswerToastId);
    }, 3200);

    return () => window.clearTimeout(timeoutId);
  }, [visibleAnswerToastId]);

  const toggleHint = () => {
    setHintState((current) => ({
      key: questionKey,
      visible: current.key === questionKey ? !current.visible : true,
    }));
  };

  const hideHint = () => {
    setHintState({ key: questionKey, visible: false });
  };

  const revealAnswer = () => {
    setAnswerState({ key: questionKey, visible: true });
  };

  const animateClass = (condition = true) =>
    shouldAnimateOnLoad && condition ? "animate-fadeInUp" : "";

  const renderIncorrectSlots = () => {
    if (!showResult || !lessonData.choices || !lessonData.slots) return null;
    const correctAnswer = lessonData.answer as number[];
    const currentUserAnswer = (userAnswer as number[]) || [];
    const incorrectSlots = lessonData.slots
      .map((slot, slotIndex) => {
        const assignedChoiceIndex = currentUserAnswer[slotIndex] ?? -1;
        if (assignedChoiceIndex !== correctAnswer[slotIndex]) {
          return { slotIndex, correctChoice: lessonData.choices![correctAnswer[slotIndex]] };
        }
        return null;
      })
      .filter(Boolean);

    if (incorrectSlots.length === 0) return null;

    return (
      <Callout variant="info" title="Correct answers" className="mt-4">
        <div className="space-y-2">
          {incorrectSlots.map((item) => (
            <div key={item!.slotIndex} className="flex items-start gap-2">
              <span className="text-sm font-medium text-neutral-600 min-w-[24px]">
                {item!.slotIndex + 1}.
              </span>
              <span className="text-sm text-neutral-800">{item!.correctChoice}</span>
            </div>
          ))}
        </div>
      </Callout>
    );
  };

  return (
    <>
      {visibleAnswerToast && (
        <div
          key={visibleAnswerToast.id}
          role="status"
          aria-live="polite"
          className={`pointer-events-none fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-xl border p-4 shadow-lg animate-toast ${
            visibleAnswerToast.isCorrect
              ? "border-correct-border bg-correct-bg text-correct-fg"
              : "border-incorrect-border bg-incorrect-bg text-incorrect-fg"
          }`}
        >
          <div className="flex items-start gap-3">
            {visibleAnswerToast.isCorrect ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-correct" />
            ) : (
              <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-incorrect" />
            )}
            <div>
              <p className="text-sm font-semibold">
                {visibleAnswerToast.isCorrect ? "Correct answer" : "Incorrect answer"}
              </p>
              <p className="text-sm">
                {visibleAnswerToast.isCorrect
                  ? "Your answer is correct."
                  : "Your answer is incorrect."}
              </p>
            </div>
          </div>
        </div>
      )}

      {step === "module-intro" && (
        <div>
          <h1 className={`text-3xl font-bold text-neutral-900 mb-8 ${animateClass()}`}>
            Welcome to Module {moduleIndex + 1}! Let&rsquo;s start with{" "}
            {moduleTitle.toLowerCase()}
          </h1>
          <p
            className={`text-lg text-neutral-600 leading-relaxed ${animateClass()}`}
            style={{ animationDelay: "0.1s" }}
          >
            This module contains {successfulLessonsCount} interactive lessons about{" "}
            {moduleTitle.toLowerCase()}.
          </p>
        </div>
      )}

      {step === "content" && (
        <div className="space-y-8">
          <h1 className={`text-2xl font-bold text-neutral-900 ${animateClass()}`}>
            {lessonData.title}
          </h1>
          <p
            className={`text-lg text-neutral-800 leading-relaxed ${animateClass()}`}
            style={{ animationDelay: "0.1s" }}
          >
            {lessonData.content}
          </p>

          {lessonData.questionType === "flow-diagram" && lessonData.flowConfig && (
            <Callout
              variant="info"
              icon={<Info className="w-5 h-5 text-info" />}
              title="Study this process flow carefully — you’ll be tested on the sequence!"
              className={`border-2 ${animateClass()}`}
              style={{ animationDelay: "0.3s" }}
            >
              <div className="h-[360px] sm:h-[500px]">
                <FlowDiagram config={lessonData.flowConfig} />
              </div>
            </Callout>
          )}
        </div>
      )}

      {(step === "question" || step === "answer") && (
        <div className="space-y-8">
          <h1 className={`text-2xl font-bold text-neutral-900 ${animateClass(!showResult)}`}>
            {lessonData.title}
          </h1>

          {!showResult && canShowHint && (
            <div
              className={animateClass(!showResult)}
              style={!showResult ? { animationDelay: "0.1s" } : {}}
            >
              <button
                onClick={toggleHint}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hint-bg text-hint-fg border border-hint-border hover:brightness-95 text-sm font-medium ${OPTION_TRANSITION}`}
              >
                {showHint ? <X className="w-4 h-4" /> : <Lightbulb className="w-4 h-4" />}
                {showHint ? hideHintButtonText : showHintButtonText}
              </button>
              {showInfoHint && (
                <Callout variant="hint" className="mt-3">
                  {lessonData.info}
                </Callout>
              )}
            </div>
          )}

          {/* Show answer toggle */}
          {showResult && !effectiveShowAnswer && (
            <div>
              <button
                onClick={revealAnswer}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-info-bg text-info-fg border border-info-border hover:brightness-95 text-sm font-medium ${OPTION_TRANSITION}`}
              >
                <Eye className="w-4 h-4" />
                {revealButtonLabel}
              </button>
            </div>
          )}

          {showResult && showSupplementalAnswerContext && (
            <>
              <p className="text-lg text-neutral-800 leading-relaxed">{lessonData.content}</p>
              {canShowInfoHint && <Callout variant="hint">{lessonData.info}</Callout>}
            </>
          )}

          <div className="pt-4">
            <p
              className={`text-lg font-medium text-neutral-900 mb-6 ${animateClass(!showResult)}`}
              style={!showResult ? { animationDelay: "0.2s" } : {}}
            >
              {lessonData.question}
            </p>

            {/* Multiple Choice */}
            {lessonData.questionType === "multiple-choice" && lessonData.choices && (
              <div
                className={`space-y-3 ${animateClass(!showResult)}`}
                style={!showResult ? { animationDelay: "0.3s" } : {}}
              >
                {lessonData.choices.map((choice, idx) => (
                  <button
                    key={idx}
                    onClick={() => !showResult && onAnswerChange(idx)}
                    disabled={showResult}
                    className={`w-full text-left p-5 rounded-xl flex items-center gap-4 ${OPTION_TRANSITION} ${
                      userAnswer === idx
                        ? showResult
                          ? idx === lessonData.answer
                            ? "bg-correct-bg border-2 border-correct"
                            : "bg-incorrect-bg border-2 border-incorrect"
                          : "bg-info-bg border-2 border-info"
                        : showResult && idx === lessonData.answer
                        ? "bg-correct-bg border-2 border-correct"
                        : "bg-surface-muted border-2 border-border hover:border-border-strong"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        userAnswer === idx ? "border-neutral-600" : "border-neutral-400"
                      }`}
                    >
                      {userAnswer === idx && <div className="w-3 h-3 rounded-full bg-neutral-600" />}
                    </div>
                    <span className="text-neutral-800 flex-1">
                      {typeof choice === "string"
                        ? choice.replace(/\s*\((?:CORRECT|correct|Correct)\)\s*/g, "").trim()
                        : choice}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* MC Explanation */}
            {lessonData.questionType === "multiple-choice" &&
              showResult &&
              effectiveShowAnswer &&
              lessonData.explanation && (
                <Callout variant="info" title="Explanation" className="mt-4">
                  <p className="text-neutral-800 leading-relaxed">{lessonData.explanation}</p>
                </Callout>
              )}

            {/* True/False */}
            {lessonData.questionType === "true-false" && (
              <div
                className={`space-y-3 ${animateClass(!showResult)}`}
                style={!showResult ? { animationDelay: "0.3s" } : {}}
              >
                {[true, false].map((value) => (
                  <button
                    key={value.toString()}
                    onClick={() => !showResult && onAnswerChange(value)}
                    disabled={showResult}
                    className={`w-full text-left p-5 rounded-xl flex items-center gap-4 ${OPTION_TRANSITION} ${
                      userAnswer === value
                        ? showResult
                          ? value === lessonData.answer
                            ? "bg-correct-bg border-2 border-correct"
                            : "bg-incorrect-bg border-2 border-incorrect"
                          : "bg-info-bg border-2 border-info"
                        : showResult && value === lessonData.answer
                        ? "bg-correct-bg border-2 border-correct"
                        : "bg-surface-muted border-2 border-border hover:border-border-strong"
                    }`}
                  >
                    <div
                      className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                        userAnswer === value ? "border-neutral-600" : "border-neutral-400"
                      }`}
                    >
                      {userAnswer === value && <div className="w-3 h-3 rounded-full bg-neutral-600" />}
                    </div>
                    <span className="text-neutral-800 font-medium">{value ? "True" : "False"}</span>
                  </button>
                ))}
              </div>
            )}

            {isTrueFalseQuestion &&
              showResult &&
              showAnswer &&
              hasTrueFalseExplanation && (
                <Callout variant="info" title="Explanation" className="mt-4">
                  <p className="text-neutral-800 leading-relaxed">{trueFalseExplanation}</p>
                </Callout>
              )}

            {/* Short Answer */}
            {lessonData.questionType === "short-answer" && (
              <div
                className={animateClass(!showResult)}
                style={!showResult ? { animationDelay: "0.3s" } : {}}
              >
                <textarea
                  value={(userAnswer as string) || ""}
                  onChange={(e) => onAnswerChange(e.target.value)}
                  disabled={showResult || isGrading}
                  placeholder="Type your answer here..."
                  className={`w-full p-5 border-2 rounded-xl focus:outline-none resize-none text-neutral-800 bg-surface-muted transition-[border-color,background-color] duration-200 ease-standard ${
                    showResult && lessonData.gradingResult
                      ? lessonData.gradingResult.isCorrect
                        ? "border-correct bg-correct-bg"
                        : "border-incorrect bg-incorrect-bg"
                      : showResult
                      ? "border-border"
                      : "border-border focus:border-info"
                  }`}
                  rows={4}
                />
                {gradingError && (
                  <Callout
                    variant="incorrect"
                    title={isInvalidApiKeyError ? "Invalid API key" : "Error grading answer"}
                    className="mt-4"
                    action={
                      isInvalidApiKeyError && onUpdateApiKey ? (
                        <Button variant="danger" size="sm" shape="lg" onClick={onUpdateApiKey}>
                          <KeyRound className="h-4 w-4" />
                          Update key
                        </Button>
                      ) : onRetryGrading ? (
                        <Button variant="danger" size="sm" shape="lg" onClick={onRetryGrading}>
                          Retry
                        </Button>
                      ) : undefined
                    }
                  >
                    <p className="text-sm">{gradingError}</p>
                  </Callout>
                )}
                {showResult && effectiveShowAnswer && !isGrading && !gradingError && (
                  <Callout variant="info" title="Answer" className="mt-4">
                    <p className="text-neutral-800 leading-relaxed">{lessonData.answer}</p>
                  </Callout>
                )}
              </div>
            )}

            {/* Drag Drop */}
            {lessonData.questionType === "drag-drop" && lessonData.choices && lessonData.slots && (
              <div
                className={animateClass(!showResult)}
                style={!showResult ? { animationDelay: "0.3s" } : {}}
              >
                <DragDropQuestion
                  choices={lessonData.choices}
                  slots={lessonData.slots}
                  correctAnswer={lessonData.answer as number[]}
                  userAnswer={(userAnswer as number[]) || null}
                  showResult={showResult}
                  onAnswerChange={onAnswerChange}
                />
                {effectiveShowAnswer && renderIncorrectSlots()}
              </div>
            )}

            {/* Flow Diagram question */}
            {lessonData.questionType === "flow-diagram" &&
              lessonData.flowConfig &&
              lessonData.choices &&
              lessonData.slots && (
                <div
                  className={animateClass(!showResult)}
                  style={!showResult ? { animationDelay: "0.3s" } : {}}
                >
                  {(showFlowHint || (showResult && showAnswer)) && (
                    <div className="mb-8 bg-surface-muted border-2 border-border rounded-xl p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-neutral-700">Process flow</h3>
                        {!showResult && showFlowHint && (
                          <button
                            onClick={hideHint}
                            className="text-xs text-neutral-500 hover:text-neutral-700 flex items-center gap-1"
                          >
                            <X className="w-4 h-4" />
                            Hide
                          </button>
                        )}
                      </div>
                      <div className="h-[360px] sm:h-[500px]">
                        <FlowDiagram config={lessonData.flowConfig} />
                      </div>
                    </div>
                  )}

                  <DragDropQuestion
                    choices={lessonData.choices}
                    slots={lessonData.slots}
                    correctAnswer={lessonData.answer as number[]}
                    userAnswer={(userAnswer as number[]) || null}
                    showResult={showResult}
                    onAnswerChange={onAnswerChange}
                  />
                  {effectiveShowAnswer && renderIncorrectSlots()}
                </div>
              )}
          </div>
        </div>
      )}

      {/* Action button */}
      <div
        className={`mt-12 ${animateClass(step === "module-intro" || step === "content" || !showResult)}`}
        style={
          step === "module-intro" || step === "content" || !showResult
            ? { animationDelay: "0.5s" }
            : {}
        }
      >
        <Button size="lg" onClick={onContinue} disabled={!canContinue || isGrading}>
          {isGrading && <Loader size={18} />}
          {isGrading ? "Grading…" : getButtonText()}
        </Button>
      </div>

      {/* Debug Info (Local Development Only) */}
      {process.env.NODE_ENV === "development" && lessonData && step !== "module-intro" && (
        <div className="mt-12 p-6 bg-surface-muted border border-border rounded-xl">
          <h3 className="text-sm font-semibold text-neutral-900 mb-3">
            Debug: Lesson JSON (Local Only)
          </h3>
          <pre className="text-xs text-neutral-800 overflow-auto max-h-96 whitespace-pre-wrap break-words">
            {JSON.stringify(lessonData, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}

export { LessonScreen };
