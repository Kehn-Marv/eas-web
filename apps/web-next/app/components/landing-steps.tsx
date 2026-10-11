"use client";

import { BookOpen, HelpCircle, Workflow, Check } from "lucide-react";
import { Reveal } from "./reveal";

/**
 * "How it works" — three equal-size step cards with self-contained
 * illustrations that "play" on hover (and show their resolved state on touch /
 * small screens). All motion is opacity / scale / translate / stroke only, and
 * the global reduced-motion rule snaps everything instantly.
 */

function StepCard({
  index,
  title,
  description,
  children,
}: {
  index: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group card-hover h-full rounded-2xl border border-border bg-white p-6 flex flex-col">
      {/* Fixed-height stage keeps every card's title + subhead on the same line */}
      <div className="relative w-full h-40 mb-6 rounded-xl bg-gradient-to-b from-surface-subtle to-white border border-border/60 overflow-hidden flex items-center justify-center">
        {children}
      </div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-base font-bold text-neutral-400 tabular-nums">{index}</span>
        <h3 className="text-lg font-bold text-neutral-900">{title}</h3>
      </div>
      <p className="text-sm text-neutral-500">{description}</p>
    </div>
  );
}

/* 1 — a PDF file drops into a dashed tray */
function UploadScene() {
  return (
    <>
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-28 h-16 rounded-xl border-2 border-dashed border-border-strong transition-colors duration-300 ease-standard group-hover:border-brand-1 max-md:border-brand-1" />
      <div className="absolute left-1/2 top-5 -translate-x-1/2 transition-transform duration-500 ease-out-soft group-hover:translate-y-6 max-md:translate-y-6">
        <div className="w-16 rounded-lg bg-white border border-border shadow-sm p-2 transition-shadow duration-300 group-hover:shadow-md max-md:shadow-md">
          <span className="inline-block text-[8px] font-bold text-incorrect bg-incorrect-bg rounded px-1 py-0.5 mb-1.5">
            PDF
          </span>
          <div className="h-1 w-full rounded-full bg-neutral-200 mb-1" />
          <div className="h-1 w-3/4 rounded-full bg-neutral-100" />
        </div>
      </div>
    </>
  );
}

/* 2 — one document splits into typed outputs */
function BreakdownScene() {
  return (
    <div className="relative w-full h-full flex flex-col items-center justify-between px-5 py-4">
      <div className="relative z-10 w-12 rounded-md bg-white border border-border shadow-sm p-1.5">
        <div className="h-1 w-3/4 rounded-full bg-neutral-200 mb-1" />
        <div className="h-1 w-full rounded-full bg-neutral-100 mb-1" />
        <div className="h-1 w-2/3 rounded-full bg-neutral-100" />
      </div>

      <svg
        className="absolute inset-x-5 inset-y-0"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {[18, 50, 82].map((x, i) => (
          <path
            key={x}
            d={`M 50 30 C 50 50, ${x} 50, ${x} 64`}
            fill="none"
            stroke="var(--color-border-strong)"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1}
            className={`transition-[stroke-dashoffset] duration-500 ease-standard group-hover:[stroke-dashoffset:0] max-md:[stroke-dashoffset:0] ${
              i === 0 ? "delay-0" : i === 1 ? "delay-100" : "delay-200"
            }`}
          />
        ))}
      </svg>

      <div className="relative z-10 flex items-end justify-between gap-1.5 w-full">
        {[
          { icon: BookOpen, label: "Lessons", d: "delay-0" },
          { icon: HelpCircle, label: "Quizzes", d: "delay-100" },
          { icon: Workflow, label: "Diagrams", d: "delay-200" },
        ].map(({ icon: Icon, label, d }) => (
          <div
            key={label}
            className={`flex flex-col items-center gap-1 flex-1 rounded-lg border border-border bg-white px-1 py-1.5 shadow-sm opacity-0 translate-y-1.5 group-hover:opacity-100 group-hover:translate-y-0 max-md:opacity-100 max-md:translate-y-0 transition-[opacity,transform] duration-300 ease-out-soft ${d}`}
          >
            <Icon className="w-3.5 h-3.5 text-neutral-500" />
            <span className="text-[9px] font-medium text-neutral-600">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* 3 — answer a question, lock in the right choice */
function LearnScene() {
  const options = ["A", "B", "C", "D"];
  return (
    <div className="w-[78%]">
      <div className="h-1.5 w-2/3 rounded-full bg-neutral-200 mb-2.5" />
      <div className="flex flex-col gap-1.5">
        {options.map((opt) => {
          const correct = opt === "B";
          return (
            <div
              key={opt}
              className={`flex items-center gap-2 rounded-md border px-2 py-1 transition-colors duration-300 ease-standard ${
                correct
                  ? "border-border bg-white group-hover:border-correct-border group-hover:bg-correct-bg max-md:border-correct-border max-md:bg-correct-bg"
                  : "border-border bg-white"
              }`}
            >
              <span
                className={`flex items-center justify-center w-3.5 h-3.5 rounded-full text-[8px] font-bold ${
                  correct
                    ? "bg-neutral-100 text-neutral-500 group-hover:bg-correct group-hover:text-white max-md:bg-correct max-md:text-white transition-colors duration-300"
                    : "bg-neutral-100 text-neutral-400"
                }`}
              >
                {correct ? (
                  <>
                    <Check className="w-2 h-2 hidden group-hover:block max-md:block" />
                    <span className="group-hover:hidden max-md:hidden">{opt}</span>
                  </>
                ) : (
                  opt
                )}
              </span>
              <div className="h-1.5 flex-1 rounded-full bg-neutral-100" />
            </div>
          );
        })}
      </div>
      <div className="mt-2.5 h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
        <div className="h-full w-1/4 rounded-full bg-correct group-hover:w-full max-md:w-full transition-[width] duration-500 ease-out-soft" />
      </div>
    </div>
  );
}

export function LandingSteps() {
  return (
    <section className="mt-28 mb-20">
      <Reveal className="text-center mb-12">
        <span className="inline-block px-3 py-1 text-xs font-semibold uppercase tracking-wider text-hint-fg bg-hint-bg rounded-full mb-5">
          How it works
        </span>
        <h2 className="text-3xl md:text-4xl font-bold text-neutral-900 tracking-[-0.03em] text-balance max-w-2xl mx-auto">
          From static PDF to guided learning, in minutes
        </h2>
      </Reveal>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        <Reveal className="h-full">
          <StepCard index="1" title="Upload a PDF" description="Lecture notes, textbooks, papers, or docs.">
            <UploadScene />
          </StepCard>
        </Reveal>
        <Reveal className="h-full" delay={90}>
          <StepCard index="2" title="We break it down" description="Split into short modules — lessons, quizzes, and diagrams.">
            <BreakdownScene />
          </StepCard>
        </Reveal>
        <Reveal className="h-full" delay={180}>
          <StepCard index="3" title="Learn by doing" description="Answer questions, get feedback, and track progress.">
            <LearnScene />
          </StepCard>
        </Reveal>
      </div>
    </section>
  );
}
