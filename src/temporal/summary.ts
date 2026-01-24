/**
 * Summary/distillation data types and utilities.
 */

/**
 * Input for creating a distillation (summary).
 */
export interface SummaryInput {
  /** The operational context / narrative */
  narrative: string
  /** Key facts, decisions, instructions to retain */
  keyObservations: string[]
  /** Topic tags for searchability */
  tags: string[]
}

/**
 * Estimate token count for a summary's content.
 *
 * Uses a rough approximation: ~4 characters per token.
 * This is a simplification—actual tokenization varies by model.
 */
export function estimateSummaryTokens(input: SummaryInput): number {
  const narrativeTokens = Math.ceil(input.narrative.length / 4)
  const observationTokens = input.keyObservations.reduce(
    (sum, obs) => sum + Math.ceil(obs.length / 4),
    0,
  )
  const tagTokens = input.tags.length * 2 // Tags are usually short

  return narrativeTokens + observationTokens + tagTokens
}
