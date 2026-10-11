"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { Loader } from "@/components/ai-elements/loader";
import { LogoSvg } from "./svg-icons";
import { HeaderActions } from "./header-actions";
import { LandingSteps } from "./landing-steps";
import { Reveal } from "./reveal";
import { Footer } from "./footer";
import { Button } from "./ui/button";
import { buttonVariants } from "./ui/button";
import { Callout } from "./ui/callout";
import { Upload, UploadCloud, Sparkles } from "lucide-react";
import { LearningPathProgress } from "./learning-path-progress";

function LandingScreen() {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      handleFileUpload(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      handleFileUpload(file);
    }
  };

  const processFileUpload = async (file: File) => {
    try {
      setIsProcessing(true);
      setError(null);
      setProgress("Uploading your source…");

      let savedStudy: { sessionId?: string; documents?: Array<Record<string, unknown>>; mode?: string } = {};
      try {
        savedStudy = JSON.parse(localStorage.getItem("eas.study.v2") || "{}");
      } catch {
        savedStudy = {};
      }

      let sessionId = typeof savedStudy.sessionId === "string" ? savedStudy.sessionId : null;
      let reuseSavedDocuments = Boolean(sessionId);
      if (sessionId) {
        try {
          const existing = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { credentials: "same-origin" });
          if (!existing.ok) sessionId = null;
        } catch {
          sessionId = null;
        }
      }
      if (!sessionId) {
        reuseSavedDocuments = false;
        const created = await fetch("/v1/sessions", { method: "POST", credentials: "same-origin" });
        const payload = await created.json().catch(() => ({}));
        if (!created.ok) throw new Error(payload.message || payload.detail?.message || "Could not start a study session.");
        sessionId = payload.session_id;
      }

      const formData = new FormData();
      formData.append("file", file, file.name);
      const uploaded = await fetch("/v1/documents", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: formData,
      });
      const document = await uploaded.json().catch(() => ({}));
      if (!uploaded.ok) throw new Error(document.message || document.detail?.message || "The source could not be uploaded. Please try again.");

      const documents = reuseSavedDocuments && Array.isArray(savedStudy.documents) ? savedStudy.documents : [];
      const nextDocuments = documents.filter((item) => item.document_id !== document.document_id);
      nextDocuments.push({
        document_id: document.document_id,
        filename: document.filename || file.name,
        status: document.status || "UPLOADING",
        job_id: document.job_id || null,
        expected_page_count: document.expected_page_count ?? null,
        processed_page_count: document.processed_page_count || 0,
        failed_page_count: document.failed_page_count || 0,
        completeness_status: document.completeness_status || "pending",
        index_status: document.index_status || "pending",
        warnings: document.warnings || [],
        selected: true,
      });
      localStorage.setItem("eas.study.v2", JSON.stringify({
        sessionId,
        documents: nextDocuments,
        mode: "ADAPTIVE",
        lastView: "learn",
      }));
      window.location.href = "/learn";
    } catch (error) {
      console.error("Failed to upload source to EAS:", error);
      setError(error instanceof Error ? error.message : "Failed to upload your source. Please try again.");
      setIsProcessing(false);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please upload a PDF file");
      return;
    }

    await processFileUpload(file);
  };

  if (isProcessing) return <LearningPathProgress activeStep={0} detail={progress || "Uploading PDF to secure storage"} />;

  return (
    <div className="min-h-screen bg-white relative flex flex-col overflow-x-clip">
      {/* Header */}
      <header className="sticky top-0 z-50 h-16 border-b-[0.5px] border-border bg-white/80 backdrop-blur-sm">
        <div className="h-full max-w-7xl mx-auto px-6 flex items-center justify-between">
          <Link
            href="/"
            aria-label="Go to EAS home page"
            className="flex items-center gap-2.5 text-neutral-950"
          >
            <LogoSvg className="h-6 w-auto" aria-hidden="true" />
            <span className="font-sans text-lg font-bold leading-none tracking-normal whitespace-nowrap">
              EAS
            </span>
          </Link>
          <HeaderActions />
        </div>
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 w-full max-w-7xl mx-auto px-6 pt-16 md:pt-24 pb-8 md:pb-10">
        {/* Hero */}
        <div className="relative">
          {/* Decorative illustrations flanking the hero on large screens */}
          <Image
            src="/landing-left.webp"
            alt=""
            aria-hidden="true"
            width={300}
            height={338}
            priority
            className="rise hidden lg:block absolute left-0 top-10 w-56 xl:w-72 h-auto z-0 pointer-events-none select-none"
            style={{ animationDelay: "0.15s" }}
          />
          <Image
            src="/landing-right.webp"
            alt=""
            aria-hidden="true"
            width={300}
            height={300}
            priority
            className="rise hidden lg:block absolute right-0 top-10 w-56 xl:w-72 h-auto z-0 pointer-events-none select-none"
            style={{ animationDelay: "0.22s" }}
          />

          <div className="relative z-10 text-center max-w-3xl mx-auto">
            <h1
              className="rise font-bold text-neutral-900 leading-[1.05] tracking-[-0.045em] text-balance mb-5 text-[clamp(2.5rem,7vw,4.5rem)]"
              style={{ animationDelay: "0.11s" }}
            >
              Make a tailored course for you
            </h1>
            <p
              className="rise text-lg md:text-xl text-neutral-600 font-medium text-pretty max-w-xl mx-auto mb-10"
              style={{ animationDelay: "0.18s" }}
            >
              Upload any material and turn it into a personalized, interactive course.
            </p>

          {/* Upload card */}
          <div className="rise max-w-2xl mx-auto" style={{ animationDelay: "0.25s" }}>
            <input
              ref={fileInputRef}
              type="file"
              id="file-upload"
              className="hidden"
              accept=".pdf,application/pdf"
              onChange={handleFileSelect}
              disabled={isProcessing}
            />
            <div className="gradient-border p-2 shadow-sm" style={{ borderWidth: "1px" }}>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => !isProcessing && fileInputRef.current?.click()}
                className={`group rounded-[14px] px-8 py-10 md:py-12 min-h-[210px] flex flex-col items-center justify-center text-center transition-colors duration-200 ease-standard ${
                  isDragging ? "bg-surface-subtle" : "bg-white"
                } ${!isProcessing ? "cursor-pointer" : ""}`}
              >
                {isProcessing ? (
                  <div className="flex flex-col items-center text-center">
                    <Loader size={30} className="mb-4 text-neutral-900" />
                    <p className="text-neutral-800 font-medium">{progress}</p>
                    <p className="text-sm text-neutral-500 mt-2">This may take a few minutes…</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center">
                    <div
                      className={`mb-5 flex h-12 w-12 items-center justify-center text-neutral-700 transition-transform duration-300 ease-out-soft ${
                        isDragging ? "scale-110 -translate-y-0.5" : "group-hover:scale-105"
                      }`}
                    >
                      <UploadCloud className="h-8 w-8" />
                    </div>
                    <Button
                      size="lg"
                      onClick={(e) => {
                        e.stopPropagation();
                        fileInputRef.current?.click();
                      }}
                    >
                      Upload a PDF
                    </Button>
                    <p className="mt-4 text-sm text-neutral-500">
                      {isDragging ? "Drop your PDF to begin" : "or drag & drop your file here"}
                    </p>
                    <p className="mt-1 text-xs text-neutral-400">
                      PDF · page limits depend on your EAS deployment
                    </p>
                  </div>
                )}
              </div>
            </div>

            {error && (
              <Callout variant="incorrect" className="mt-6 text-sm text-left">
                {error}
              </Callout>
            )}

            {!isProcessing && (
              <div className="mt-6">
                <Link href="/chat" className={buttonVariants({ variant: "outline" })}>
                  <Sparkles className="w-4 h-4" />
                  Ask a question
                </Link>
              </div>
            )}
          </div>
          </div>
        </div>

        {/* Section 2 — How it works */}
        <LandingSteps />

        {/* Section 3 — CTA */}
        <section>
          <Reveal className="gradient-border max-w-5xl mx-auto p-8 md:p-12">
            <div className="flex flex-col items-center lg:flex-row lg:justify-between gap-8">
              <div className="max-w-xl text-center lg:text-left">
                <span className="text-xs font-semibold uppercase tracking-wider text-hint-fg">
                  Ready when you are
                </span>
                <h2 className="text-[clamp(1.75rem,4vw,2.75rem)] font-bold text-neutral-900 tracking-[-0.04em] text-balance mt-2 mb-3 leading-[1.1]">
                  Turn your next PDF into a course you&rsquo;ll actually finish.
                </h2>
                <p className="text-base text-neutral-600">
                No setup. Keep learning from your own sources.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row lg:flex-col gap-3 lg:flex-shrink-0 w-full sm:w-auto">
                <Button
                  size="lg"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isProcessing}
                  className="w-full sm:w-auto"
                >
                  <Upload className="w-5 h-5" />
                  Upload a PDF
                </Button>
                <Link href="/chat" className={buttonVariants({ variant: "outline", size: "lg", className: "w-full sm:w-auto" })}>
                  <Sparkles className="w-5 h-5" />
                  Ask EAS
                </Link>
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <Footer />
    </div>
  );
}

export { LandingScreen };
