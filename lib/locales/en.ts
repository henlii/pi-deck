export const en = {
  localeName: "English",
  close: "Close",
  chatInputPlaceholder: "Message Pi...",
} as const;

export type TranslationKey = keyof typeof en;
