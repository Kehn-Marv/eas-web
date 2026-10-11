"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Check, Copy, Globe2, LockKeyhole, LoaderCircle, Trash2, Upload } from "lucide-react";
import { Header } from "../components/header";
import { Footer } from "../components/footer";
import { Button } from "../components/ui/button";

type SavedCourse = { course_id: string; title: string; source_titles: string[]; is_public: boolean; current_module_index: number; current_lesson_index: number; current_step: string; completed_count: number; total_lessons: number; progress_percent: number; modules: Array<{ title: string; lessons: Array<{ data: { id?: string } }> }> };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail?.message || data.message || "EAS could not complete that request.");
  return data as T;
}

function resumeHref(course: SavedCourse) {
  const params = new URLSearchParams({ courseId: course.course_id });
  if (course.current_step && course.current_step !== "overview") {
    params.set("moduleIndex", String(course.current_module_index));
    params.set("lessonIndex", String(course.current_lesson_index));
    params.set("step", course.current_step);
  }
  return "/learn?" + params.toString();
}

export function CoursesClient() {
  const [courses, setCourses] = useState<SavedCourse[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState("");

  async function refresh() {
    setBusy(true); setError("");
    try { const result = await api<{ courses: SavedCourse[] }>("/v1/courses"); setCourses(result.courses); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Your courses could not be loaded."); }
    finally { setBusy(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function toggleShare(course: SavedCourse) {
    setSharing(course.course_id); setNotice("");
    try {
      const result = await api<{ is_public: boolean; share_path: string | null }>("/v1/courses/" + encodeURIComponent(course.course_id) + "/share", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_public: !course.is_public }) });
      setCourses((items) => items.map((item) => item.course_id === course.course_id ? { ...item, is_public: result.is_public } : item));
      if (result.share_path) {
        await navigator.clipboard.writeText(window.location.origin + result.share_path);
        setNotice("Public link copied. Anyone with it can view this course.");
      } else setNotice("Sharing is off. The old link no longer opens the course.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "Sharing could not be updated."); }
    finally { setSharing(""); }
  }

  async function copyLink(course: SavedCourse) {
    setSharing(course.course_id); setNotice("");
    try {
      const result = await api<{ share_path: string | null }>("/v1/courses/" + encodeURIComponent(course.course_id) + "/share", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_public: true }) });
      if (!result.share_path) throw new Error("A public link could not be created.");
      await navigator.clipboard.writeText(window.location.origin + result.share_path);
      setCourses((items) => items.map((item) => item.course_id === course.course_id ? { ...item, is_public: true } : item));
      setNotice("Public link copied. Anyone with it can view this course.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "The link could not be copied."); }
    finally { setSharing(""); }
  }

  async function remove(course: SavedCourse) {
    if (!window.confirm(`Delete “${course.title}” and its saved learning progress?`)) return;
    setSharing(course.course_id); setNotice("");
    try {
      const response = await fetch("/v1/courses/" + encodeURIComponent(course.course_id), { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.detail?.message || "The course could not be deleted."); }
      setCourses((items) => items.filter((item) => item.course_id !== course.course_id));
      setNotice("Course deleted.");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "The course could not be deleted."); }
    finally { setSharing(""); }
  }

  return <div className="min-h-screen bg-white flex flex-col"><Header />
    <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-12 md:py-16">
      <div className="mb-10 flex flex-wrap items-end justify-between gap-6"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Your library</p><h1 className="mt-3 text-4xl font-semibold tracking-tight text-neutral-950 sm:text-5xl">Courses</h1><p className="mt-3 text-neutral-600">Pick up where you left off.</p></div><Link href="/" className="inline-flex h-11 items-center gap-2 rounded-full bg-neutral-950 px-5 text-sm font-medium text-white transition hover:bg-neutral-800"><Upload className="h-4 w-4" />Upload another</Link></div>
      {notice && <p role="status" className="mb-6 rounded-xl border border-border bg-surface-subtle px-4 py-3 text-sm text-neutral-700">{notice}</p>}
      {busy ? <div className="flex items-center justify-center gap-3 py-24 text-neutral-500"><LoaderCircle className="h-5 w-5 animate-spin" />Loading saved courses</div> : error ? <div className="rounded-2xl border border-border p-8 text-center"><p className="text-neutral-700">{error}</p><Button variant="outline" className="mt-5" onClick={() => void refresh()}>Try again</Button></div> : courses.length === 0 ? <div className="rounded-3xl border border-dashed border-neutral-300 bg-neutral-50/50 px-6 py-20 text-center"><span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white shadow-sm"><BookOpen className="h-6 w-6 text-neutral-700" /></span><h2 className="mt-5 text-xl font-semibold text-neutral-950">Your courses will be here</h2><p className="mt-2 text-sm text-neutral-600">Upload a source to make your first learning path.</p><Link href="/" className="mt-6 inline-flex h-11 items-center rounded-full bg-neutral-950 px-5 text-sm font-medium text-white">Upload a source</Link></div> : <div className="grid gap-5 md:grid-cols-2">{courses.map((course) => <article key={course.course_id} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition hover:shadow-md"><div className="p-6"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 className="line-clamp-2 text-xl font-semibold text-neutral-950">{course.title}</h2><p className="mt-2 truncate text-sm text-neutral-500">{course.source_titles.join(" · ")}</p></div><span className="shrink-0 rounded-full border border-neutral-200 p-2 text-neutral-500" title={course.is_public ? "Public link enabled" : "Private course"}>{course.is_public ? <Globe2 className="h-4 w-4" /> : <LockKeyhole className="h-4 w-4" />}</span></div><div className="mt-6"><div className="mb-2 flex justify-between text-xs text-neutral-500"><span>{course.completed_count} of {course.total_lessons} lessons</span><span>{course.progress_percent}%</span></div><div className="h-2 overflow-hidden rounded-full bg-neutral-100"><div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${course.progress_percent}%` }} /></div></div><div className="mt-5 flex items-center gap-2 text-xs text-neutral-500"><span>{course.modules.length} modules</span><span aria-hidden="true">·</span><span>{course.total_lessons} lessons</span>{course.progress_percent === 100 && <span className="ml-auto inline-flex items-center gap-1 text-emerald-700"><Check className="h-3.5 w-3.5" />Complete</span>}</div><div className="mt-6 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-5"><Link href={resumeHref(course)} className="inline-flex h-10 flex-1 items-center justify-center rounded-full bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800">{course.progress_percent === 100 ? "Revisit course" : course.completed_count ? "Resume course" : "Start learning"}</Link><button type="button" onClick={() => void toggleShare(course)} disabled={sharing === course.course_id} className="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-200 px-4 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50">{course.is_public ? <LockKeyhole className="h-4 w-4" /> : <Globe2 className="h-4 w-4" />}{course.is_public ? "Make private" : "Share"}</button>{course.is_public && <button type="button" onClick={() => void copyLink(course)} disabled={sharing === course.course_id} aria-label="Copy public course link" className="grid h-10 w-10 place-items-center rounded-full border border-neutral-200 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"><Copy className="h-4 w-4" /></button>}<button type="button" onClick={() => void remove(course)} disabled={sharing === course.course_id} aria-label="Delete course" className="grid h-10 w-10 place-items-center rounded-full border border-neutral-200 text-neutral-500 hover:border-red-200 hover:text-red-700 disabled:opacity-50"><Trash2 className="h-4 w-4" /></button></div></div></article>)}</div>}
    </main><Footer /></div>;
}
