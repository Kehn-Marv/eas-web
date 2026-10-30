"use client";

/**
 * StandaloneComposer — the main chat composer, wired up for a surface that
 * is not the main chat page.
 *
 * ``ChatComposer`` is deliberately stateless: the chat page owns every one
 * of its ~70 props. That is right for the page, but it means any *other*
 * surface that wants the same composer has to reproduce the whole state
 * pool — attachments, drag-and-drop, paste, the six reference pickers, the
 * KB and LLM lists, the menu click-outside handlers. This component owns
 * that pool once, mounts the pickers, and hands the caller a single
 * ``onSubmit`` carrying everything the user attached.
 *
 * The caller supplies only what is specific to its surface: which
 * capability is active, whether a turn is streaming, and where a send
 * should go.
 */

import { ResourceReuseContext, useResourceReusePolicy } from "./ResourceReuse";
import { retainedKnowledgeBases } from "@/lib/resource-reuse";
import { knowledgeBaseRef } from "@/lib/knowledge-helpers";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";

import ChatComposer from "@/components/chat/home/ChatComposer";
import type { ContextBudget } from "@/components/chat/home/ContextBudgetChip";
import type { ResourceSelection } from "@/features/chat/ChatStateAdapter";
import type { CapabilityDef } from "@/features/capabilities/presentation";
import type { ComposerResourceCatalog } from "@/hooks/useComposerResources";
import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SpaceMemoryFile } from "@/lib/space-items";
import { useAttachmentLimits } from "@/lib/attachment-limits";
import {
  extractBase64FromDataUrl,
  readFileAsDataUrl,
} from "@/lib/file-attachments";
import {
  fileToPendingAttachment,
  selectAttachmentFiles,
  type PendingAttachment,
} from "@/features/chat/controllers/pending-attachments";
import {
  listKnowledgeBases,
  type KnowledgeBaseSummary,
} from "@/features/knowledge/api/catalog";
import { listLLMOptions, type LLMOption } from "@/lib/llm-options";
import type { SelectedRecord } from "@/lib/notebook-selection-types";
import type { LLMSelection } from "@/features/chat/model/protocol";
import {
  DEFAULT_QUIZ_CONFIG,
  buildQuizWSConfig,
  type DeepQuestionFormConfig,
} from "@/lib/quiz-types";
import {
  DEFAULT_VISUALIZE_CONFIG,
  buildVisualizeWSConfig,
  type VisualizeFormConfig,
} from "@/lib/visualize-types";
import {
  buildResearchWSConfig,
  createEmptyResearchConfig,
  validateResearchConfig,
  type DeepResearchFormConfig,
} from "@/lib/research-types";
import { workspaceActionNeedsConfiguration } from "@/lib/workspace-mode";

const NotebookRecordPicker = dynamic(
  () => import("@/components/notebook/NotebookRecordPicker"),
  { ssr: false },
);
const HistorySessionPicker = dynamic(
  () => import("@/components/chat/HistorySessionPicker"),
  { ssr: false },
);
const QuestionBankPicker = dynamic(
  () => import("@/components/chat/QuestionBankPicker"),
  { ssr: false },
);
const PersonaPicker = dynamic(() => import("@/components/chat/PersonaPicker"), {
  ssr: false,
});
const CapabilityConfigCard = dynamic(
  () => import("@/components/chat/home/CapabilityConfigCard"),
  { ssr: false },
);
const QuizConfigPanel = dynamic(
  () => import("@/components/quiz/QuizConfigPanel"),
  { ssr: false },
);
const VisualizeConfigPanel = dynamic(
  () => import("@/components/visualize/VisualizeConfigPanel"),
  { ssr: false },
);
const ResearchConfigPanel = dynamic(
  () => import("@/components/research/ResearchConfigPanel"),
  { ssr: false },
);

