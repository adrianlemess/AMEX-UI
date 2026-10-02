export type TokenUsage = { inputTokens: number; outputTokens: number };
export type StructuredRequest = {
  instructions: string;
  context: unknown;
  schema: object;
  maxOutputTokens?: number;
};
export type StructuredAiService = {
  preflight(request: StructuredRequest): { requestBytes: number; estimatedUsdCents: number };
  run(request: StructuredRequest): Promise<unknown>;
  runWithUsage?(request: StructuredRequest): Promise<{ result: unknown; usage: TokenUsage | null }>;
};

/** Generic, serial batches. Callers decide deduplication, eligibility and retry policy. */
export function batches<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('ai_invalid_batch_size');
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

/** Only expose stable error codes; providers and validators can echo private input in error messages. */
export function safeAiFailureCode(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'ai_timeout';
  const message = error instanceof Error ? error.message : '';
  return /^(ai_budget_exceeded|ai_output_limit|ai_incomplete|ai_refused|ai_no_structured_output|ai_invalid_json|ai_provider_invalid_schema|ai_invalid_execution_options|ai_schema_unsupported)$/.test(
    message,
  ) ||
    /^ai_provider_http_\d{3}$/.test(message) ||
    message === 'ai_invalid_output'
    ? message
    : 'ai_request_failed';
}

export type StructuredHooks<T> = {
  /** Optional concurrency/usage claim; a null claim means another request is active. */
  begin?: () => Promise<string | null>;
  /** Persist validated output before marking the attempt completed. */
  complete?: (value: T, usage: TokenUsage | null, claim: string | null) => Promise<void>;
  /** Never receives prompts, candidate labels or raw provider errors. */
  fail?: (reason: string, claim: string) => Promise<void>;
};

/** Transport, preflight, validation and attempt lifecycle shared by backend AI features. */
export async function runStructured<T>(
  service: StructuredAiService,
  request: StructuredRequest,
  validate: (value: unknown) => T,
  hooks: StructuredHooks<T> = {},
): Promise<{ value: T; usage: TokenUsage | null }> {
  service.preflight(request);
  const claim = hooks.begin ? await hooks.begin() : null;
  if (hooks.begin && !claim) throw new Error('ai_request_in_progress');
  try {
    const response = service.runWithUsage
      ? await service.runWithUsage(request)
      : { result: await service.run(request), usage: null };
    let value: T;
    try {
      value = validate(response.result);
    } catch {
      // Domain validators can include private provider output in their error messages.
      throw new Error('ai_invalid_output');
    }
    await hooks.complete?.(value, response.usage, claim);
    return { value, usage: response.usage };
  } catch (error) {
    if (claim) await hooks.fail?.(safeAiFailureCode(error), claim).catch(() => {});
    throw error;
  }
}
