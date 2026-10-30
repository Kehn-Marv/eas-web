type LocalizedCopy = { en: string };

export const TEACH_FIRST_PROFILE_LABEL: LocalizedCopy = {
  en: "Teach first, then check understanding",
};

export const NEXT_LABELS: Record<string, LocalizedCopy> = {
  probe: {
    en: "Start with a probe and test out if you already know it",
  },
  teach: {
    en: "Learn this knowledge point before checking understanding",
  },
  practice: {
    en: "Practice until you reliably clear the mastery gate",
  },
  assess: {
    en: "Explain this clearly in your own words",
  },
  answer_pending: {
    en: "Complete the answer your tutor is waiting for",
  },
  complete: {
    en: "The whole territory is illuminated",
  },
};

export const NEXT_CTA_LABELS: Record<string, LocalizedCopy> = {
  teach: { en: "Learn this knowledge point" },
  review: { en: "Start this review" },
  answer_pending: {
    en: "Answer in the original session",
  },
  complete: { en: "Keep exploring" },
};