/** Everything the user attached to this send, already in wire shape. */
export interface StandaloneComposerSubmission {
  content: string;
  /** Configuration for Quiz, Visualize, or Research. */
  config?: Record<string, unknown>;
  attachments: Array<{
    type: string;
    filename?: string;
    base64?: string;
    mime_type?: string;
  }>;
  knowledgeBases: string[];
  notebookReferences: Array<{ notebook_id: string; record_ids: string[] }>;
  historyReferences: string[];
  questionNotebookReferences: number[];
  memoryReferences: SpaceMemoryFile[];
  persona: string | null;
  llmSelection: LLMSelection | null;
}

/** Single-entry capability list for surfaces locked to plain chat. */
const CHAT_ONLY_CAPABILITY = {
  value: "",
  label: "Chat",
  description: "Flexible conversation with any tool",
  icon: MessageSquare,
  allowedTools: [],
} satisfies CapabilityDef;

interface StandaloneComposerProps {
  /** Route a send. The composer clears its own transient selections after. */
  onSubmit: (submission: StandaloneComposerSubmission) => void;
  onCancelStreaming: () => void;
  isStreaming: boolean;
  /** Drives the composer's empty-state → conversation layout transition. */
  hasMessages: boolean;
  /** The live turn is paused on an ask_user card and needs an answer. */
  awaitingUserReply?: boolean;
  inputPlaceholder?: string;
  /** A line Tab accepts while the composer is empty. See ComposerInput. */
  inputPlaceholderCompletion?: string;
  /** Context shown inside the box above the text. See ChatComposer. */
  inputHeader?: React.ReactNode;
  /**
   * Capability chip contents. Defaults to a locked "Chat" entry — pass a
   * one-entry list to relabel it, or several to make the chip a picker.
   */
  capabilities?: CapabilityDef[];
  activeCapValue?: string;
  onSelectCapability?: (value: string) => void;
  /** Drop the capability chip — for a surface that names its mode elsewhere. */
  showCapabilityChip?: boolean;
  /**
   * Knowledge-base scope and pinned model are session-level state on some
   * surfaces (mastery study) and composer-local on others (quiz follow-up).
   * Passing a value makes that control controlled; omitting it leaves the
   * composer owning it.
   */
  selectedKnowledgeBases?: string[];
  onKnowledgeBasesChange?: (names: string[]) => void;
  llmSelection?: LLMSelection | null;
  onLLMSelectionChange?: (selection: LLMSelection | null) => void;
  /**
   * The persona pinned for this conversation. Session-level like the KB scope
   * above: passing the pair mounts the toolbar's persona chip (and with it the
   * `/persona` slash command), omitting it leaves persona as the one-shot the
   * "+" menu offers. `ChatComposer` gates the chip on the setter's presence.
   */
  personaSelection?: string;
  onPersonaSelectionChange?: (persona: string) => void;
  /**
   * Which of the workspace's skills this conversation narrows
   * itself to, and what there is to narrow. Session-level like the persona
   * above: pass the catalog and selection and the "+" menu grows the Skills entry,
   * omit it and the conversation keeps inheriting its workspace untouched.
   * `ChatComposer` needs both halves — it hides an entry whose catalog is
   * empty — which is why a surface that passed neither showed no picker at all
   * while the chat page showed one for the same account (#1534).
   */
  resourceCatalog?: ComposerResourceCatalog;
  resourceSelection?: ResourceSelection;
  onResourceSelectionChange?: (selection: ResourceSelection) => void;
  /** Receives a function that drops text into the textarea (ask_user chips). */
  prefillInputRef?: React.MutableRefObject<((text: string) => void) | null>;
  /**
   * How full the model's context window was at the end of the last measured
   * turn. Omitted, the chip does not render — which is also what happens on a
   * transcript no backend has measured.
   */
  contextBudget?: ContextBudget | null;
}

