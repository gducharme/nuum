/**
 * Configuration for miriad-code
 *
 * Phase 1: Simple env-based config with sensible defaults.
 * Provider selection and model IDs are required.
 */

import { z } from "zod";

export namespace Config {
  /**
   * Model tiers for different use cases.
   * See arch spec for token budget rationale.
   */
  export type ModelTier = "reasoning" | "workhorse" | "fast";

  const TokenBudgetSchema = z.object({
    /** Main agent context limit (Opus 200k, leave room for response) */
    mainAgentContext: z.number().default(180_000),
    /** Max tokens for temporal view in prompt */
    temporalBudget: z.number().default(64_000),
    /** Soft limit: run compaction synchronously before turn if exceeded */
    compactionThreshold: z.number().default(80_000),
    /** Target size after compaction */
    compactionTarget: z.number().default(60_000),
    /** Hard limit: refuse turn entirely if exceeded (emergency brake) */
    compactionHardLimit: z.number().default(150_000),
    /** Minimum recent messages to preserve (never summarized) */
    recencyBufferMessages: z.number().default(10),
    /** Temporal search sub-agent budget (Sonnet 1M beta) */
    temporalQueryBudget: z.number().default(512_000),
    /** LTM reflection sub-agent budget (Opus) */
    ltmReflectBudget: z.number().default(180_000),
    /** LTM consolidation worker budget (Sonnet 1M beta) */
    ltmConsolidateBudget: z.number().default(512_000),
    /** Distillation sub-agent max output tokens */
    distillationMaxTokens: z.number().default(4_096),
    /** Fixed overhead for system prompt, tools, and formatting */
    contextOverheadTokens: z.number().default(40_000),
  });

  const TokenBudgetOverrideSchema = TokenBudgetSchema.partial();

  const TokenBudgetOverridesSchema = z
    .object({
      providers: z.record(TokenBudgetOverrideSchema).optional(),
      tiers: z.record(TokenBudgetOverrideSchema).optional(),
    })
    .default({});

  export type TokenBudgets = z.infer<typeof TokenBudgetSchema>;
  export type TokenBudgetOverrides = z.infer<typeof TokenBudgetOverridesSchema>;

  const TokenBudgetEnvKeys = {
    mainAgentContext: "MAIN_AGENT_CONTEXT",
    temporalBudget: "TEMPORAL_BUDGET",
    compactionThreshold: "COMPACTION_THRESHOLD",
    compactionTarget: "COMPACTION_TARGET",
    compactionHardLimit: "COMPACTION_HARD_LIMIT",
    recencyBufferMessages: "RECENCY_BUFFER_MESSAGES",
    temporalQueryBudget: "TEMPORAL_QUERY_BUDGET",
    ltmReflectBudget: "LTM_REFLECT_BUDGET",
    ltmConsolidateBudget: "LTM_CONSOLIDATE_BUDGET",
    distillationMaxTokens: "DISTILLATION_MAX_TOKENS",
    contextOverheadTokens: "CONTEXT_OVERHEAD_TOKENS",
  } as const;

  const KnownProviders = [
    "anthropic",
    "openai",
    "codex",
    "openai-compatible",
  ] as const;

