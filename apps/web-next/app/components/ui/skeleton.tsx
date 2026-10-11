import * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-neutral-200/70 rounded-md animate-pulse motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  );
}

export function CourseCardSkeleton() {
  return (
    <div className="relative p-6 rounded-2xl border-[0.5px] border-border bg-white">
      <Skeleton className="h-6 w-2/3 mb-4" />
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-8" />
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </div>
      <Skeleton className="h-3 w-28 mt-3" />
    </div>
  );
}

export function CourseGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {Array.from({ length: count }).map((_, i) => (
        <CourseCardSkeleton key={i} />
      ))}
    </div>
  );
}

export function ModuleListSkeleton() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:gap-16">
          <div className="flex flex-col justify-center lg:pr-16">
            <Skeleton className="h-12 w-3/4 mb-6" />
            <Skeleton className="h-5 w-full mb-2" />
            <Skeleton className="h-5 w-5/6 mb-12" />
            <Skeleton className="h-14 w-full max-w-sm rounded-full mb-4" />
            <Skeleton className="h-14 w-full max-w-sm rounded-full" />
          </div>
          <div className="space-y-4 mt-12 lg:mt-0">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="p-6 rounded-2xl border border-border bg-surface-muted"
              >
                <div className="flex items-start gap-4">
                  <Skeleton className="h-6 w-6 rounded-md" />
                  <div className="flex-1">
                    <Skeleton className="h-5 w-1/2 mb-2" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LessonSkeleton() {
  return (
    <div className="space-y-8">
      <Skeleton className="h-8 w-3/4" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-4/6" />
      </div>
      <Skeleton className="h-24 w-full rounded-2xl" />
      <div className="space-y-3 pt-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-12 w-40 rounded-full" />
    </div>
  );
}