function StandaloneComposerImpl({
  onSubmit,
  onCancelStreaming,
  isStreaming,
  hasMessages,
  awaitingUserReply = false,
  inputPlaceholder,
  inputPlaceholderCompletion,
  inputHeader,
  capabilities,
  activeCapValue,
  onSelectCapability,
  showCapabilityChip = true,
  selectedKnowledgeBases: controlledKnowledgeBases,
  onKnowledgeBasesChange,
  llmSelection: controlledLLMSelection,
  onLLMSelectionChange,
  personaSelection,
  onPersonaSelectionChange,
  resourceCatalog,
  resourceSelection,
  onResourceSelectionChange,
  prefillInputRef,
  contextBudget = null,
}: StandaloneComposerProps) {
  const { t } = useTranslation();

  // ── Composer DOM refs ─────────────────────────────────────────
  const composerRef = useRef<HTMLDivElement>(null);
  const capMenuRef = useRef<HTMLDivElement>(null);
  const capBtnRef = useRef<HTMLButtonElement>(null);
  const spaceMenuRef = useRef<HTMLDivElement>(null);
  const spaceBtnRef = useRef<HTMLButtonElement>(null);
  const dragCounter = useRef(0);

  // ── Composer local state ──────────────────────────────────────
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentLimits = useAttachmentLimits();
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const attachmentErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const [capMenuOpen, setCapMenuOpen] = useState(false);
  const resourceReuse = useResourceReusePolicy("standalone");
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [quizConfig, setQuizConfig] = useState<DeepQuestionFormConfig>({
    ...DEFAULT_QUIZ_CONFIG,
  });
  const [quizPdf, setQuizPdf] = useState<File | null>(null);
  const [visualizeConfig, setVisualizeConfig] = useState<VisualizeFormConfig>({
    ...DEFAULT_VISUALIZE_CONFIG,
  });
  const [researchConfig, setResearchConfig] = useState<DeepResearchFormConfig>(
    createEmptyResearchConfig(),
  );
  const [capabilityConfigConfirmed, setCapabilityConfigConfirmed] =
    useState(false);

  const [ownKnowledgeBases, setOwnKnowledgeBases] = useState<string[]>([]);
  const selectedKnowledgeBases = controlledKnowledgeBases ?? ownKnowledgeBases;
  const [selectedNotebookRecords, setSelectedNotebookRecords] = useState<
    SelectedRecord[]
  >([]);
  const [selectedHistorySessions, setSelectedHistorySessions] = useState<
    SelectedHistorySession[]
  >([]);
  const [selectedQuestionEntries, setSelectedQuestionEntries] = useState<
    SelectedQuestionEntry[]
  >([]);
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);

  // ── Picker dialog visibility ──────────────────────────────────
  const [showNotebookPicker, setShowNotebookPicker] = useState(false);
    const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showQuestionBankPicker, setShowQuestionBankPicker] = useState(false);
  const [showPersonaPicker, setShowPersonaPicker] = useState(false);
  // Chrome for the toolbar's persona chip. Local even when the value itself is
  // the caller's: whether a dropdown is open is nobody else's business.
  const [personaSelectorOpen, setPersonaSelectorOpen] = useState(false);

  // ── Shared data (KBs + LLMs) ──────────────────────────────────
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>(
    [],
  );
  const [llmOptions, setLLMOptions] = useState<LLMOption[]>([]);
  const [activeLLMDefault, setActiveLLMDefault] = useState<LLMSelection | null>(
    null,
  );
  const [ownLLMSelection, setOwnLLMSelection] = useState<LLMSelection | null>(
    null,
  );
  const llmSelection = controlledLLMSelection ?? ownLLMSelection;
  const [llmOptionsLoading, setLLMOptionsLoading] = useState(true);
  const [llmOptionsError, setLLMOptionsError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const list = await listKnowledgeBases({ force: false });
        if (!cancelled) setKnowledgeBases(list);
      } catch {
        if (!cancelled) setKnowledgeBases([]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Connected subagents arrive as `type: subagent` knowledge bases and travel
  // the same request path, but they are a different question — "who else
  // should EAS ask" rather than "what should it read" — so they get
  // their own chip and never appear in the knowledge picker.
  const agentNameSet = useMemo(
    () =>
      new Set(
        knowledgeBases
          .filter((kb) => kb.metadata?.type === "subagent")
          .map((kb) => kb.name),
      ),
    [knowledgeBases],
  );
  const kbOptions = useMemo(
    () => knowledgeBases.filter((kb) => kb.metadata?.type !== "subagent"),
    [knowledgeBases],
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLLMOptionsLoading(true);
      try {
        const payload = await listLLMOptions();
        if (cancelled) return;
        setLLMOptions(payload.options);
        setActiveLLMDefault(payload.active);
        setLLMOptionsError(false);
      } catch {
        if (cancelled) return;
        setLLMOptionsError(true);
        setLLMOptions([]);
        setActiveLLMDefault(null);
      } finally {
        if (!cancelled) setLLMOptionsLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  // Default to the server-side active LLM until the user picks one. A
  // controlled surface owns that decision itself.
  useEffect(() => {
    if (controlledLLMSelection !== undefined) return;
    if (ownLLMSelection || !activeLLMDefault) return;
    setOwnLLMSelection(activeLLMDefault);
  }, [activeLLMDefault, controlledLLMSelection, ownLLMSelection]);

  const applyLLMSelection = useCallback(
    (selection: LLMSelection | null) => {
      if (controlledLLMSelection === undefined) setOwnLLMSelection(selection);
      onLLMSelectionChange?.(selection);
    },
    [controlledLLMSelection, onLLMSelectionChange],
  );

  const applyKnowledgeBases = useCallback(
    (names: string[]) => {
      if (controlledKnowledgeBases === undefined) setOwnKnowledgeBases(names);
      onKnowledgeBasesChange?.(names);
    },
    [controlledKnowledgeBases, onKnowledgeBasesChange],
  );

  // Click-outside handlers for menu chrome (cap / space).
  useEffect(() => {
    if (!capMenuOpen && !spaceMenuOpen) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (
        capMenuOpen &&
        capMenuRef.current &&
        !capMenuRef.current.contains(target) &&
        capBtnRef.current &&
        !capBtnRef.current.contains(target)
      ) {
        setCapMenuOpen(false);
      }
      if (
        spaceMenuOpen &&
        spaceMenuRef.current &&
        !spaceMenuRef.current.contains(target) &&
        spaceBtnRef.current &&
        !spaceBtnRef.current.contains(target)
      ) {
        setSpaceMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [capMenuOpen, spaceMenuOpen]);

  // ── Attachment helpers ────────────────────────────────────────
  const showAttachmentError = useCallback((message: string) => {
    setAttachmentError(message);
    if (attachmentErrorTimer.current) {
      clearTimeout(attachmentErrorTimer.current);
    }
    attachmentErrorTimer.current = setTimeout(() => {
      setAttachmentError(null);
      attachmentErrorTimer.current = null;
    }, 4000);
  }, []);

  const fileToAttachment = fileToPendingAttachment;

  const filterAndReportFiles = useCallback(
    (files: File[]): File[] => {
      const { accepted, rejected } = selectAttachmentFiles(
        files,
        attachments.reduce((total, item) => total + (item.size ?? 0), 0),
        attachmentLimits,
      );
      if (rejected.length) {
        const first = rejected[0];
        let msg: string;
        if (first.reason === "too_large") {
          msg = t("File too large: {{name}}", { name: first.name });
        } else if (first.reason === "quota") {
          msg = t("Too many files, skipped some");
        } else {
          msg = t("Unsupported file type: {{name}}", { name: first.name });
        }
        showAttachmentError(msg);
      }
      return accepted;
    },
    [attachments, attachmentLimits, showAttachmentError, t],
  );

  const handleAddFiles = useCallback(
    async (files: File[]) => {
      const accepted = filterAndReportFiles(files);
      if (!accepted.length) return;
      const next = await Promise.all(accepted.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...next]);
    },
    [fileToAttachment, filterAndReportFiles],
  );

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent) => {
      const items = Array.from(event.clipboardData.items);
      const files = items
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      const accepted = filterAndReportFiles(files);
      if (!accepted.length) return;
      event.preventDefault();
      const next = await Promise.all(accepted.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...next]);
    },
    [fileToAttachment, filterAndReportFiles],
  );

  // ── Drag-and-drop on the composer surface ─────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragging(true);
  }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  }, []);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setDragging(false);
      await handleAddFiles(Array.from(e.dataTransfer.files));
    },
    [handleAddFiles],
  );

  // ── Picker handlers ───────────────────────────────────────────
  // PageIndex-OSS bases are mutually exclusive — the engine answers from one
  // index at a time, so picking a second silently dropped the first.
  const handleToggleKB = useCallback(
    (name: string) => {
      const providerOf = (kbName: string) => {
        const kb = knowledgeBases.find((item) => knowledgeBaseRef(item) === kbName);
        return (
          (kb?.metadata?.rag_provider as string | undefined) ||
          (kb?.statistics?.rag_provider as string | undefined) ||
          ""
        );
      };
      if (selectedKnowledgeBases.includes(name)) {
        applyKnowledgeBases(selectedKnowledgeBases.filter((kb) => kb !== name));
        return;
      }
      const kept =
        providerOf(name) === "pageindex-oss"
          ? selectedKnowledgeBases.filter(
              (kb) => providerOf(kb) !== "pageindex-oss",
            )
          : selectedKnowledgeBases;
      applyKnowledgeBases([...kept, name]);
    },
    [applyKnowledgeBases, knowledgeBases, selectedKnowledgeBases],
  );

  const selectedKbOnly = useMemo(
    () => selectedKnowledgeBases.filter((name) => !agentNameSet.has(name)),
    [agentNameSet, selectedKnowledgeBases],
  );
  useEffect(() => {
    if (selectedKbOnly.length !== selectedKnowledgeBases.length) {
      applyKnowledgeBases(selectedKbOnly);
    }
  }, [applyKnowledgeBases, selectedKbOnly, selectedKnowledgeBases.length]);
  const handleClearPersona = useCallback(() => setSelectedPersona(null), []);
  const handleRemoveHistory = useCallback((sessionId: string) => {
    setSelectedHistorySessions((prev) =>
      prev.filter((s) => s.sessionId !== sessionId),
    );
  }, []);
  const handleRemoveNotebook = useCallback((notebookId: string) => {
    setSelectedNotebookRecords((prev) =>
      prev.filter((r) => r.notebookId !== notebookId),
    );
  }, []);
  const handleRemoveQuestion = useCallback((entryId: number) => {
    setSelectedQuestionEntries((prev) => prev.filter((e) => e.id !== entryId));
  }, []);

  // ── References payloads ───────────────────────────────────────
  const notebookReferencesPayload = useMemo(() => {
    const grouped = new Map<string, string[]>();
    selectedNotebookRecords.forEach((record) => {
      const current = grouped.get(record.notebookId) || [];
      current.push(record.id);
      grouped.set(record.notebookId, current);
    });
    return Array.from(grouped.entries()).map(([notebook_id, record_ids]) => ({
      notebook_id,
      record_ids,
    }));
  }, [selectedNotebookRecords]);

  const notebookReferenceGroups = useMemo(
    () =>
      notebookReferencesPayload.map((ref) => {
        const sample = selectedNotebookRecords.find(
          (r) => r.notebookId === ref.notebook_id,
        );
        return {
          notebookId: ref.notebook_id,
          notebookName: sample?.notebookName ?? ref.notebook_id,
          count: ref.record_ids.length,
        };
      }),
    [notebookReferencesPayload, selectedNotebookRecords],
  );

  const resolvedCapabilities = useMemo(() => {
    const list = capabilities?.length ? capabilities : [CHAT_ONLY_CAPABILITY];
    return list.map((capability) => ({
      ...capability,
      label: t(capability.label),
      description: t(capability.description),
    }));
  }, [capabilities, t]);
  const activeCap =
    resolvedCapabilities.find(
      (capability) => capability.value === activeCapValue,
    ) ?? resolvedCapabilities[0];
  const isQuizMode = activeCap.value === "deep_question";
  const isVisualizeMode = activeCap.value === "visualize";
  const isResearchMode = activeCap.value === "deep_research";
  const capabilityNeedsConfig = workspaceActionNeedsConfiguration(
    activeCap.value,
  );
  const researchValidation = useMemo(
    () => validateResearchConfig(researchConfig),
    [researchConfig],
  );
  const quizValidationErrors =
    quizConfig.mode === "mimic" && !quizPdf
      ? [t("Upload a PDF to mimic its question style.")]
      : [];

  const selectCapability = useCallback(
    (value: string) => {
      setCapabilityConfigConfirmed(false);
      setCapMenuOpen(false);
      onSelectCapability?.(value);
    },
    [onSelectCapability],
  );

  const handleSend = useCallback(
    async (content: string) => {
      if (isStreaming && !awaitingUserReply) return;
      const hasReferences =
        attachments.length > 0 ||
        selectedNotebookRecords.length > 0 ||
        selectedHistorySessions.length > 0 ||
        selectedQuestionEntries.length > 0 ||
        !!selectedPersona;
      if (!content.trim() && !hasReferences) return;

      let config: Record<string, unknown> | undefined;
      let outgoingAttachments = attachments.map((attachment) => ({
        type: attachment.type,
        filename: attachment.filename,
        base64: attachment.base64,
        mime_type: attachment.mimeType,
      }));
      if (isQuizMode) {
        config = buildQuizWSConfig(quizConfig);
        if (quizConfig.mode === "mimic" && quizPdf) {
          const raw = await readFileAsDataUrl(quizPdf);
          outgoingAttachments = [
            ...outgoingAttachments,
            {
              type: "pdf",
              filename: quizPdf.name,
              base64: extractBase64FromDataUrl(raw),
              mime_type: "application/pdf",
            },
          ];
        }
      } else if (isVisualizeMode) {
        config = buildVisualizeWSConfig(visualizeConfig);
      } else if (isResearchMode) {
        if (!researchValidation.valid) return;
        config = buildResearchWSConfig(researchConfig);
      }

      config = { ...(config ?? {}), _resource_reuse: resourceReuse.policy,
        _persistent_knowledge_bases: retainedKnowledgeBases(selectedKnowledgeBases, agentNameSet, resourceReuse.policy) };
      onSubmit({
        content,
        config,
        attachments: outgoingAttachments,
        knowledgeBases: selectedKbOnly,
        notebookReferences: notebookReferencesPayload,
        historyReferences: selectedHistorySessions.map((s) => s.sessionId),
        questionNotebookReferences: selectedQuestionEntries.map((e) => e.id),
        memoryReferences: [],
        persona: selectedPersona,
        llmSelection,
      });

      // One-shot references are consumed by the send; the knowledge-base
      // scope is sticky and deliberately survives it.
      if (!resourceReuse.policy.attachments) setAttachments([]);
      if (!resourceReuse.policy.notebooks) setSelectedNotebookRecords([]);
      if (!resourceReuse.policy.chat_history) setSelectedHistorySessions([]);
      if (!resourceReuse.policy.question_bank) setSelectedQuestionEntries([]);
      if (!resourceReuse.policy.persona) setSelectedPersona(null);
      applyKnowledgeBases(retainedKnowledgeBases(selectedKbOnly, agentNameSet, resourceReuse.policy));
      if (onResourceSelectionChange) {
        const current = resourceSelection ?? { skills: [] };
        onResourceSelectionChange({
          skills: resourceReuse.policy.skills ? current.skills : [],
        });
      }
    },
    [
      resourceReuse, applyKnowledgeBases, agentNameSet, onResourceSelectionChange, resourceSelection,
      attachments,
      awaitingUserReply,
      isStreaming,
      isQuizMode,
      isResearchMode,
      isVisualizeMode,
      llmSelection,
      notebookReferencesPayload,
      onSubmit,
      quizConfig,
      quizPdf,
      researchConfig,
      researchValidation.valid,
      selectedHistorySessions,
      selectedKbOnly,
      selectedNotebookRecords,
      selectedPersona,
      selectedQuestionEntries,
      visualizeConfig,
    ],
  );

  const capabilityConfigSection = capabilityNeedsConfig ? (
    <div className="mx-auto mb-2 w-full max-w-[720px] px-3">
      {isQuizMode ? (
        <CapabilityConfigCard
          capability="deep_question"
          confirmed={capabilityConfigConfirmed}
          canConfirm={quizValidationErrors.length === 0}
          validationErrors={quizValidationErrors}
          onConfirm={() => setCapabilityConfigConfirmed(true)}
        >
          <QuizConfigPanel
            value={quizConfig}
            onChange={(next) => {
              setQuizConfig(next);
              setCapabilityConfigConfirmed(false);
            }}
            uploadedPdf={quizPdf}
            onUploadPdf={(file) => {
              setQuizPdf(file);
              setCapabilityConfigConfirmed(false);
            }}
          />
        </CapabilityConfigCard>
      ) : isVisualizeMode ? (
        <CapabilityConfigCard
          capability="visualize"
          confirmed={capabilityConfigConfirmed}
          canConfirm
          onConfirm={() => setCapabilityConfigConfirmed(true)}
        >
          <VisualizeConfigPanel
            value={visualizeConfig}
            onChange={(next) => {
              setVisualizeConfig(next);
              setCapabilityConfigConfirmed(false);
            }}
          />
        </CapabilityConfigCard>
      ) : (
        <CapabilityConfigCard
          capability="deep_research"
          confirmed={capabilityConfigConfirmed}
          canConfirm={researchValidation.valid}
          validationErrors={Object.values(researchValidation.errors)}
          onConfirm={() => setCapabilityConfigConfirmed(true)}
        >
          <ResearchConfigPanel
            value={researchConfig}
            errors={researchValidation.errors}
            onChange={(next) => {
              setResearchConfig(next);
              setCapabilityConfigConfirmed(false);
            }}
          />
        </CapabilityConfigCard>
      )}
    </div>
  ) : null;

  return (
    <ResourceReuseContext.Provider value={resourceReuse}>
      {capabilityConfigSection}
      <ChatComposer
        composerRef={composerRef}
        capMenuRef={capMenuRef}
        capBtnRef={capBtnRef}
        spaceMenuRef={spaceMenuRef}
        spaceBtnRef={spaceBtnRef}
        dragCounter={dragCounter}
        dragging={dragging}
        capMenuOpen={capMenuOpen}
        spaceMenuOpen={spaceMenuOpen}
        hasMessages={hasMessages}
        contextBudget={contextBudget ?? null}
        attachments={attachments}
        attachmentError={attachmentError}
        activeCap={activeCap}
        knowledgeBases={kbOptions}
        personaSelection={personaSelection}
        onPersonaSelectionChange={onPersonaSelectionChange}
        resourceCatalog={resourceCatalog}
        resourceSelection={resourceSelection}
        onResourceSelectionChange={onResourceSelectionChange}
        personaSelectorOpen={personaSelectorOpen}
        onPersonaSelectorOpenChange={setPersonaSelectorOpen}
        llmOptions={llmOptions}
        activeLLMDefault={activeLLMDefault}
        llmSelection={llmSelection}
        llmOptionsLoading={llmOptionsLoading}
        llmOptionsError={llmOptionsError}
        selectedNotebookRecords={selectedNotebookRecords}
        selectedHistorySessions={selectedHistorySessions}
        selectedQuestionEntries={selectedQuestionEntries}
        notebookReferenceGroups={notebookReferenceGroups}
        selectedPersona={selectedPersona}
        selectedKnowledgeBases={selectedKbOnly}
        isStreaming={isStreaming}
        awaitingUserReply={awaitingUserReply}
        isVisualizeMode={isVisualizeMode}
        capabilityNeedsConfig={capabilityNeedsConfig}
        capabilityConfigConfirmed={capabilityConfigConfirmed}
        onRequestConfigConfirm={() => setCapabilityConfigConfirmed(false)}
        capabilities={resolvedCapabilities}
        onSetCapMenuOpen={setCapMenuOpen}
        onSetSpaceMenuOpen={setSpaceMenuOpen}
        onToggleKB={handleToggleKB}
        onSelectLLM={applyLLMSelection}
        onSelectNotebookPicker={() => setShowNotebookPicker(true)}
        onSelectHistoryPicker={() => setShowHistoryPicker(true)}
        onSelectQuestionBankPicker={() => setShowQuestionBankPicker(true)}
        onSelectPersonaPicker={() => setShowPersonaPicker(true)}
        onClearPersona={handleClearPersona}
        onSend={handleSend}
        onRemoveAttachment={removeAttachment}
        onRemoveHistory={handleRemoveHistory}
        onRemoveNotebook={handleRemoveNotebook}
        onRemoveQuestion={handleRemoveQuestion}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onPaste={handlePaste}
        onAddFiles={handleAddFiles}
        onSelectCapability={selectCapability}
        showCapabilityChip={showCapabilityChip}
        onCancelStreaming={onCancelStreaming}
        prefillInputRef={prefillInputRef}
        inputPlaceholder={inputPlaceholder}
        inputPlaceholderCompletion={inputPlaceholderCompletion}
        inputHeader={inputHeader}
      />

      <NotebookRecordPicker
        open={showNotebookPicker}
        onClose={() => {
          setShowNotebookPicker(false);
          setSpaceMenuOpen(true);
        }}
        onApply={(records: SelectedRecord[]) => {
          setSelectedNotebookRecords(records);
          setShowNotebookPicker(false);
        }}
      />
            <HistorySessionPicker
        open={showHistoryPicker}
        onClose={() => {
          setShowHistoryPicker(false);
          setSpaceMenuOpen(true);
        }}
        onApply={(sessions: SelectedHistorySession[]) => {
          setSelectedHistorySessions(sessions);
          setShowHistoryPicker(false);
        }}
      />
      <QuestionBankPicker
        open={showQuestionBankPicker}
        initialSelected={selectedQuestionEntries}
        onClose={() => {
          setShowQuestionBankPicker(false);
          setSpaceMenuOpen(true);
        }}
        onApply={(entries: SelectedQuestionEntry[]) => {
          setSelectedQuestionEntries(entries);
          setShowQuestionBankPicker(false);
        }}
      />
      <PersonaPicker
        open={showPersonaPicker}
        initialPersona={selectedPersona}
        onClose={() => {
          setShowPersonaPicker(false);
          setSpaceMenuOpen(true);
        }}
        onApply={(persona: string | null) => {
          setSelectedPersona(persona);
          setShowPersonaPicker(false);
        }}
      />
    </ResourceReuseContext.Provider>
  );
}

const StandaloneComposer = memo(StandaloneComposerImpl);
export default StandaloneComposer;
export type { StandaloneComposerProps };
