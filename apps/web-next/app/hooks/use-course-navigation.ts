import { useState, useEffect } from "react";
import { getApiKey } from "@/lib/api-key-storage";
import { debugLog } from "@/lib/utils/debug";
import type { Course, Step } from "@/lib/types";

export type { Course, Step };

export interface ModuleStats {
  correct: number;
  total: number;
  startTime: number;
}

export interface AnswerResult {
  id: number;
  isCorrect: boolean;
}

interface UseCourseNavigationOptions {
  initialModuleIndex?: number;
  initialLessonIndex?: number;
  initialStep?: Step;
  initialCompletedModules?: number[];
  onNavigate?: (params: {
    moduleIndex: number;
    lessonIndex: number;
    step: Step;
  }) => void;
  onModuleComplete?: (completedIndex: number, allCompleted: number[]) => void;
  onNeedsApiKey?: () => void;
}

export function useCourseNavigation(
  initialCourse: Course,
  options?: UseCourseNavigationOptions
) {
  // Core state
  const [course, setCourse] = useState<Course>(initialCourse);
  const [showLanding, setShowLanding] = useState(true);
  const [showModulesScreen, setShowModulesScreen] = useState(false);

  // Sync course when initialCourse changes (for async loading)
  // Only update if we're going from empty/default course to a real course
  useEffect(() => {
    if (
      initialCourse &&
      initialCourse.modules.length > 0 &&
      (course.modules.length === 0 || course.title !== initialCourse.title)
    ) {
      setCourse(initialCourse);
    }
  }, [initialCourse, course.modules.length, course.title]);

  // Module/Lesson tracking
  const [moduleIndex, setModuleIndex] = useState(
    options?.initialModuleIndex ?? 0
  );
  const [lessonIndex, setLessonIndex] = useState(
    options?.initialLessonIndex ?? 0
  );
  const [completedModules, setCompletedModules] = useState<number[]>(
    options?.initialCompletedModules ?? []
  );

  // Sync completedModules when initialCompletedModules loads (async from localStorage)
  useEffect(() => {
    const initial = options?.initialCompletedModules;
    if (initial && initial.length > 0 && completedModules.length === 0) {
      setCompletedModules(initial);
    }
  }, [completedModules.length, options?.initialCompletedModules]);

  // Sync moduleIndex when the URL-derived initialModuleIndex changes — e.g.
  // the module dropdown calling router.push. Resets lesson/step like
  // handleStartModule so the new module starts fresh.
  //
  // moduleIndex is INTENTIONALLY not in deps. Internal navigation via
  // handleContinue updates moduleIndex *and* fires onNavigate (which the
  // page applies via window.history.pushState). pushState does not update
  // useParams in App Router, so initialModuleIndex stays stable during
  // internal advances and this effect does not re-fire. If moduleIndex were
  // in deps, internal advances would re-trigger this effect and roll the
  // hook back to the URL value.
  useEffect(() => {
    const initial = options?.initialModuleIndex;
    if (typeof initial === "number" && initial !== moduleIndex) {
      setModuleIndex(initial);
      setLessonIndex(0);
      setStep("module-intro");
      setUserAnswer(null);
      setShowResult(false);
      setAnswerResult(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options?.initialModuleIndex]);

  // Lesson interaction
  const [step, setStep] = useState<Step>(
    options?.initialStep ?? "module-intro"
  );
  const [userAnswer, setUserAnswer] = useState<
    string | boolean | number | number[] | null
  >(null);
  const [showResult, setShowResult] = useState(false);
  const [isGrading, setIsGrading] = useState(false);
  const [gradingError, setGradingError] = useState<string | null>(null);
  const [gradingErrorCode, setGradingErrorCode] = useState<string | null>(null);
  const [answerResult, setAnswerResult] = useState<AnswerResult | null>(null);
  const [moduleStats, setModuleStats] = useState<ModuleStats>({
    correct: 0,
    total: 0,
    startTime: Date.now(),
  });

  // Derived state
  const currentModule = course.modules[moduleIndex];
  const successfulLessons =
    currentModule?.lessons.filter((l) => l.success) || [];
  const currentLesson = successfulLessons[lessonIndex];

  const totalLessons = course.modules.reduce(
    (sum, mod) => sum + mod.lessons.filter((l) => l.success).length,
    0
  );

  const completedLessons =
    course.modules
      .slice(0, moduleIndex)
      .reduce(
        (sum, mod) => sum + mod.lessons.filter((l) => l.success).length,
        0
      ) + lessonIndex;

  const moduleProgressData = course.modules.map((mod, idx) => {
    let progress: number;
    if (completedModules.includes(idx)) {
      progress = 100;
    } else if (idx === moduleIndex) {
      progress = step === "module-complete"
        ? 100
        : successfulLessons.length > 0
        ? (lessonIndex / successfulLessons.length) * 100
        : 0;
    } else {
      progress = 0;
    }
    return { progress };
  });

  // Handlers
  const handleStartCourse = () => {
    setShowLanding(false);
    setShowModulesScreen(true);
  };

  const handleCourseGenerated = (generatedCourse: Course) => {
    setCourse(generatedCourse);
    setModuleIndex(0);
    setLessonIndex(0);
    setCompletedModules([]);
    setAnswerResult(null);
    setShowLanding(false);
    setShowModulesScreen(true);
  };

  const handleStartModule = (index: number) => {
    setModuleIndex(index);
    setLessonIndex(0);
    setStep("module-intro");
    setAnswerResult(null);
    setShowModulesScreen(false);
  };

  const handleBackToModules = () => {
    setShowModulesScreen(true);
  };

  const handleContinue = async () => {
    if (step === "module-intro") {
      setModuleStats({ correct: 0, total: 0, startTime: Date.now() });
      setAnswerResult(null);
      const newStep = "content";
      setStep(newStep);
      options?.onNavigate?.({
        moduleIndex,
        lessonIndex,
        step: newStep,
      });
    } else if (step === "content") {
      setAnswerResult(null);
      const newStep = "question";
      setStep(newStep);
      options?.onNavigate?.({
        moduleIndex,
        lessonIndex,
        step: newStep,
      });
    } else if (step === "question" && !showResult) {
      // Check answer and update stats
      const data = currentLesson?.data;
      if (!data) {
        debugLog.warn("[NAVIGATION] No lesson data found, returning early");
        return;
      }

      if (data.questionType === "short-answer") {
        setAnswerResult(null);
        // If we already have a grading result, clear it and re-grade
        // This ensures we always get fresh results when the user submits
        if (data.gradingResult) {
          // Clear the old grading result
          const updatedCourse = { ...course };
          const allLessons = updatedCourse.modules[moduleIndex].lessons;
          const successfulLessonIndex = successfulLessons.findIndex(
            (l) => l === currentLesson
          );
          if (successfulLessonIndex !== -1) {
            let actualIndex = 0;
            let successfulCount = 0;
            for (let i = 0; i < allLessons.length; i++) {
              if (allLessons[i].success) {
                if (successfulCount === successfulLessonIndex) {
                  actualIndex = i;
                  break;
                }
                successfulCount++;
              }
            }
            const lessonToUpdate = allLessons[actualIndex];
            if (lessonToUpdate && lessonToUpdate.success && lessonToUpdate.data.gradingResult) {
              delete lessonToUpdate.data.gradingResult;
              setCourse(updatedCourse);
              // Update the local data reference
              data.gradingResult = undefined;
            }
          }
        }
        
        // Call API to grade the answer (always, since we cleared cache if it existed)
        setIsGrading(true);
        setGradingError(null);
        setGradingErrorCode(null);

        try {
          const apiKey = getApiKey();

          const requestBody = {
            userAnswer: userAnswer as string,
            correctAnswer: data.answer as string,
            content: data.content,
            info: data.info,
            question: data.question,
          };

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (apiKey) {
            headers["X-Together-API-Key"] = apiKey;
          }

          const response = await fetch("/api/grade-short-answer", {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
          });

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorCode =
              typeof errorData.code === "string" ? errorData.code : null;
            const errorMessage =
              typeof errorData.error === "string"
                ? errorData.error
                : "Failed to grade answer";
            const isUserFacingError =
              errorCode === "invalid_api_key" || response.status === 429;

            if (isUserFacingError) {
              debugLog.log("[GRADING] User-facing API error response", {
                status: response.status,
                code: errorCode,
              });
            } else {
              debugLog.error("[GRADING] API error response", {
                status: response.status,
                errorData,
              });
            }

            setGradingErrorCode(errorCode);

            if (response.status === 429) {
              setGradingErrorCode(errorCode || "grading_limit");
              throw new Error(
                "You've used all your free grading credits. Add your API key for unlimited grading."
              );
            }
            throw new Error(errorMessage);
          }

          const result = await response.json();
          const isCorrect = result.isCorrect;
          setAnswerResult({ id: Date.now(), isCorrect });

          // Update lesson data with grading result

          const updatedCourse = { ...course };
          // Find the actual lesson index in the lessons array
          const allLessons = updatedCourse.modules[moduleIndex].lessons;
          const successfulLessonIndex = successfulLessons.findIndex(
            (l) => l === currentLesson
          );
          if (successfulLessonIndex !== -1) {
            // Find the corresponding lesson in the full lessons array
            let actualIndex = 0;
            let successfulCount = 0;
            for (let i = 0; i < allLessons.length; i++) {
              if (allLessons[i].success) {
                if (successfulCount === successfulLessonIndex) {
                  actualIndex = i;
                  break;
                }
                successfulCount++;
              }
            }
            const lessonToUpdate = allLessons[actualIndex];
            if (lessonToUpdate && lessonToUpdate.success) {
                lessonToUpdate.data.gradingResult = {
                  isCorrect,
                  gradedAt: new Date().toISOString(),
                };
                setCourse(updatedCourse);
              } else {
                debugLog.warn("[GRADING] Could not find lesson to update", {
                  actualIndex,
                  successfulLessonIndex,
                });
              }
            } else {
              debugLog.warn("[GRADING] Could not find successful lesson index");
            }

          // Update stats
          setModuleStats((prev) => ({
            ...prev,
            correct: prev.correct + (isCorrect ? 1 : 0),
            total: prev.total + 1,
          }));

          // Notify header to refresh credits
          window.dispatchEvent(new Event("credits-updated"));

          setShowResult(true);
          const newStep = "answer";
          setStep(newStep);
          options?.onNavigate?.({
            moduleIndex,
            lessonIndex,
            step: newStep,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to grade answer";
          const isUserFacingError =
            message.toLowerCase().includes("api key") ||
            message.toLowerCase().includes("free grading credits");

          if (isUserFacingError) {
            debugLog.log("[GRADING] User-facing grading error:", message);
          } else {
            debugLog.error("[GRADING] Error grading answer:", error);
          }
          setGradingError(message);
          setGradingErrorCode((current) =>
            current ||
            (message.toLowerCase().includes("api key")
              ? "invalid_api_key"
              : null)
          );
          // Don't proceed to answer step on error
        } finally {
          setIsGrading(false);
        }
      } else if (data.questionType === "drag-drop" || data.questionType === "flow-diagram") {
        // For drag-drop and flow-diagram, check arrays match exactly
        const userAnswerArray = userAnswer as number[];
        const correctAnswerArray = data.answer as number[];
        const isCorrect =
          Array.isArray(userAnswerArray) &&
          Array.isArray(correctAnswerArray) &&
          userAnswerArray.length === correctAnswerArray.length &&
          JSON.stringify(userAnswerArray) === JSON.stringify(correctAnswerArray);
        setAnswerResult({ id: Date.now(), isCorrect });

        setModuleStats((prev) => ({
          ...prev,
          correct: prev.correct + (isCorrect ? 1 : 0),
          total: prev.total + 1,
        }));

        setShowResult(true);
        const newStep = "answer";
        setStep(newStep);
        options?.onNavigate?.({
          moduleIndex,
          lessonIndex,
          step: newStep,
        });
      } else {
        // For multiple-choice and true-false, check directly
        const isCorrect = userAnswer === data.answer;
        setAnswerResult({ id: Date.now(), isCorrect });

        setModuleStats((prev) => ({
          ...prev,
          correct: prev.correct + (isCorrect ? 1 : 0),
          total: prev.total + 1,
        }));

        setShowResult(true);
        const newStep = "answer";
        setStep(newStep);
        options?.onNavigate?.({
          moduleIndex,
          lessonIndex,
          step: newStep,
        });
      }
    } else if (step === "answer") {
      // Move to next lesson or module
      if (lessonIndex < successfulLessons.length - 1) {
        const newLessonIndex = lessonIndex + 1;
        setLessonIndex(newLessonIndex);
        const newStep = "content";
        setStep(newStep);
        setUserAnswer(null);
        setShowResult(false);
        setGradingError(null);
        setGradingErrorCode(null);
        setAnswerResult(null);
        options?.onNavigate?.({
          moduleIndex,
          lessonIndex: newLessonIndex,
          step: newStep,
        });
      } else {
        // Module complete - mark as completed and advance currentModuleIndex
        const updatedCompleted = completedModules.includes(moduleIndex)
          ? completedModules
          : [...completedModules, moduleIndex];
        setCompletedModules(updatedCompleted);
        
        // Immediately notify parent to save progress
        options?.onModuleComplete?.(moduleIndex, updatedCompleted);
        
        const newStep = "module-complete";
        setStep(newStep);
        setUserAnswer(null);
        setShowResult(false);
        setGradingError(null);
        setGradingErrorCode(null);
        setAnswerResult(null);

        options?.onNavigate?.({
          moduleIndex,
          lessonIndex,
          step: newStep,
        });
      }
    } else if (step === "module-complete") {
      debugLog.log("[NAVIGATION] Moving from module-complete", {
        moduleIndex,
        totalModules: course.modules.length,
        hasNextModule: moduleIndex < course.modules.length - 1,
      });
      // Move to next module or back to modules screen
      if (moduleIndex < course.modules.length - 1) {
        const newModuleIndex = moduleIndex + 1;
        setModuleIndex(newModuleIndex);
        setLessonIndex(0);
        setAnswerResult(null);
        const newStep = "module-intro";
        setStep(newStep);
        options?.onNavigate?.({
          moduleIndex: newModuleIndex,
          lessonIndex: 0,
          step: newStep,
        });
      } else {
        // All modules complete - navigate back will be handled by the page component
        // For now, just stay on module-complete screen
        // The page component can detect this and navigate if needed
      }
    }
  };

  const handleRetryGrading = () => {
    setGradingError(null);
    setGradingErrorCode(null);
    // Retry by calling handleContinue again
    handleContinue();
  };

  const canContinue = () => {
    if (step === "question" && !showResult) {
      if (isGrading) return false;
      
      // For drag-drop and flow-diagram, check that all 3 slots are filled
      if (currentLesson?.data?.questionType === "drag-drop" || currentLesson?.data?.questionType === "flow-diagram") {
        if (Array.isArray(userAnswer)) {
          return userAnswer.length === 3 && userAnswer.every((val) => val !== -1 && val !== null && val !== undefined);
        }
        return false;
      }
      
      return userAnswer !== null;
    }
    return true;
  };

  const getButtonText = () => {
    if (step === "question" && !showResult) return "Check";
    if (step === "answer") return "Continue";
    return "Continue";
  };

  return {
    // State
    course,
    showLanding,
    showModulesScreen,
    moduleIndex,
    lessonIndex, // Export lessonIndex for progress tracking
    step,
    userAnswer,
    showResult,
    isGrading,
    gradingError,
    gradingErrorCode,
    answerResult,
    moduleStats,
    completedModules,

    // Derived state
    currentModule,
    successfulLessons,
    currentLesson,
    totalLessons,
    completedLessons,
    moduleProgressData,

    // Handlers
    handleStartCourse,
    handleCourseGenerated,
    handleStartModule,
    handleBackToModules,
    handleContinue,
    handleRetryGrading,
    setUserAnswer,
    canContinue,
    getButtonText,
  };
}
