/**
 * Claude Code SDK Protocol Server
 *
 * Raw NDJSON over stdin/stdout. Process stays alive between turns.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseUserMessage,
  getPromptFromUserMessage,
  assistantText,
  assistantToolUse,
  toolResult,
  resultMessage,
  systemMessage,
  type OutputMessage,
  type UserMessage,
} from "./protocol"
import { Log } from "../util/log"
import { Config } from "../config"

// Get the model ID for the reasoning tier (main agent)
function getModelId(): string {
  return Config.resolveModelTier("reasoning")
}

const log = Log.create({ service: "server" })

export interface ServerOptions {
  dbPath: string
}

interface TurnState {
  sessionId: string
  abortController: AbortController
  model: string
  numTurns: number
  startTime: number
}

export class Server {
  private storage: Storage
  private currentTurn: TurnState | null = null
  private rl: readline.Interface | null = null

  constructor(private options: ServerOptions) {
    this.storage = createStorage(options.dbPath)
  }

  async start(): Promise<void> {
    await initializeDefaultEntries(this.storage)

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    })

    this.rl.on("line", (line) => {
      this.handleLine(line).catch((error) => {
        log.error("unhandled error in line handler", { error })
      })
    })

    this.rl.on("close", () => {
      log.info("stdin closed, shutting down")
      process.exit(0)
    })

    log.info("server started", { dbPath: this.options.dbPath })
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    const parseResult = parseUserMessage(trimmed)
    if ("error" in parseResult) {
      this.send(systemMessage("error", { message: parseResult.error }))
      return
    }

    await this.handleUserMessage(parseResult.message)
  }

  private async handleUserMessage(userMessage: UserMessage): Promise<void> {
    // For now, reject if a turn is already running
    // TODO: Support out-of-turn message delivery
    if (this.currentTurn) {
      this.send(systemMessage("error", { message: "A turn is already running" }))
      return
    }

    const sessionId = userMessage.session_id ?? `session_${Date.now()}`
    const prompt = getPromptFromUserMessage(userMessage)
    const abortController = new AbortController()

    this.currentTurn = {
      sessionId,
      abortController,
      model: getModelId(),
      numTurns: 0,
      startTime: Date.now(),
    }

    log.info("starting turn", { sessionId, promptLength: prompt.length })

    try {
      const agentOptions: AgentOptions = {
        storage: this.storage,
        verbose: false,
        abortSignal: abortController.signal,
        onEvent: (event) => this.handleAgentEvent(event),
      }

      const result = await runAgent(prompt, agentOptions)

      if (!abortController.signal.aborted) {
        this.send(
          resultMessage(sessionId, "success", Date.now() - this.currentTurn.startTime, this.currentTurn.numTurns, {
            result: result.response,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          }),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) return

      const message = error instanceof Error ? error.message : String(error)
      log.error("turn failed", { sessionId, error: message })

      this.send(
        resultMessage(sessionId, "error", Date.now() - (this.currentTurn?.startTime ?? Date.now()), this.currentTurn?.numTurns ?? 0, {
          result: message,
        }),
      )
    } finally {
      this.currentTurn = null
    }
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (!this.currentTurn) return
    const { model } = this.currentTurn

    switch (event.type) {
      case "assistant":
        this.send(assistantText(event.content, model))
        break

      case "tool_call":
        if (event.toolName && event.toolCallId) {
          this.send(assistantToolUse(event.toolCallId, event.toolName, event.toolArgs ?? {}, model))
        }
        break

      case "tool_result":
        if (event.toolCallId) {
          this.currentTurn.numTurns++
          this.send(systemMessage("tool_result", { tool_result: toolResult(event.toolCallId, event.content) }))
        }
        break

      case "error":
        this.send(systemMessage("error", { message: event.content }))
        break

      case "consolidation":
        if (event.consolidationResult?.ran) {
          this.send(
            systemMessage("consolidation", {
              entries_created: event.consolidationResult.entriesCreated,
              entries_updated: event.consolidationResult.entriesUpdated,
              entries_archived: event.consolidationResult.entriesArchived,
              summary: event.consolidationResult.summary,
            }),
          )
        }
        break
    }
  }

  private send(message: OutputMessage): void {
    process.stdout.write(JSON.stringify(message) + "\n")
  }
}

export async function runServer(options: ServerOptions): Promise<void> {
  const server = new Server(options)
  await server.start()
}

export type { UserMessage, OutputMessage } from "./protocol"
