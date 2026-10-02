import { z } from 'zod';
import { needsReview, validCategoryName } from './activity.js';

/** AI invents the taxonomy for new merchants; existing household labels are reused, not silently renamed. */
export function validateAiCategories(raw: unknown, unknownMerchants: string[], existingCategories: string[]) {
  const result = z
    .object({
      insights: z.array(z.string().min(1).max(300)).max(4),
      categoryNames: z.array(z.string()).max(12),
      classifications: z.array(z.object({ merchant: z.string(), category: z.string() }).strict()).max(80),
    })
    .strict()
    .parse(raw);
  const existing = new Map(existingCategories.map((name) => [name.toLowerCase(), name]));
  const proposed = result.categoryNames;
  if (
    proposed.some((name) => !validCategoryName(name) || existing.has(name.toLowerCase())) ||
    new Set(proposed.map((name) => name.toLowerCase())).size !== proposed.length
  )
    throw new Error('invalid_ai_categories');
  const allowed = new Set([...proposed, ...existingCategories, needsReview]);
  const unknown = new Set(unknownMerchants);
  if (
    result.classifications.length !== unknown.size ||
    new Set(result.classifications.map((row) => row.merchant)).size !== unknown.size ||
    result.classifications.some((row) => !unknown.has(row.merchant) || !allowed.has(row.category))
  )
    throw new Error('invalid_ai_classifications');
  return result;
}
