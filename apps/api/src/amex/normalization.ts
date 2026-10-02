import { merchantName } from './activity.js';

export type MerchantAlias = {
  pattern: string;
  matchType: 'exact' | 'prefix';
  merchantId: string;
  name: string;
  source: 'user' | 'ai' | 'rule';
};

export function merchantKey(text: string) {
  return text.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function resolveMerchant(description: string, aliases: MerchantAlias[]) {
  const raw = merchantKey(description);
  const detected = merchantName(description);
  // User corrections always win, even when a built-in rule would match this description.
  const matches = aliases
    .filter((alias) => {
      const pattern = merchantKey(alias.pattern);
      return alias.matchType === 'exact'
        ? raw === pattern || merchantKey(detected) === pattern
        : pattern.length >= 5 && (raw.startsWith(pattern) || merchantKey(detected).startsWith(pattern));
    })
    .sort(
      (a, b) =>
        Number(b.source === 'user') - Number(a.source === 'user') ||
        Number(b.matchType === 'exact') - Number(a.matchType === 'exact') ||
        b.pattern.length - a.pattern.length,
    );
  const alias = matches[0];
  return alias
    ? { name: alias.name, merchantId: alias.merchantId, source: alias.source }
    : { name: detected, merchantId: null, source: 'rule' as const };
}

/** AI can propose a display name, not a command or a source-row rewrite. */
export function validMerchantName(name: string) {
  return (
    name.length >= 2 &&
    name.length <= 80 &&
    name.trim() === name &&
    !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
    !/^[=+@]/.test(name)
  );
}
