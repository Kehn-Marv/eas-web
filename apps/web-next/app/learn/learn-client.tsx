"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileText, LoaderCircle, MessageCircle } from "lucide-react";
import { Header } from "../components/header";
import { Footer } from "../components/footer";
import { LessonScreen } from "../components/lesson-screen";
import { ModuleCompleteScreen } from "../components/module-complete-screen";
import { ModulesScreen } from "../components/modules-screen";
import { Button } from "../components/ui/button";
import { LearningPathProgress } from "../components/learning-path-progress";
import type { Course, LessonData, Step } from "@/lib/types";

type Doc = { document_id: string; filename: string; status?: string; selected?: boolean; processed_page_count?: number; expected_page_count?: number };
type CourseResponse = Course & { course_id: string; current_module_index: number; current_lesson_index: number; current_step: string; completed_lesson_ids: string[]; progress_percent: number };
type StepName = "overview" | Step;
type Stage = "loading" | "overview" | "module-intro" | "content" | "question" | "answer" | "complete" | "error";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.detail?.message || "EAS could not complete that step.");
  return data as T;
}

function stepFromUrl(value: string | null): StepName | null {
  const valid: StepName[] = ["overview", "module-intro", "content", "question", "answer", "module-complete"];
  return valid.includes(value as StepName) ? value as StepName : null;
}

