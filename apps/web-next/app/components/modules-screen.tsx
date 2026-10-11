"use client";

import { Header } from "./header";
import { Footer } from "./footer";
import { Button } from "./ui/button";
import { MessageCircle, Share2 } from "lucide-react";
import { useState } from "react";
import type { Course } from "@/lib/types";

interface ModulesScreenProps {
  course: Course;
  courseId?: string;
  onStartModule: (moduleIndex: number) => void;
  onJumpToLesson?: (moduleIndex: number, lessonIndex: number) => void;
  completedModules: number[];
  currentModuleIndex: number;
  allComplete?: boolean;
}

function ModulesScreen({
  course,
  courseId,
  onStartModule,
  onJumpToLesson,
  completedModules,
  currentModuleIndex,
  allComplete = false,
}: ModulesScreenProps) {
  const [shareNotice, setShareNotice] = useState("");
  const totalModules = course.modules.length;
  const courseTitle = course.title.trim();
  const courseHeadline = courseTitle
    ? `We built your course on ${courseTitle}`
    : "We built your course!";

  // Calculate module progress for header
  const moduleProgressData = course.modules.map((_, idx) => ({
    progress: completedModules.includes(idx) ? 100 : (currentModuleIndex === idx ? 50 : 0),
  }));

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Header 
        courseTitle={course.title}
        course={course}
        currentModuleIndex={currentModuleIndex}
        moduleProgress={moduleProgressData}
        completedModules={completedModules}
        onModuleSelect={(moduleIndex) => onStartModule(moduleIndex)}
      />

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-6 py-16 flex-grow">
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-16">
          {/* Left Column - Course Overview */}
          <div className="flex flex-col justify-center lg:pr-16">
            <h2 className="text-4xl sm:text-5xl font-bold text-neutral-900 mb-6 leading-tight break-words">
              {allComplete ? "Course complete!" : courseHeadline}
            </h2>
            <p className="text-lg text-neutral-600 mb-12 leading-relaxed">
              {allComplete
                ? `You've completed all ${totalModules} modules. Nice work!`
                : `Explore ${totalModules} short modules built from your source, with grounded explanations and practice.`}
            </p>

            {/* Action Buttons */}
            <div className="space-y-4 pb-16 w-full flex flex-col">
              <Button
                size="lg"
                onClick={() => onStartModule(currentModuleIndex)}
                className="w-full max-w-sm"
              >
                {allComplete ? "Revisit" : "Begin"} Module {currentModuleIndex + 1}
              </Button>

              <Button
                variant="outline"
                size="lg"
                onClick={() => { window.location.href = "/chat"; }}
                className="w-full max-w-sm"
              >
                <MessageCircle className="w-5 h-5" />
                Ask EAS
              </Button>
              {courseId && <Button variant="outline" size="lg" onClick={() => void shareCourse()} className="w-full max-w-sm"><Share2 className="h-5 w-5" />Share course</Button>}
              {shareNotice && <p role="status" className="max-w-sm text-sm text-neutral-600">{shareNotice}</p>}
            </div>
          </div>

          {/* Right Column - Modules List */}
          <div className="space-y-4">
            {course.modules.map((module, index) => {
              const successfulLessons = module.lessons.filter((l) => l.success);
              const isCurrent = !allComplete && currentModuleIndex === index;
              // Module is unlocked if: it's the first module, OR the previous module is completed
              const isLocked = index > 0 && !completedModules.includes(index - 1);

              return (
                <button
                  key={index}
                  onClick={() => !isLocked && onStartModule(index)}
                  disabled={isLocked}
                  className={`w-full text-left p-6 rounded-2xl ${
                    isCurrent
                      ? "gradient-border bg-white card-hover"
                      : isLocked
                      ? "border border-border-strong bg-surface-muted opacity-50 cursor-not-allowed"
                      : "border border-border-strong bg-surface-muted card-hover hover:border-neutral-400"
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <span className="text-lg font-semibold text-neutral-400 flex-shrink-0 tabular-nums">
                      {index + 1}.
                    </span>
                    <div className="flex-1">
                      <h3 className="text-xl font-bold text-neutral-900 mb-1">
                        {module.title}
                      </h3>
                      <p className="text-neutral-600 text-sm">
                        {successfulLessons[0]?.data.title ||
                          `${successfulLessons.length} lessons`}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Debug Info (Local Development Only) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-16 space-y-6">
            {/* Quick Jump to Lessons */}
            {onJumpToLesson && (
              <div className="p-6 bg-blue-50 border border-blue-200 rounded-xl">
                <h3 className="text-sm font-semibold text-blue-900 mb-4">Debug: Jump to Lesson (Local Only)</h3>
                <div className="space-y-4">
                  {course.modules.map((module, moduleIndex) => {
                    const successfulLessons = module.lessons.filter((l) => l.success);
                    return (
                      <div key={moduleIndex} className="bg-white rounded-lg p-4 border border-blue-100">
                        <h4 className="text-sm font-semibold text-neutral-900 mb-3">
                          Module {moduleIndex + 1}: {module.title}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {successfulLessons.map((lesson, lessonIndex) => {
                            const questionType = lesson.data.questionType;
                            const getTypeColor = (type: string) => {
                              switch (type) {
                                case 'flow-diagram':
                                  return 'bg-purple-100 text-purple-800 border-purple-300 hover:bg-purple-200';
                                case 'drag-drop':
                                  return 'bg-orange-100 text-orange-800 border-orange-300 hover:bg-orange-200';
                                case 'multiple-choice':
                                  return 'bg-green-100 text-green-800 border-green-300 hover:bg-green-200';
                                case 'true-false':
                                  return 'bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-200';
                                case 'short-answer':
                                  return 'bg-yellow-100 text-yellow-800 border-yellow-300 hover:bg-yellow-200';
                                default:
                                  return 'bg-gray-100 text-gray-800 border-gray-300 hover:bg-gray-200';
                              }
                            };
                            
                            const getTypeLabel = (type: string) => {
                              switch (type) {
                                case 'flow-diagram':
                                  return '🌊 Flow';
                                case 'drag-drop':
                                  return '🔀 Drag-Drop';
                                case 'multiple-choice':
                                  return '✓ MC';
                                case 'true-false':
                                  return '✓✗ T/F';
                                case 'short-answer':
                                  return '✍️ Short';
                                default:
                                  return type;
                              }
                            };

                            return (
                              <button
                                key={lessonIndex}
                                onClick={() => onJumpToLesson(moduleIndex, lessonIndex)}
                                className={`px-3 py-2 text-xs font-medium rounded-lg border transition-all cursor-pointer ${getTypeColor(questionType)}`}
                                title={`${lesson.data.title} - Click to jump to this lesson`}
                              >
                                <div className="flex flex-col items-start gap-1">
                                  <span className="font-semibold">{getTypeLabel(questionType)}</span>
                                  <span className="text-[10px] opacity-80 max-w-[120px] truncate">
                                    {lesson.data.title}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Generation Stats */}
            <div className="p-6 bg-amber-50 border border-amber-200 rounded-xl">
              <h3 className="text-sm font-semibold text-amber-900 mb-4">Debug: Generation Stats (Local Only)</h3>
              {(() => {
                const allLessons = course.modules.flatMap((mod, modIdx) =>
                  mod.lessons.map((lesson, lessonIdx) => ({ lesson, modIdx, lessonIdx, moduleTitle: mod.title }))
                );
                const succeeded = allLessons.filter(l => l.lesson.success);
                const failed = allLessons.filter(l => !l.lesson.success);
                const totalCount = allLessons.length;
                const successRate = totalCount > 0 ? Math.round((succeeded.length / totalCount) * 100) : 0;
                const meta = (course as unknown as { _metadata?: { generationTime?: string; ocrTime?: string; courseTime?: string; pages?: number; lessonStats?: { fixed?: number; fixAttempts?: number } } })._metadata;

                return (
                  <div className="space-y-4">
                    {/* Timing info */}
                    {meta && (
                      <div className="flex flex-wrap items-center gap-3 text-xs">
                        {meta.generationTime && (
                          <span className="px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-amber-900 font-medium">
                            Total: {meta.generationTime}
                          </span>
                        )}
                        {meta.ocrTime && (
                          <span className="px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-amber-900 font-medium">
                            OCR: {meta.ocrTime}
                          </span>
                        )}
                        {meta.courseTime && (
                          <span className="px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-amber-900 font-medium">
                            Course gen: {meta.courseTime}
                          </span>
                        )}
                        {meta.pages && (
                          <span className="px-3 py-1.5 bg-white border border-amber-200 rounded-lg text-amber-900 font-medium">
                            {meta.pages} pages
                          </span>
                        )}
                      </div>
                    )}

                    {/* Summary bar */}
                    <div className="flex items-center gap-4 text-sm">
                      <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full font-medium">
                        {succeeded.length} passed
                      </span>
                      <span className={`px-3 py-1 rounded-full font-medium ${failed.length > 0 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>
                        {failed.length} failed
                      </span>
                      <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full font-medium">
                        {totalCount} total
                      </span>
                      <span className="text-amber-800 font-medium">
                        {successRate}% success rate
                      </span>
                      {meta?.lessonStats?.fixed ? (
                        <span className="px-3 py-1 bg-blue-100 text-blue-800 rounded-full font-medium">
                          {meta.lessonStats.fixed} fixed ({meta.lessonStats.fixAttempts} fix attempts)
                        </span>
                      ) : null}
                    </div>

                    {/* Progress bar */}
                    <div className="w-full h-3 bg-red-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: `${successRate}%` }}
                      />
                    </div>

                    {/* Failed lessons detail */}
                    {failed.length > 0 && (
                      <div className="space-y-2">
                        <h4 className="text-xs font-semibold text-red-800 uppercase tracking-wide">Failed Lessons</h4>
                        {failed.map(({ lesson, modIdx, lessonIdx, moduleTitle }) => {
                          const error = (lesson as unknown as { error?: { reason?: string; attempts?: number; details?: string[]; fixHistory?: unknown[] } }).error;
                          return (
                            <div key={`${modIdx}-${lessonIdx}`} className="bg-white rounded-lg p-3 border border-red-100 text-xs">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <span className="font-semibold text-neutral-900">
                                    M{modIdx + 1} L{lessonIdx + 1}
                                  </span>
                                  <span className="text-neutral-500 ml-2">{moduleTitle}</span>
                                  {lesson.data?.title && (
                                    <span className="text-neutral-600 ml-1">— {lesson.data.title}</span>
                                  )}
                                </div>
                                {error?.attempts && (
                                  <span className="flex-shrink-0 px-2 py-0.5 bg-amber-100 text-amber-800 rounded font-medium">
                                    {error.attempts} attempt{error.attempts !== 1 ? 's' : ''}
                                  </span>
                                )}
                              </div>
                              {error?.reason && (
                                <p className="mt-1 text-red-700">{error.reason}</p>
                              )}
                              {error?.details && error.details.length > 0 && (
                                <ul className="mt-1 text-red-600 list-disc list-inside">
                                  {error.details.map((d, i) => <li key={i}>{d}</li>)}
                                </ul>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Per-module breakdown */}
                    <div className="space-y-1">
                      <h4 className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Per Module</h4>
                      {course.modules.map((mod, idx) => {
                        const total = mod.lessons.length;
                        const passed = mod.lessons.filter(l => l.success).length;
                        return (
                          <div key={idx} className="flex items-center gap-2 text-xs">
                            <span className="font-medium text-neutral-700 w-24 truncate">M{idx + 1}: {mod.title}</span>
                            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${passed === total ? 'bg-green-500' : 'bg-amber-400'}`}
                                style={{ width: `${total > 0 ? (passed / total) * 100 : 0}%` }}
                              />
                            </div>
                            <span className="text-neutral-600 w-16 text-right">{passed}/{total}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      <Footer />
    </div>
  );

  async function shareCourse() {
    if (!courseId) return;
    try {
      const response = await fetch(`/v1/courses/${encodeURIComponent(courseId)}/share`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_public: true }) });
      const result = await response.json();
      if (!response.ok || !result.share_path) throw new Error(result.detail?.message || "Could not create a share link.");
      await navigator.clipboard.writeText(window.location.origin + result.share_path);
      setShareNotice("Public link copied. Anyone with it can view this course.");
    } catch (cause) {
      setShareNotice(cause instanceof Error ? cause.message : "Could not create a share link.");
    }
  }
}

export { ModulesScreen };
