/**
 * Agentic compaction for temporal summarization.
 *
 * This agent compresses conversation history by creating summaries. It:
 * 1. Receives the same prompt as the main agent (for cache efficiency)
 * 2. Sees the temporal view with ULIDs exposed
 * 3. Calls create_summary() to subsume ranges of messages/summaries
 * 4. Loops until the token budget target is met
 *
 * The agent makes episodically-intelligent decisions about where to place
 * breakpoints and how to structure narratives, rather than using fixed rules.
 */

import { tool } from "ai"
import type {
  CoreMessage,
  CoreTool,
  ToolCallPart,
  ToolResultPart,
} from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import type { TemporalMessage, TemporalSummary, TemporalSummaryInsert } from "../storage/schema"
import { Provider } from "../provider"
import { Config } from "../config"
import { Identifier } from "../id"
import { Log } from "../util/log"
import { buildSystemPrompt, buildConversationHistory } from "../agent"
import { estimateSummaryTokens, type SummaryInput } from "./summary"

const log = Log.create({ service: "compaction-agent" })

const MAX_COMPACTION_TURNS = 10

/**
 * Result of a compaction run.
 */
export interface CompactionResult {
  /** Number of summaries created */
  summariesCreated: number
  /** Total tokens before compaction */
  tokensBefore: number
  /** Total tokens after compaction */
  tokensAfter: number
  /** Number of agent turns taken */
  turnsUsed: number
  /** Token usage for the agent */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Configuration for compaction.
 */
export interface CompactionConfig {
  /** Trigger compaction when uncompacted tokens exceed this threshold */
  compactionThreshold: number
  /** Target token count after compaction completes */
  compactionTarget: number
}

/**
 * Build the compaction task prompt.
 *
 * The conversation history already contains IDs in messages ([id:xxx]) and
 * summaries ([summary from:xxx to:yyy]), so we just need to explain the task.
 */
function buildCompactionTaskPrompt(
  currentTokens: number,
  targetTokens: number,
): string {
  return `## Compaction Task

The conversation history has grown too large and needs to be compressed.

**Current size:** ~${currentTokens} tokens
**Target size:** ~${targetTokens} tokens
**Tokens to compress:** ~${currentTokens - targetTokens}

The conversation above contains IDs you can reference:
- Messages have \`[id:xxx]\` prefixes
- Summaries show \`[summary from:xxx to:yyy]\` ranges

## Instructions

Create summaries to compress the conversation history. For each summary:

1. Choose a **startId** and **endId** that defines the range to summarize
   - Use IDs visible in the conversation (message IDs or summary boundary IDs)
   - A summary can subsume other summaries by spanning their ranges
   - Leave recent messages unsummarized to preserve detail for ongoing work

2. Write a **narrative** that captures what happened in that range
   - Focus on the flow of events, decisions made, and work accomplished
   - Write from your perspective as the agent

3. List **keyObservations** - specific facts that must not be lost
   - Instructions from the user
   - Technical decisions and their rationale
   - File paths, repository names, specific values
   - Anything that would be needed to continue the work

Call **create_summary** one or more times. You can create multiple summaries in a single turn.

When you've compressed enough to meet the target (or believe no more compression is beneficial), call **finish_compaction**.

Tips:
- Older content can be more aggressively summarized
- Recent work should retain more detail
- Natural breakpoints: task completions, topic changes, user requests
- Higher-order summaries are created automatically when you subsume existing summaries
`
}

/**
 * Build the compaction tools.
 */
function buildCompactionTools(): Record<string, CoreTool> {
  return {
    create_summary: tool({
      description: "Create a summary that covers a range of the conversation. The summary subsumes all messages and summaries within the specified range.",
      parameters: z.object({
        startId: z.string().describe("ULID of the first item to include (inclusive). Must be a visible ID."),
        endId: z.string().describe("ULID of the last item to include (inclusive). Must be a visible ID."),
        narrative: z.string().describe("Prose summary of events in this range (2-4 sentences). Write from your perspective."),
        keyObservations: z.array(z.string()).describe("Array of specific facts, instructions, or decisions that must be retained."),
      }),
    }),

    finish_compaction: tool({
      description: "Signal that compaction is complete for this turn. Call this when you've created enough summaries or believe no more compression is beneficial.",
      parameters: z.object({
        reason: z.string().describe("Brief explanation of why compaction is complete (e.g., 'reached target', 'recent content should stay detailed')"),
      }),
    }),
  }
}

/**
 * Execute a compaction tool call.
 */
async function executeCompactionTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  validIds: Set<string>,
): Promise<{ output: string; done: boolean; summaryCreated: boolean }> {
  switch (toolName) {
    case "create_summary": {
      const { startId, endId, narrative, keyObservations } = args as {
        startId: string
        endId: string
        narrative: string
        keyObservations: string[]
      }

      // Validate IDs
      if (!validIds.has(startId)) {
        return {
          output: `Error: startId "${startId}" is not a visible ID. Use only IDs shown in the conversation history.`,
          done: false,
          summaryCreated: false,
        }
      }
      if (!validIds.has(endId)) {
        return {
          output: `Error: endId "${endId}" is not a visible ID. Use only IDs shown in the conversation history.`,
          done: false,
          summaryCreated: false,
        }
      }
      if (startId > endId) {
        return {
          output: `Error: startId must be <= endId (got ${startId} > ${endId})`,
          done: false,
          summaryCreated: false,
        }
      }

      // Determine the order of the new summary
      // If it subsumes any summaries, it's one order higher than the max subsumed
      const summaries = await storage.temporal.getSummaries()
      const subsumedSummaries = summaries.filter(
        s => s.startId >= startId && s.endId <= endId
      )
      const maxSubsumedOrder = subsumedSummaries.length > 0
        ? Math.max(...subsumedSummaries.map(s => s.orderNum))
        : 0
      const newOrder = maxSubsumedOrder + 1

      // Create the summary
      const input: SummaryInput = {
        narrative,
        keyObservations,
        tags: [], // Could extract tags from content in future
      }

      const summaryInsert: TemporalSummaryInsert = {
        id: Identifier.ascending("summary"),
        orderNum: newOrder,
        startId,
        endId,
        narrative: input.narrative,
        keyObservations: JSON.stringify(input.keyObservations),
        tags: JSON.stringify(input.tags),
        tokenEstimate: estimateSummaryTokens(input),
        createdAt: new Date().toISOString(),
      }

      await storage.temporal.createSummary(summaryInsert)

      log.info("created summary", {
        id: summaryInsert.id,
        order: newOrder,
        startId,
        endId,
        tokens: summaryInsert.tokenEstimate,
        subsumed: subsumedSummaries.length,
      })

      return {
        output: `Created order-${newOrder} summary covering ${startId} → ${endId} (~${summaryInsert.tokenEstimate} tokens). ${subsumedSummaries.length > 0 ? `Subsumed ${subsumedSummaries.length} existing summaries.` : ""}`,
        done: false,
        summaryCreated: true,
      }
    }

    case "finish_compaction": {
      const { reason } = args as { reason: string }
      log.info("compaction finished", { reason })
      return {
        output: `Compaction complete: ${reason}`,
        done: true,
        summaryCreated: false,
      }
    }

    default:
      return {
        output: `Unknown tool: ${toolName}`,
        done: false,
        summaryCreated: false,
      }
  }
}

