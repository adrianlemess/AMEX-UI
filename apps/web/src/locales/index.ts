import en from './en.json';

export type MessageKey = keyof typeof en;
export const t = (key: MessageKey): string => en[key];
