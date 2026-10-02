import { expect, it } from 'vitest';
import { resolveMerchant, validMerchantName } from './normalization.js';

it('normalizes known AMEX tokens conservatively and lets a user alias override a rule', () => {
  expect(resolveMerchant('AMZN MKTP DE*12345678', []).name).toBe('Amazon');
  expect(resolveMerchant('PAYPAL *SPOTIFY', []).name).toBe('SPOTIFY');
  expect(
    resolveMerchant('AMZN MKTP DE*12345678', [
      {
        pattern: 'AMZN MKTP',
        matchType: 'prefix',
        merchantId: 'merchant-1',
        name: 'Amazon marketplace',
        source: 'user',
      },
    ]),
  ).toMatchObject({ name: 'Amazon marketplace', source: 'user' });
  expect(resolveMerchant('SOME UNKNOWN SHOP 01234', []).name).not.toBe('Amazon');
  expect(validMerchantName('=HYPERLINK("x")')).toBe(false);
});
