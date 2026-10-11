"use client";

import { useState } from "react";
import Image from "next/image";
import { List } from "lucide-react";
import { Button } from "./ui/button";
import type { FlowConfig } from "@/lib/types";

interface LessonData {
  content: string;
  info: string;
  question: string;
  answer: string | boolean | number | number[];
  title: string;
  questionType: string;
  choices?: string[];
  slots?: string[];
  flowConfig?: FlowConfig;
}

interface Lesson {
  success: boolean;
  data: LessonData;
}

interface ModuleCompleteScreenProps {
  moduleIndex: number;
  moduleTitle: string;
  moduleStats: {
    correct: number;
    total: number;
    startTime: number;
  };
  successfulLessons: Lesson[];
  hasNextModule: boolean;
  onContinue: () => void;
  onBackToModules: () => void;
}

function ModuleCompleteScreen({
  moduleIndex,
  moduleTitle,
  moduleStats,
  successfulLessons,
  hasNextModule,
  onContinue,
  onBackToModules,
}: ModuleCompleteScreenProps) {
  const [elapsedMinutes] = useState(() =>
    Math.max(1, Math.round((Date.now() - moduleStats.startTime) / 60000))
  );

  return (
    <div className="text-center">
      {/* Celebration */}
      <div className="mb-4 flex justify-center animate-scaleIn">
        <Image
          src="/great-work.webp"
          alt="Great work"
          width={120}
          height={109}
          priority
          className="h-auto w-auto"
        />
      </div>

      <h1 className="text-3xl font-bold text-neutral-900 mb-2 animate-fadeInUp">
        Module {moduleIndex + 1} — Complete
      </h1>
      <p
        className="text-lg text-neutral-600 mb-6 leading-relaxed animate-fadeInUp"
        style={{ animationDelay: "0.1s" }}
      >
        Good work — your {moduleTitle.toLowerCase()} basics are locked in.
      </p>

      {/* Action */}
      <div
        className="flex flex-col items-center gap-3 mb-8 animate-fadeInUp"
        style={{ animationDelay: "0.2s" }}
      >
        {hasNextModule ? (
          <Button size="lg" onClick={onContinue}>
            Begin Module {moduleIndex + 2}
          </Button>
        ) : (
          <Button size="lg" onClick={onBackToModules}>
            View all modules
            <List className="w-5 h-5" />
          </Button>
        )}
      </div>

      {/* Statistics */}
      <div
        className="max-w-md mx-auto text-left animate-fadeInUp"
        style={{ animationDelay: "0.3s" }}
      >
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-surface-muted rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-correct mb-1 tabular-nums">
              {moduleStats.total > 0
                ? Math.round((moduleStats.correct / moduleStats.total) * 100)
                : 100}
              %
            </div>
            <div className="text-xs text-neutral-500">Accuracy</div>
          </div>
          <div className="bg-surface-muted rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-neutral-900 mb-1 tabular-nums">
              {moduleStats.correct}/{moduleStats.total}
            </div>
            <div className="text-xs text-neutral-500">Correct</div>
          </div>
          <div className="bg-surface-muted rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-neutral-900 mb-1 tabular-nums">
              {elapsedMinutes}m
            </div>
            <div className="text-xs text-neutral-500">Time</div>
          </div>
        </div>

        <div className="bg-surface-muted rounded-xl p-4">
          <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">
            Topics covered
          </h3>
          <div className="flex flex-wrap gap-2">
            {successfulLessons.map((lesson, idx) => (
              <span
                key={idx}
                className="inline-flex items-center px-3 py-1.5 bg-white border border-border rounded-full text-xs text-neutral-700"
              >
                {lesson.data.title}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export { ModuleCompleteScreen };
