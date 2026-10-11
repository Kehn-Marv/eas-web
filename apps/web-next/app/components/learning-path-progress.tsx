"use client";

import Image from "next/image";
import { Check, LoaderCircle } from "lucide-react";

const steps = ["Uploading", "Reading", "Structuring", "Building lessons", "Ready"];

export function LearningPathProgress({
  activeStep,
  detail,
  pageProgress,
}: {
  activeStep: number;
  detail: string;
  pageProgress?: { processed: number; total: number };
}) {
  const progressText = pageProgress && pageProgress.total > 0
    ? `${detail} · ${Math.min(pageProgress.processed, pageProgress.total)} of ${pageProgress.total} pages`
    : detail;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-white px-6 py-12 text-center" aria-label="Building your learning path">
      <section className="flex w-full max-w-sm flex-col items-center">
        <Image
          src="/creating-guy.webp"
          alt=""
          width={210}
          height={163}
          priority
          className="mb-6 h-auto w-24 select-none"
        />
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-neutral-900">Building your course</h1>
        <p className="mt-1.5 min-h-5 text-sm text-neutral-500" aria-live="polite">{progressText}</p>

        <ol className="mt-8 flex flex-col items-start gap-1" aria-label="Course creation progress">
          {steps.map((label, index) => {
            const complete = index < activeStep;
            const current = index === activeStep;
            return (
              <li key={label} aria-current={current ? "step" : undefined} className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 transition-colors duration-300 ${current ? "bg-surface-muted" : ""}`}>
                {complete ? (
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-correct text-white"><Check className="h-3 w-3" strokeWidth={3} /></span>
                ) : current ? (
                  <LoaderCircle size={20} className="flex-shrink-0 animate-spin text-neutral-900" />
                ) : (
                  <span className="h-5 w-5 flex-shrink-0 rounded-full border-2 border-neutral-200" />
                )}
                <span className={`text-sm ${current ? "font-semibold text-neutral-900" : complete ? "text-neutral-500" : "text-neutral-400"}`}>{label}</span>
              </li>
            );
          })}
        </ol>

        <p className="mt-6 text-xs text-neutral-400">This usually takes 1–2 minutes.</p>
      </section>
    </main>
  );
}
