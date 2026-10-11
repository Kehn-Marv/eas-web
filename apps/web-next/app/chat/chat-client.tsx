"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, FileText, LoaderCircle, Send, Sparkles } from "lucide-react";
import { LogoSvg } from "../components/svg-icons";

type Citation = { document_id: string; page_number: number; quote_or_excerpt: string };
type Turn = { turn_id: string; query: string; text: string; citations: Citation[]; warnings: string[] };
type Message = { id: string; role: "user" | "assistant"; text: string; citations: Citation[]; warning?: string };
type SavedStudy = { sessionId?: string; documents?: Array<{ document_id: string; selected?: boolean; status?: string }>; mode?: string };

const prompts = ["Explain a difficult concept", "Help me understand a process", "How should I study this topic?"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.detail?.message || "EAS could not complete that request.");
  return data as T;
}

export function ChatClient() {
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      setError("EAS is taking too long to open this conversation. Refresh and try again.");
      setLoading(false);
    }, 15000);
    async function initialize() {
      try {
        let saved: SavedStudy = {};
        try { saved = JSON.parse(localStorage.getItem("eas.study.v2") || "{}"); } catch { saved = {}; }
        let id = saved.sessionId || "";
        if (id) {
          try { await api("/v1/sessions/" + encodeURIComponent(id)); }
          catch { id = ""; saved = { mode: "ADAPTIVE", documents: [] }; }
        }
        if (!id) {
          const created = await api<{ session_id: string }>("/v1/sessions", { method: "POST" });
          id = created.session_id;
          localStorage.setItem("eas.study.v2", JSON.stringify({ ...saved, sessionId: id, documents: saved.documents || [], mode: "ADAPTIVE" }));
        }
        const turns = await api<Turn[]>("/v1/sessions/" + encodeURIComponent(id) + "/turns?limit=100");
        if (cancelled) return;
        setSessionId(id);
        setMessages(turns.reverse().flatMap((turn) => [
          { id: turn.turn_id + "-user", role: "user" as const, text: turn.query, citations: [] },
          { id: turn.turn_id, role: "assistant" as const, text: turn.text, citations: turn.citations || [], warning: turn.warnings?.includes("UNSOURCED_GENERAL_RESPONSE") ? "General answer" : undefined },
        ]));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Ask EAS could not be opened.");
      } finally {
        window.clearTimeout(timeout);
        setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, sending]);

  async function sendMessage(value = draft) {
    const query = value.trim();
    if (!query || !sessionId || sending) return;
    setDraft(""); setError(""); setSending(true);
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((items) => [...items,
      { id: userId, role: "user", text: query, citations: [] },
      { id: assistantId, role: "assistant", text: "", citations: [] },
    ]);
    try {
      const saved: SavedStudy = JSON.parse(localStorage.getItem("eas.study.v2") || "{}");
      const documentIds = (saved.documents || [])
        .filter((item) => item.selected !== false && ["READY", "DEGRADED"].includes(item.status || ""))
        .map((item) => item.document_id);
      const response = await fetch("/v1/sessions/" + encodeURIComponent(sessionId) + "/turns", {
        method: "POST", credentials: "same-origin",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ query, document_ids: documentIds, mode: "ADAPTIVE" }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || data.detail?.message || "EAS could not answer that question.");
      }
      if (!response.body) throw new Error("The EAS response stream is unavailable.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", eventName = "", eventData = "", answerText = "";
      let final: Turn | null = null;
      const updateAnswer = (text: string) => setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, text } : item));
      const dispatch = () => {
        if (eventName === "delta" && eventData) {
          try { answerText += (JSON.parse(eventData) as { text: string }).text; updateAnswer(answerText); } catch { /* Ignore malformed progress events. */ }
        } else if (eventName === "replace" && eventData) {
          try { answerText = (JSON.parse(eventData) as { text: string }).text; updateAnswer(answerText); } catch { /* Final event still contains the complete response. */ }
        } else if (eventName === "final" && eventData) final = JSON.parse(eventData) as Turn;
        else if (eventName === "error") throw new Error("EAS could not finish that answer.");
        eventName = ""; eventData = "";
      };
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) dispatch();
          else if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) eventData += (eventData ? "\n" : "") + line.slice(5).trimStart();
          newline = buffer.indexOf("\n");
        }
      }
      dispatch();
      if (!final) throw new Error("EAS ended the response before it was complete.");
      setMessages((items) => items.map((item) => item.id === assistantId ? {
        ...item, text: final!.text, citations: final!.citations || [],
        warning: final!.warnings?.includes("UNSOURCED_GENERAL_RESPONSE") ? "General answer" : undefined,
      } : item));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "EAS could not answer that question.";
      setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, text: message, warning: "Could not complete" } : item));
      setError(message);
    } finally { setSending(false); }
  }

  return <div className="min-h-screen bg-[#fbfbf8] text-neutral-900 flex flex-col">
    <header className="sticky top-0 z-20 border-b border-[#e4e6dc] bg-[#fbfbf8]/90 backdrop-blur">
      <div className="mx-auto flex h-[76px] w-full max-w-6xl items-center justify-between px-5 md:px-8">
        <Link href="/" aria-label="EAS home" className="inline-flex items-center gap-3">
          <LogoSvg className="h-9 w-9 rounded-full bg-[#24634f] p-2" aria-hidden="true" />
          <span className="text-lg font-bold tracking-tight">EAS</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-neutral-500 sm:inline">Ask EAS</span>
          <Link href="/" className="rounded-full border border-[#dfe3d8] bg-white px-4 py-2 text-sm font-medium transition hover:bg-[#f1f3ec]">Upload a source</Link>
        </div>
      </div>
    </header>

    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-8 md:px-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#538270]">A direct conversation</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">Ask EAS</h1>
        <p className="mt-1 text-sm text-neutral-500">No upload required. Add a source anytime for cited answers.</p>
      </div>

      <section aria-label="Conversation" className="flex flex-1 flex-col rounded-3xl border border-[#e4e6dc] bg-white shadow-[0_14px_44px_rgba(35,62,48,0.05)]">
        <div className="flex-1 space-y-6 p-5 md:p-8">
          {loading ? <div className="flex items-center gap-3 py-8 text-sm text-neutral-500"><LoaderCircle className="h-4 w-4 animate-spin" />Opening your conversation</div> : null}
          {!loading && messages.length === 0 ? <div className="mx-auto max-w-xl py-12 text-center md:py-16">
            <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#eaf1eb] text-[#35735d]"><Sparkles className="h-6 w-6" /></span>
            <h2 className="mt-5 text-xl font-semibold tracking-tight">What would you like to understand?</h2>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {prompts.map((prompt) => <button key={prompt} onClick={() => void sendMessage(prompt)} disabled={!sessionId || sending} className="rounded-full border border-[#e1e5dc] bg-[#fbfbf8] px-4 py-2 text-sm text-neutral-700 transition hover:border-[#aabcae] hover:bg-[#f1f3ec] disabled:opacity-50">{prompt}</button>)}
            </div>
            <p className="mt-5 text-xs text-neutral-400">For page citations and lessons, upload your material.</p>
          </div> : null}
          {messages.map((message) => <article key={message.id} className={message.role === "user" ? "ml-auto max-w-[88%]" : "mr-auto max-w-[94%]"}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-400">{message.role === "user" ? "You" : "EAS"}</p>
            <div className={message.role === "user" ? "whitespace-pre-wrap rounded-2xl rounded-tr-md bg-[#24634f] px-4 py-3 text-sm leading-6 text-white" : "whitespace-pre-wrap text-sm leading-7 text-neutral-800"}>
              {message.text || (sending && message.role === "assistant" ? <span className="inline-flex items-center gap-2 text-neutral-400"><LoaderCircle className="h-4 w-4 animate-spin" />Thinking</span> : null)}
            </div>
            {message.role === "assistant" && message.warning === "General answer" ? <p className="mt-2 text-xs text-neutral-400">General answer</p> : null}
            {message.role === "assistant" && message.citations.length > 0 ? <div className="mt-3 flex flex-wrap gap-2">{message.citations.map((citation, index) => <span key={citation.document_id + citation.page_number + index} className="inline-flex items-center gap-1.5 rounded-full border border-[#e2e7df] bg-[#fbfbf8] px-3 py-1 text-xs text-neutral-500"><FileText className="h-3.5 w-3.5" />Page {citation.page_number}</span>)}</div> : null}
          </article>)}
          {error && !messages.length ? <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p> : null}
          <div ref={endRef} />
        </div>

        <form onSubmit={(event) => { event.preventDefault(); void sendMessage(); }} className="border-t border-[#edf0e9] p-4 md:p-5">
          <label htmlFor="eas-message" className="sr-only">Your question</label>
          <textarea id="eas-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask a question…" rows={2} disabled={loading || sending || !sessionId} className="max-h-40 min-h-[56px] w-full resize-y rounded-xl border-0 bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-neutral-400 focus:ring-0 disabled:opacity-60" />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-xs text-neutral-400">{error && messages.length ? error : "Enter to ask · Shift + Enter for a new line"}</p>
            <button type="submit" disabled={!draft.trim() || loading || sending || !sessionId} className="inline-flex h-10 items-center gap-2 rounded-full bg-[#24634f] px-5 text-sm font-medium text-white transition hover:bg-[#1d5342] disabled:cursor-not-allowed disabled:opacity-40"><Send className="h-4 w-4" />Ask</button>
          </div>
        </form>
      </section>
      <p className="mt-4 flex items-center justify-center gap-2 text-center text-xs text-neutral-400"><BookOpen className="h-3.5 w-3.5" />Upload a source whenever you want EAS to ground answers in your material.</p>
    </main>
  </div>;
}
