/**
 * Claude Code SDK Protocol Server
 *
 * Raw NDJSON over stdin/stdout. Process stays alive between turns.
 * Supports out-of-turn message delivery - messages received during a turn
 * are queued and processed after the current turn completes.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseInputMessage,
  isUserMessage,
  isControlRequest,
  getPromptFromUserMessage,
  assistantText,
  assistantToolUse,
  toolResult,
  resultMessage,
  systemMessage,
  type OutputMessage,
  type UserMessage,
  type ControlRequest,
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
  private messageQueue: UserMessage[] = []
  private rl: readline.Interface | null = null
  private processing = false

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

    const parseResult = parseInputMessage(trimmed)
    if ("error" in parseResult) {
      this.send(systemMessage("error", { message: parseResult.error }))
      return
    }

    const msg = parseResult.message

    if (isControlRequest(msg)) {
      await this.handleControlRequest(msg)
    } else if (isUserMessage(msg)) {
      await this.handleUserMessage(msg)
    }
  }

  private async handleControlRequest(request: ControlRequest): Promise<void> {
    switch (request.action) {
      case "interrupt":
        if (this.currentTurn) {
          log.info("interrupting current turn", { sessionId: this.currentTurn.sessionId })
          this.currentTurn.abortController.abort()
          this.send(systemMessage("interrupted", { session_id: this.currentTurn.sessionId }))
        } else {
          this.send(systemMessage("error", { message: "No turn is currently running" }))
        }
        break

      case "status":
        this.send(
          systemMessage("status", {
            running: this.currentTurn !== null,
            session_id: this.currentTurn?.sessionId,
            queued_messages: this.messageQueue.length,
          }),
        )
        break
    }
  }

  private async handleUserMessage(userMessage: UserMessage): Promise<void> {
    // If a turn is running, queue the message
    if (this.currentTurn) {
      this.messageQueue.push(userMessage)
      log.info("queued message", { 
        sessionId: userMessage.session_id, 
        queueLength: this.messageQueue.length,
        currentSession: this.currentTurn.sessionId,
      })
      this.send(
        systemMessage("queued", {
          session_id: userMessage.session_id,
          position: this.messageQueue.length,
        }),
      )
      return
    }

    // Process this message
    await this.processTurn(userMessage)

    // Process any queued messages
    await this.processQueue()
  }

  private async processTurn(userMessage: UserMessage): Promise<void> {
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
        // Drain queued messages and inject them mid-turn
        onBeforeTurn: () => this.drainQueueForInjection(),
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
      } else {
        // Turn was interrupted
        this.send(
          resultMessage(sessionId, "cancelled", Date.now() - this.currentTurn.startTime, this.currentTurn.numTurns),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // Turn was interrupted - already sent cancelled result
        return
      }

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

  private async processQueue(): Promise<void> {
    // Prevent re-entrancy
    if (this.processing) return
    this.processing = true

    try {
      while (this.messageQueue.length > 0 && !this.currentTurn) {
        const nextMessage = this.messageQueue.shift()!
        log.info("processing queued message", { 
          sessionId: nextMessage.session_id,
          remainingInQueue: this.messageQueue.length,
        })
        await this.processTurn(nextMessage)
      }
    } finally {
      this.processing = false
    }
  }

  /**
   * Drain all queued messages and return them concatenated for mid-turn injection.
   * Returns null if no messages are queued.
   */
  private drainQueueForInjection(): string | null {
    if (this.messageQueue.length === 0) {
      return null
    }

    const messages = this.messageQueue.splice(0, this.messageQueue.length)
    const contents = messages.map(m => getPromptFromUserMessage(m))
    const combined = contents.join("\n\n")

    log.info("injecting mid-turn messages", { 
      messageCount: messages.length,
      combinedLength: combined.length,
    })

    // Notify about the injection
    this.send(systemMessage("injected", { 
      message_count: messages.length,
      content_length: combined.length,
    }))

    return combined
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

export type { UserMessage, ControlRequest, OutputMessage } from "./protocol"