  function parseNumberEnv(value: string | undefined, envKey: string): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid numeric value for ${envKey}`);
    }
    return parsed;
  }

  function readTokenBudgetsFromEnv(prefix: string): Partial<TokenBudgets> {
    const budgets: Partial<TokenBudgets> = {};
    for (const [key, envSuffix] of Object.entries(TokenBudgetEnvKeys)) {
      const envKey = `AGENT_TOKEN_BUDGET_${prefix}${envSuffix}`;
      const value = parseNumberEnv(process.env[envKey], envKey);
      if (value !== undefined) {
        budgets[key as keyof TokenBudgets] = value;
      }
    }
    return budgets;
  }

  function readProviderOverrides(): Record<string, Partial<TokenBudgets>> {
    const overrides: Record<string, Partial<TokenBudgets>> = {};
    for (const provider of KnownProviders) {
      const envProvider = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
      const budgetOverride = readTokenBudgetsFromEnv(`PROVIDER_${envProvider}_`);
      if (Object.keys(budgetOverride).length > 0) {
        overrides[provider] = budgetOverride;
      }
    }
    return overrides;
  }

  function readTierOverrides(): Record<ModelTier, Partial<TokenBudgets>> {
    const tiers: ModelTier[] = ["reasoning", "workhorse", "fast"];
    const overrides = {} as Record<ModelTier, Partial<TokenBudgets>>;
    for (const tier of tiers) {
      const envTier = tier.toUpperCase();
      const budgetOverride = readTokenBudgetsFromEnv(`TIER_${envTier}_`);
      if (Object.keys(budgetOverride).length > 0) {
        overrides[tier] = budgetOverride;
      }
    }
    return overrides;
  }

  export const Schema = z.object({
    provider: z.string(),
    providers: z
      .object({
        openai: z.object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          models: z.object({
            reasoning: z.string().optional(),
            workhorse: z.string().optional(),
            fast: z.string().optional(),
          }),
        }),
        openaiCompatible: z.object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          models: z.object({
            reasoning: z.string().optional(),
            workhorse: z.string().optional(),
            fast: z.string().optional(),
          }),
        }),
      })
      .default({
        openai: { models: {} },
        openaiCompatible: { models: {} },
      }),
    models: z.object({
      /** Main agent, LTM reflection - best judgment */
      reasoning: z.string().optional(),
      /** Memory management, search - high context */
      workhorse: z.string().optional(),
      /** Quick classifications - fast response */
      fast: z.string().optional(),
    }),
    db: z.string().default("./agent.db"),
    tokenBudgets: TokenBudgetSchema,
    tokenBudgetOverrides: TokenBudgetOverridesSchema,
  });

  export type Config = z.infer<typeof Schema>;

  let cached: Config | null = null;

  /**
   * Get the current configuration.
   * Loads from environment variables with sensible defaults.
   */
  export function get(): Config {
    if (cached) return cached;

    cached = Schema.parse({
      provider: process.env.AGENT_PROVIDER,
      models: {
        reasoning: process.env.AGENT_MODEL_REASONING,
        workhorse: process.env.AGENT_MODEL_WORKHORSE,
        fast: process.env.AGENT_MODEL_FAST,
      },
      providers: {
        openai: {
          apiKey: process.env.OPENAI_API_KEY,
          baseUrl: process.env.OPENAI_BASE_URL ?? process.env.LLM_BASE_URL,
          models: {
            reasoning: process.env.OPENAI_MODEL_REASONING,
            workhorse: process.env.OPENAI_MODEL_WORKHORSE,
            fast: process.env.OPENAI_MODEL_FAST,
          },
        },
        openaiCompatible: {
          apiKey:
            process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY,
          baseUrl:
            process.env.OPENAI_COMPATIBLE_BASE_URL ??
            process.env.OPENAI_BASE_URL ??
            process.env.LLM_BASE_URL,
          models: {
            reasoning: process.env.OPENAI_COMPAT_MODEL_REASONING,
            workhorse: process.env.OPENAI_COMPAT_MODEL_WORKHORSE,
            fast: process.env.OPENAI_COMPAT_MODEL_FAST,
          },
        },
      },
      db: process.env.AGENT_DB,
      tokenBudgets: readTokenBudgetsFromEnv(""),
      tokenBudgetOverrides: {
        providers: readProviderOverrides(),
        tiers: readTierOverrides(),
      },
    });

    return cached;
  }

  /**
   * Get the model ID for a given tier.
   */
  export function resolveModelTier(tier: ModelTier): string | undefined {
    const config = get();
    return config.models[tier];
  }

  export function getTokenBudgets(options: {
    provider?: string;
    tier?: ModelTier;
  } = {}): TokenBudgets {
    const config = get();
    const provider = options.provider ?? config.provider;
    const tier = options.tier;
    let budgets = { ...config.tokenBudgets };
    const providerOverride = config.tokenBudgetOverrides.providers?.[provider];
    if (providerOverride) {
      budgets = { ...budgets, ...providerOverride };
    }
    if (tier) {
      const tierOverride = config.tokenBudgetOverrides.tiers?.[tier];
      if (tierOverride) {
        budgets = { ...budgets, ...tierOverride };
      }
    }
    return budgets;
  }

  export function getTokenBudgetsForTier(tier: ModelTier): TokenBudgets {
    return getTokenBudgets({ tier });
  }

  /**
   * Reset cached config (for testing).
   */
  export function reset(): void {
    cached = null;
  }
}
