"use client";

import { Fragment, memo, useEffect, useRef, useState } from "react";
import {
  BookMarked,
  ChevronRight,
  Database,
  Paperclip,
  UserRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SPACE_ITEMS } from "@/lib/space-items";
import { setPickerOrigin } from "@/lib/picker-origin";

type SelectableSpaceKey =
  | "attach"
  | "knowledge"
  | "chat_history"
  | "reading"
  | "notebooks"
  | "question_bank"
  | "persona";

export interface ChatSpaceSelectionCounts {
  attachments: number;
  knowledge: number;
  chatHistory: number;
  reading: number;
  notebooks: number;
  questionBank: number;
  persona: number;
}

interface ChatSpaceMenuProps {
  variant: "toolbar" | "mention" | "resources";
  query?: string;
  selectedCounts: ChatSpaceSelectionCounts;
  /** Hide the Knowledge entry when no knowledge bases are configured. */
  knowledgeAvailable?: boolean;
  /**
   * Hide the Persona entry. The main chat sets this to false — its
   * persona lives in the standalone toolbar selector (and `/persona`),
   * not in this menu. The quiz follow-up keeps the entry: this menu is
   * its only persona entry point.
   */
  personaAvailable?: boolean;
  /** Show imported Reading materials on surfaces that wire its picker. */
  readingAvailable?: boolean;
  onSelectItem: (key: SelectableSpaceKey) => void;
}

const ITEM_ORDER: SelectableSpaceKey[] = [
  "attach",
  "knowledge",
  "chat_history",
  "reading",
  "notebooks",
  "question_bank",
  "persona",
];

function countFor(
  key: SelectableSpaceKey,
  counts: ChatSpaceSelectionCounts,
): number {
  switch (key) {
    case "attach":
      return counts.attachments;
    case "knowledge":
      return counts.knowledge;
    case "chat_history":
      return counts.chatHistory;
    case "reading":
      return counts.reading;
    case "notebooks":
      return counts.notebooks;
    case "question_bank":
      return counts.questionBank;
    case "persona":
      return counts.persona;
    default:
      return 0;
  }
}

export default memo(function ChatSpaceMenu({
  variant,
  query = "",
  selectedCounts,
  knowledgeAvailable = true,
  personaAvailable = true,
  readingAvailable = false,
  onSelectItem,
}: ChatSpaceMenuProps) {
  const { t } = useTranslation();
  const compact = variant !== "mention";
  const isMention = variant === "mention";

  // Render the items in a fixed, hand-tuned order so the menu always reads
  // the same regardless of how SPACE_ITEMS may be reordered for navigation.
  const items = ITEM_ORDER.filter((key) => {
    if (key === "knowledge") return knowledgeAvailable;
    if (key === "persona") return personaAvailable;
    if (key === "reading") return readingAvailable;
    return true;
  })
    .map((key) => {
      // The first two entries are composer-only concepts (not Space pages),
      // so they are defined here rather than in SPACE_ITEMS.
      if (key === "attach") {
        return {
          key,
          label: "Attach files",
          description: "Upload images, Office docs, code & text.",
          icon: Paperclip,
        };
      }
      if (key === "knowledge") {
        return {
          key,
          label: "Knowledge",
          description: "Search the selected knowledge bases.",
          icon: Database,
        };
      }
      if (key === "reading") {
        return {
          key,
          label: "Reading",
          description: "Reference imported reading sections in chat.",
          icon: BookMarked,
        };
      }
      if (key === "persona") {
        return {
          key,
          label: "Persona",
          description: "Apply a behavior persona for this turn.",
          icon: UserRound,
        };
      }
      return SPACE_ITEMS.find((it) => it.key === key)!;
    })
    .filter(Boolean)
    .filter((item) =>
      t(item.label).toLowerCase().includes(query.trim().toLowerCase()),
    );

  // Arrow key navigation for @ mention mode.
  const [activeIdx, setActiveIdx] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIdxRef = useRef(activeIdx);
  activeIdxRef.current = activeIdx;
  const onSelectItemRef = useRef(onSelectItem);
  onSelectItemRef.current = onSelectItem;

  // Reset active item whenever query filters the list.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Handle keyboard events globally when mention popup is open.
  // Stops propagation for ArrowUp/Down/Enter so the main textarea
  // continues to handle Escape and submit.
  useEffect(() => {
    if (!isMention) return;
    const handler = (e: KeyboardEvent) => {
      const list = itemsRef.current;
      if (list.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % list.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + list.length) % list.length);
      } else if (e.key === "Enter") {
        const item = list[activeIdxRef.current];
        if (!item) return;
        e.preventDefault();
        onSelectItemRef.current(item.key as SelectableSpaceKey);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isMention]);

  return (
    <div
      role={isMention ? "listbox" : undefined}
      aria-label={isMention ? t("Reference space") : undefined}
      className={
        variant === "resources"
          ? "w-full py-1"
          : `rounded-xl border border-[var(--border)] bg-[var(--popover)] shadow-lg backdrop-blur-md ${
              compact ? "w-[280px] py-1.5" : "w-64 p-2"
            }`
      }
    >
      <div
        className={
          variant === "resources"
            ? "grid grid-cols-2"
            : compact
              ? ""
              : "space-y-1"
        }
      >
        {items.map(({ key, label, description, icon: Icon }, idx) => {
          const count = countFor(key as SelectableSpaceKey, selectedCounts);
          const isActive = isMention && idx === activeIdx;
          // Two kinds of rows, Claude-style: "attach" is a direct action
          // (opens the file dialog), everything after it opens a
          // second-level picker — those get a trailing chevron, and a
          // divider separates the two groups.
          const opensPicker = key !== "attach";
          return (
            <Fragment key={key}>
              {variant !== "resources" &&
                idx === 1 &&
                items[0]?.key === "attach" && (
                  <div
                    className={`border-t border-[var(--border)]/60 ${
                      compact ? "mx-3 my-1" : "mx-1 my-1"
                    }`}
                  />
                )}
              <button
                type="button"
                role={isMention ? "option" : undefined}
                aria-selected={isMention ? isActive : undefined}
                onMouseEnter={isMention ? () => setActiveIdx(idx) : undefined}
                onClick={(e) => {
                  // Record the row's rect so the fullscreen picker can expand
                  // outward from exactly this clickable box.
                  setPickerOrigin(e.currentTarget.getBoundingClientRect());
                  onSelectItem(key as SelectableSpaceKey);
                }}
                className={`group flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors ${
                  compact ? "py-1.5" : "py-2"
                } ${
                  isActive
                    ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                    : "hover:bg-[var(--accent)]/60 hover:text-[var(--accent-foreground)]"
                }`}
              >
                <div
                  className={`flex shrink-0 items-center justify-center rounded-md border border-[var(--border)]/50 bg-[var(--muted)]/50 text-[var(--muted-foreground)] group-hover:border-[var(--primary)]/30 group-hover:text-[var(--primary)] ${
                    compact ? "h-6 w-6" : "h-7 w-7"
                  }`}
                >
                  <Icon className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-[var(--foreground)]">
                      {t(label)}
                    </span>
                    {count > 0 && (
                      <span className="rounded-full bg-[var(--primary)]/15 px-1.5 py-0.2 text-[10px] font-semibold text-[var(--primary)]">
                        {count}
                      </span>
                    )}
                  </div>
                  {!compact && (
                    <p className="truncate text-[11px] text-[var(--muted-foreground)]">
                      {t(description)}
                    </p>
                  )}
                </div>
                {opensPicker && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]/60 group-hover:text-[var(--foreground)]" />
                )}
              </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
});
