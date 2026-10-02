import type { StructuredAiService, StructuredRequest } from './structured.js';

/** AMEX-only JSON transport; validation and persistence remain in the AMEX classifier. */
export function deepSeekService(key: string, maxRequestUsdCents: number, fetcher: typeof fetch = fetch): StructuredAiService & { model: string } {
  const model = 'deepseek-flash';
  function prepare(input: StructuredRequest) {
    const maxTokens = input.maxOutputTokens ?? 2500;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8000) throw new Error('ai_budget_exceeded');
    const body = {
      model,
      stream: false,
      response_format: { type: 'json_object' },
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: `${input.instructions}\nReturn only a JSON object matching this schema: ${JSON.stringify(input.schema)}` },
        { role: 'user', content: JSON.stringify(input.context) },
      ],
    };
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    // Conservative upper bound, with room for price changes. Keep the generic per-request ceiling.
    const estimatedUsdCents = Math.ceil(((bytes * 1 + maxTokens * 4) / 1_000_000) * 100);
    if (bytes > 160_000 || estimatedUsdCents > maxRequestUsdCents)
      throw new Error('ai_budget_exceeded');
    return { body, bytes, estimatedUsdCents };
  }
  async function runWithUsage(input: StructuredRequest) {
    const { body } = prepare(input);
    const response = await fetcher('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`ai_provider_http_${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('ai_output_limit');
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('ai_no_structured_output');
    let result: unknown;
    try { result = JSON.parse(content); } catch { throw new Error('ai_invalid_json'); }
    return {
      result,
      usage: Number.isSafeInteger(data.usage?.prompt_tokens) && Number.isSafeInteger(data.usage?.completion_tokens)
        ? { inputTokens: data.usage!.prompt_tokens!, outputTokens: data.usage!.completion_tokens! } : null,
    };
  }
  return { model, preflight(input) { const { bytes, estimatedUsdCents } = prepare(input); return { requestBytes: bytes, estimatedUsdCents }; },
    run: async (input) => (await runWithUsage(input)).result, runWithUsage };
}
export type DeepSeekService = ReturnType<typeof deepSeekService>;