/**
 * Collect all valid IDs that the agent can reference from the temporal view.
 * These are the IDs visible in the reconstructed conversation history.
 */
function collectValidIds(
  messages: TemporalMessage[],
  summaries: TemporalSummary[],
): Set<string> {
  const ids = new Set<string>()

  // Add summary boundary IDs
  for (const summary of summaries) {
    ids.add(summary.startId)
    ids.add(summary.endId)
  }

  // Add message IDs
  for (const message of messages) {
    ids.add(message.id)
  }

  return ids
}

/**
 * Run the compaction agent.
 */
export async function runCompaction(
  storage: Storage,
  config: CompactionConfig,
): Promise<CompactionResult> {
  const result: CompactionResult = {
    summariesCreated: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    turnsUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  }

  // Get initial token count
  result.tokensBefore = await storage.temporal.estimateUncompactedTokens()

  if (result.tokensBefore <= config.compactionTarget) {
    log.info("skipping compaction - already under target", {
      current: result.tokensBefore,
      target: config.compactionTarget,
    })
    result.tokensAfter = result.tokensBefore
    return result
  }

  log.info("starting compaction", {
    tokensBefore: result.tokensBefore,
    target: config.compactionTarget,
  })

  // Use same system prompt as main agent for cache efficiency
  const { prompt: systemPrompt } = await buildSystemPrompt(storage)

  // Get model (use workhorse tier - good balance of capability and cost)
  const model = Provider.getModelForTier("workhorse")

  // Build tools
  const tools = buildCompactionTools()

  // Outer loop: keep compacting until under budget or max turns
  for (let turn = 0; turn < MAX_COMPACTION_TURNS; turn++) {
    result.turnsUsed++

    // Check current token count
    const currentTokens = await storage.temporal.estimateUncompactedTokens()

    if (currentTokens <= config.compactionTarget) {
      log.info("compaction target reached", {
        current: currentTokens,
        target: config.compactionTarget
      })
      break
    }

    // Rebuild conversation history (it now includes IDs in messages/summaries)
    // This must be refreshed each turn since summaries may have been created
    const refreshedHistoryTurns = await buildConversationHistory(storage)

    // Get all messages and summaries to know which IDs are valid
    const allMessages = await storage.temporal.getMessages()
    const allSummaries = await storage.temporal.getSummaries()
    const validIds = collectValidIds(allMessages, allSummaries)

    // Build task prompt (IDs are already visible in the conversation)
    const taskPrompt = buildCompactionTaskPrompt(
      currentTokens,
      config.compactionTarget,
    )

    // Agent messages: refreshed history + compaction task
    const agentMessages: CoreMessage[] = [
      ...refreshedHistoryTurns,
      { role: "user", content: `[SYSTEM: ${taskPrompt}]` },
    ]

    // Inner agent loop for this turn
    let turnDone = false
    let innerTurns = 0
    const maxInnerTurns = 5

    while (!turnDone && innerTurns < maxInnerTurns) {
      innerTurns++

      const response = await Provider.generate({
        model,
        system: systemPrompt,
        messages: agentMessages,
        tools,
        maxTokens: 4096,
        temperature: 0,
      })

      result.usage.inputTokens += response.usage.promptTokens
      result.usage.outputTokens += response.usage.completionTokens

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        const assistantParts: (import("ai").TextPart | ToolCallPart)[] = []
        const toolResultParts: ToolResultPart[] = []

        if (response.text) {
          assistantParts.push({ type: "text", text: response.text })
        }

        for (const toolCall of response.toolCalls) {
          assistantParts.push({
            type: "tool-call",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args: toolCall.args,
          })

          const { output, done, summaryCreated } = await executeCompactionTool(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            storage,
            validIds,
          )

          toolResultParts.push({
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            result: output,
          })

          if (summaryCreated) {
            result.summariesCreated++
          }

          if (done) {
            turnDone = true
          }
        }

        agentMessages.push({ role: "assistant", content: assistantParts })
        agentMessages.push({ role: "tool", content: toolResultParts })
      } else {
        // No tool calls - agent might be confused, end this turn
        if (response.text) {
          agentMessages.push({ role: "assistant", content: response.text })
        }
        log.warn("compaction agent made no tool calls", {
          text: response.text?.slice(0, 200)
        })
        turnDone = true
      }
    }
  }

  // Get final token count
  result.tokensAfter = await storage.temporal.estimateUncompactedTokens()

  log.info("compaction complete", {
    summariesCreated: result.summariesCreated,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    turnsUsed: result.turnsUsed,
  })

  return result
}

/**
 * Run compaction as a background worker with tracking.
 */
export async function runCompactionWorker(
  storage: Storage,
  config: CompactionConfig,
): Promise<CompactionResult> {
  // Create worker record
  const workerId = Identifier.ascending("worker")
  await storage.workers.create({
    id: workerId,
    type: "temporal-compact",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  })

  try {
    const result = await runCompaction(storage, config)
    await storage.workers.complete(workerId)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await storage.workers.fail(workerId, error)
    throw e
  }
}

// Legacy exports for backwards compatibility during transition
// TODO: Remove these after updating callers

/** @deprecated Use runCompaction instead */
export interface SummarizationLLM {
  summarizeMessages(messages: TemporalMessage[]): Promise<SummaryInput>
  summarizeSummaries(summaries: TemporalSummary[], targetOrder: number): Promise<SummaryInput>
}

/** @deprecated No longer needed - agent handles summarization */
export function createSummarizationLLM(): SummarizationLLM {
  throw new Error("createSummarizationLLM is deprecated - use runCompaction instead")
}