export function LearnClient() {
  const [stage, setStage] = useState<Stage>("loading");
  const [message, setMessage] = useState("Getting your source ready");
  const [progressStep, setProgressStep] = useState(0);
  const [pageProgress, setPageProgress] = useState<{ processed: number; total: number } | undefined>();
  const [error, setError] = useState("");
  const [courseId, setCourseId] = useState("");
  const [shareToken, setShareToken] = useState("");
  const [course, setCourse] = useState<CourseResponse | null>(null);
  const [moduleIndex, setModuleIndex] = useState(0);
  const [lessonIndex, setLessonIndex] = useState(0);
  const [step, setStep] = useState<Step>("module-intro");
  const [answer, setAnswer] = useState<string | boolean | number | number[] | null>(null);
  const [graded, setGraded] = useState<{ id: number; isCorrect: boolean; answer: LessonData["answer"]; explanation?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(Date.now());
  const [guestCompleted, setGuestCompleted] = useState<string[]>([]);
  const currentModule = course?.modules[moduleIndex];
  const currentCourseLesson = currentModule?.lessons[lessonIndex];
  const lesson = currentCourseLesson?.data;
  const completed = useMemo(() => {
    if (!course) return [];
    return course.modules.flatMap((module, index) => module.lessons.length > 0 && module.lessons.every((item) => course.completed_lesson_ids.includes(item.data.id || "") || item.completed) ? [index] : []);
  }, [course]);

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const params = new URLSearchParams(window.location.search);
        const requestedCourseId = params.get("courseId") || "";
        const requestedToken = params.get("token") || "";
        const requestedModule = Number(params.get("moduleIndex"));
        const requestedLesson = Number(params.get("lessonIndex"));
        const requestedStep = stepFromUrl(params.get("step"));
        if (requestedToken) {
          const data = await request<CourseResponse>("/v1/shared/" + encodeURIComponent(requestedToken));
          if (cancelled) return;
          setShareToken(requestedToken);
          setCourse(data);
          const guest = JSON.parse(localStorage.getItem("eas.shared." + requestedToken) || "[]") as string[];
          setGuestCompleted(guest);
          const mi = Number.isInteger(requestedModule) && params.has("moduleIndex") ? requestedModule : 0;
          const li = Number.isInteger(requestedLesson) && params.has("lessonIndex") ? requestedLesson : 0;
          const safeModule = Math.min(Math.max(mi, 0), Math.max(data.modules.length - 1, 0));
          const safeLesson = Math.min(Math.max(li, 0), Math.max((data.modules[safeModule]?.lessons.length || 1) - 1, 0));
          setModuleIndex(safeModule); setLessonIndex(safeLesson);
          const initial = requestedStep === "answer" ? "question" : requestedStep || "overview";
          setStage(stageFor(initial));
          setStep(initial === "overview" ? "module-intro" : initial);
          return;
        }
        if (requestedCourseId) {
          const data = await request<CourseResponse>("/v1/courses/" + encodeURIComponent(requestedCourseId));
          if (cancelled) return;
          setCourseId(data.course_id); setCourse(data);
          const hasRoute = params.has("moduleIndex") || params.has("lessonIndex") || params.has("step");
          const mi = hasRoute && Number.isInteger(requestedModule) ? requestedModule : data.current_module_index;
          const li = hasRoute && Number.isInteger(requestedLesson) ? requestedLesson : data.current_lesson_index;
          const initial = hasRoute ? requestedStep || "module-intro" : stepFromUrl(data.current_step) || "overview";
          const safeModule = Math.min(Math.max(mi, 0), Math.max(data.modules.length - 1, 0));
          const safeLesson = Math.min(Math.max(li, 0), Math.max((data.modules[safeModule]?.lessons.length || 1) - 1, 0));
          setModuleIndex(safeModule);
          setLessonIndex(safeLesson);
          const savedLesson = data.modules[safeModule]?.lessons[safeLesson];
          if (initial === "answer" && (savedLesson?.attempt_count || 0) > 0 && savedLesson?.data.answer !== undefined) {
            setAnswer(savedLesson.last_answer ?? null);
            setGraded({ id: Date.now(), isCorrect: savedLesson.last_correct === true, answer: savedLesson.data.answer, explanation: savedLesson.data.explanation });
          }
          setStage(stageFor(initial));
          setStep(initial === "overview" ? "module-intro" : initial);
          return;
        }

        const saved = JSON.parse(localStorage.getItem("eas.study.v2") || "{}") as { sessionId?: string; documents?: Doc[] };
        if (!saved.sessionId || !saved.documents?.length) throw new Error("Upload a source to build your learning path.");
        await request("/v1/sessions/" + encodeURIComponent(saved.sessionId));
        let docs = saved.documents.filter((doc) => doc.selected !== false);
        updateIngestionProgress(docs, setProgressStep, setMessage, setPageProgress);
        for (let attempt = 0; docs.some((doc) => !["READY", "DEGRADED", "FAILED"].includes(doc.status || "")) && attempt < 600; attempt++) {
          if (cancelled) return;
          await new Promise((resolve) => window.setTimeout(resolve, 1800));
          docs = await Promise.all(docs.map(async (doc) => ({ ...doc, ...await request<Doc>("/v1/documents/" + encodeURIComponent(doc.document_id) + "/status") })));
          updateIngestionProgress(docs, setProgressStep, setMessage, setPageProgress);
          localStorage.setItem("eas.study.v2", JSON.stringify({ ...saved, documents: docs }));
        }
        const ready = docs.filter((doc) => doc.status === "READY" || doc.status === "DEGRADED");
        if (!ready.length) throw new Error("EAS could not read this source. Upload it again from the home page.");
        setProgressStep(3); setMessage("Building your lessons and practice");
        const created = await request<CourseResponse>("/v1/courses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document_ids: ready.map((doc) => doc.document_id) }) });
        if (!cancelled) window.location.replace("/learn?courseId=" + encodeURIComponent(created.course_id));
      } catch (cause) {
        if (!cancelled) { setError(cause instanceof Error ? cause.message : "Your learning path could not be opened."); setStage("error"); }
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, []);

  function updateIngestionProgress(docs: Doc[], set: (n: number) => void, detail: (s: string) => void, pages: (value: { processed: number; total: number } | undefined) => void) {
    const statuses = docs.map((doc) => doc.status || "UPLOADING");
    const status = statuses.find((item) => !["READY", "DEGRADED", "FAILED"].includes(item)) || statuses.find((item) => item === "READY" || item === "DEGRADED") || statuses[0];
    const counts = docs.reduce((total, doc) => ({ processed: total.processed + (doc.processed_page_count || 0), expected: total.expected + (doc.expected_page_count || 0) }), { processed: 0, expected: 0 });
    pages(counts.expected > 0 ? { processed: counts.processed, total: counts.expected } : undefined);
    if (["UPLOADING", "VALIDATING", "STORING"].includes(status)) { set(0); detail("Uploading PDF to secure storage"); }
    else if (["PREFLIGHT", "PARSING", "OCR_FALLBACK", "EXTRACTING_ASSETS"].includes(status)) { set(1); detail(status === "OCR_FALLBACK" ? "Reading scanned pages with text recognition" : "Reading your source"); }
    else if (["BUILDING_STRUCTURE", "BUILDING_INDEX", "VALIDATING_COVERAGE"].includes(status)) { set(2); detail("Organizing the ideas and checking source coverage"); }
    else if (["READY", "DEGRADED"].includes(status)) { set(3); detail("Preparing lessons from your source"); }
  }

  function setRoute(nextModule: number, nextLesson: number, nextStep: StepName) {
    setModuleIndex(nextModule); setLessonIndex(nextLesson);
    if (nextStep !== "overview") setStep(nextStep);
    const params = new URLSearchParams();
    if (shareToken) params.set("token", shareToken); else params.set("courseId", courseId);
    if (nextStep !== "overview") { params.set("moduleIndex", String(nextModule)); params.set("lessonIndex", String(nextLesson)); params.set("step", nextStep); }
    window.history.replaceState(null, "", "/learn?" + params.toString());
    setStage(stageFor(nextStep));
    if (!shareToken && courseId) {
      void request("/v1/courses/" + encodeURIComponent(courseId) + "/progress", { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ module_index: nextModule, lesson_index: nextLesson, step: nextStep }) }).catch(() => undefined);
    }
  }

  function startModule(index: number, lessonPosition = 0) {
    setAnswer(null); setGraded(null); setStartedAt(Date.now()); setRoute(index, lessonPosition, "module-intro");
  }

  async function submitAnswer() {
    if (!course || !currentCourseLesson || !lesson?.id || answer === null || answer === "") return;
    setBusy(true);
    try {
      const url = shareToken
        ? "/v1/shared/" + encodeURIComponent(shareToken) + "/lessons/" + encodeURIComponent(lesson.id) + "/answer"
        : "/v1/courses/" + encodeURIComponent(courseId) + "/lessons/" + encodeURIComponent(lesson.id) + "/answer";
      const result = await request<{ correctness: boolean; answer: LessonData["answer"]; explanation?: string }>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }) });
      setGraded({ id: Date.now(), isCorrect: result.correctness, answer: result.answer, explanation: result.explanation });
      const updated = { ...course, modules: course.modules.map((module, mi) => ({ ...module, lessons: module.lessons.map((item, li) => mi === moduleIndex && li === lessonIndex ? { ...item, data: { ...item.data, answer: result.answer, explanation: result.explanation }, completed: item.completed || result.correctness } : item) })), completed_lesson_ids: result.correctness ? [...new Set([...course.completed_lesson_ids, lesson.id])] : course.completed_lesson_ids };
      setCourse(updated);
      if (result.correctness && shareToken) {
        const next = [...new Set([...guestCompleted, lesson.id])]; setGuestCompleted(next); localStorage.setItem("eas.shared." + shareToken, JSON.stringify(next));
      }
      setRoute(moduleIndex, lessonIndex, "answer");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Your answer could not be checked."); setStage("error"); }
    finally { setBusy(false); }
  }

  function continueStep() {
    if (!course || !currentModule) return;
    if (step === "module-intro") setRoute(moduleIndex, lessonIndex, "content");
    else if (step === "content") setRoute(moduleIndex, lessonIndex, "question");
    else if (step === "question") void submitAnswer();
    else if (step === "answer" && graded?.isCorrect === false) { setAnswer(null); setGraded(null); setRoute(moduleIndex, lessonIndex, "question"); }
    else if (step === "answer") {
      if (lessonIndex < currentModule.lessons.length - 1) startModule(moduleIndex, lessonIndex + 1);
      else setRoute(moduleIndex, lessonIndex, "module-complete");
    }
  }

  if (stage === "loading" || stage === "overview" && !course) return <LearningPathProgress activeStep={progressStep} detail={message} pageProgress={pageProgress} />;
  if (stage === "error") return <ErrorScreen message={error} onRetry={() => window.location.reload()} />;
  if (!course) return null;
  const currentLessonData = lesson ? { ...lesson, ...(graded ? { answer: graded.answer, explanation: graded.explanation, gradingResult: { isCorrect: graded.isCorrect, gradedAt: new Date(graded.id).toISOString() } } : {}) } : { title: currentModule?.title || "Lesson", content: "", info: "", question: "", answer: "", questionType: "short-answer" as const };
  const computedCompleted = shareToken
    ? course.modules.flatMap((module, index) => module.lessons.length > 0 && module.lessons.every((item) => guestCompleted.includes(item.data.id || "")) ? [index] : [])
    : completed;
  const allComplete = course.modules.length > 0 && computedCompleted.length === course.modules.length;
  if (stage === "overview") return <ModulesScreen course={course} courseId={course.course_id} onStartModule={startModule} completedModules={computedCompleted} currentModuleIndex={Math.max(0, course.modules.findIndex((_module, index) => !computedCompleted.includes(index)))} allComplete={allComplete} />;

  const sourceRefs = (lesson as LessonData & { source_refs?: Array<{ page_number: number }> } | undefined)?.source_refs || [];
  return <div className="min-h-screen bg-white flex flex-col">
    <Header showProgressBar courseTitle={course.title} course={course} currentModuleIndex={moduleIndex} completedModules={computedCompleted} moduleProgress={course.modules.map((module, index) => ({ progress: computedCompleted.includes(index) ? 100 : index === moduleIndex ? Math.round((lessonIndex / Math.max(module.lessons.length, 1)) * 100) : 0 }))} onModuleSelect={startModule} />
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-6 py-8 md:py-12"><div className="mx-auto w-full max-w-2xl flex-1">
      {stage === "complete" ? <ModuleCompleteScreen moduleIndex={moduleIndex} moduleTitle={currentModule?.title || "Lesson"} moduleStats={{ correct: currentModule?.lessons.length || 1, total: currentModule?.lessons.length || 1, startTime: startedAt }} successfulLessons={currentModule?.lessons || []} hasNextModule={moduleIndex < course.modules.length - 1} onContinue={() => startModule(Math.min(moduleIndex + 1, course.modules.length - 1))} onBackToModules={() => setRoute(0, 0, "overview")} /> : <>
        <div className="mb-7 flex items-center justify-between gap-3 border-b border-border pb-4"><p className="text-sm font-medium text-neutral-600">Module {moduleIndex + 1} of {course.modules.length} · Lesson {lessonIndex + 1} of {currentModule?.lessons.length || 1}</p><div className="flex items-center gap-2"><button type="button" onClick={() => void navigator.clipboard.writeText(window.location.href)} className="rounded-full border border-border px-4 py-2 text-sm text-neutral-700 transition hover:bg-surface-subtle">Copy lesson link</button><Link href="/chat" className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-neutral-700 transition hover:bg-surface-subtle"><MessageCircle className="h-4 w-4" />Ask EAS</Link></div></div>
        {busy && <div role="status" className="mb-6 flex items-center gap-3 rounded-2xl border border-border bg-surface-subtle p-4 text-sm text-neutral-600"><LoaderCircle className="h-5 w-5 animate-spin" />Checking your answer</div>}
        <LessonScreen step={step} moduleIndex={moduleIndex} moduleTitle={currentModule?.title || "Lesson"} lessonData={currentLessonData} successfulLessonsCount={currentModule?.lessons.length || 1} userAnswer={answer} showResult={stage === "answer"} isGrading={busy && stage === "question"} answerResult={graded} onAnswerChange={(value) => setAnswer(value)} canContinue={step !== "question" || (answer !== null && answer !== "")} onContinue={continueStep} getButtonText={() => step === "question" ? "Check" : step === "answer" && graded?.isCorrect === false ? "Try again" : step === "answer" ? lessonIndex < (currentModule?.lessons.length || 1) - 1 ? "Next lesson" : "Finish module" : "Continue"} />
        {sourceRefs.length > 0 && <div className="mt-8 flex flex-wrap gap-2 border-t border-border pt-5">{sourceRefs.map((citation, index) => <span key={index} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-xs text-neutral-600"><FileText className="h-3.5 w-3.5" />Source · page {citation.page_number}</span>)}</div>}
      </>}
    </div></main><Footer />
  </div>;
}

function stageFor(step: StepName): Stage { return step === "overview" ? "overview" : step === "module-complete" ? "complete" : step; }

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="flex min-h-screen flex-col bg-white"><Header /><main className="flex flex-1 flex-col items-center justify-center px-6 text-center"><div className="max-w-lg rounded-2xl border border-border p-8"><h1 className="text-2xl font-bold text-neutral-900">Your learning path isn’t ready yet</h1><p className="mt-3 text-neutral-600">{message}</p><div className="mt-6 flex justify-center gap-3"><Button onClick={onRetry}>Try again</Button><Link href="/" className="inline-flex h-11 items-center rounded-full border border-border px-5 text-sm font-medium">Upload a source</Link></div></div></main><Footer /></div>;
}
