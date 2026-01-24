/**
 * JSON-RPC listener for miriad-code
 *
 * Implements NDJSON protocol over stdin/stdout for interactive mode.
 * Uses Claude Code SDK compatible message types.
 * See docs/claude-code-protocol.md for the specification.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseRequest,
  validateRunParams,
  createResponse,
  createErrorResponse,
  createAssistantText,
  createAssistantToolUse,
  createToolResult,
  createResultMessage,
  createSystemMessage,
  ErrorCodes,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ContentBlock,
} from "./protocol"
import { Log } from "../util/log"
import { Config } from "../config"

const log = Log.create({ service: "jsonrpc" })

export interface JsonRpcServerOptions {
  dbPath: string
}

interface RequestState {
  id: string | number
  sessionId: string
  abortController: AbortController
  model: string
  numTurns: number
  startTime: number
  pendingToolCalls: Map<string, { name: string; input: unknown }>
  accumulatedText: string
}

/**
 * JSON-RPC server that listens on stdin and writes to stdout.
 * Streams Claude Code SDK compatible messages.
 */
export class JsonRpcServer {
  private storage: Storage
  private currentRequest: RequestState | null = null
  private rl: readline.Interface | null = null

  constructor(private options: JsonRpcServerOptions) {
    this.storage = createStorage(options.dbPath)
  }

  /**
   * Start listening for requests on stdin.
   */
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

    log.info("JSON-RPC server started", { dbPath: this.options.dbPath })
  }

  /**
   * Handle a single line of input (one JSON-RPC request).
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    const parseResult = parseRequest(trimmed)
    if ("error" in parseResult) {
      this.send(parseResult.error)
      return
    }

    const request = parseResult.request
    await this.handleRequest(request)
  }

  /**
   * Route the request to the appropriate handler.
   */
  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    switch (request.method) {
      case "run":
        await this.handleRun(request)
        break
      case "cancel":
        await this.handleCancel(request)
        break
      case "status":
        await this.handleStatus(request)
        break
      default:
        this.send(createErrorResponse(request.id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${request.method}`))
    }
  }

  /**
   * Handle a 'run' request - execute a prompt.
   */
  private async handleRun(request: JsonRpcRequest): Promise<void> {
    // Check if already running
    if (this.currentRequest) {
      this.send(
        createErrorResponse(request.id, ErrorCodes.ALREADY_RUNNING, "A request is already running", {
          currentRequestId: this.currentRequest.id,
        }),
      )
      return
    }

    // Validate params
    const paramsResult = validateRunParams(request.params)
    if ("error" in paramsResult) {
      this.send(createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, paramsResult.error))
      return
    }

    const { prompt, session_id } = paramsResult.params
    const abortController = new AbortController()
    const sessionId = session_id ?? `session_${Date.now()}`

    this.currentRequest = {
      id: request.id,
      sessionId,
      abortController,
      model: Config.model ?? "unknown",
      numTurns: 0,
      startTime: Date.now(),
      pendingToolCalls: new Map(),
      accumulatedText: "",
    }

    log.info("starting run", { requestId: request.id, sessionId, promptLength: prompt.length })

    try {
      const agentOptions: AgentOptions = {
        storage: this.storage,
        verbose: false,
        abortSignal: abortController.signal,
        onEvent: (event) => this.handleAgentEvent(request.id, event),
      }

      const result = await runAgent(prompt, agentOptions)

      // Send result message (if not cancelled)
      if (!abortController.signal.aborted) {
        this.send(
          createResponse(
            request.id,
            createResultMessage(sessionId, {
              subtype: "success",
              durationMs: Date.now() - this.currentRequest.startTime,
              isError: false,
              numTurns: this.currentRequest.numTurns,
              result: result.response,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            }),
          ),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // Already sent cancelled response
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      log.error("run failed", { requestId: request.id, error: message })

      this.send(
        createResponse(
          request.id,
          createResultMessage(sessionId, {
            subtype: "error",
            durationMs: Date.now() - (this.currentRequest?.startTime ?? Date.now()),
            isError: true,
            numTurns: this.currentRequest?.numTurns ?? 0,
            result: message,
          }),
        ),
      )
    } finally {
      this.currentRequest = null
    }
  }

  /**
   * Handle agent events and stream them as Claude Code SDK compatible messages.
   */
  private handleAgentEvent(requestId: string | number, event: AgentEvent): void {
    if (!this.currentRequest) return

    switch (event.type) {
      case "assistant":
        // Accumulate text for the current turn
        this.currentRequest.accumulatedText += event.content
        // Stream as assistant message with text block
        this.send(createResponse(requestId, createAssistantText(event.content, this.currentRequest.model)))
        break

      case "tool_call":
        if (event.toolName && event.toolCallId) {
          // Track pending tool call
          this.currentRequest.pendingToolCalls.set(event.toolCallId, {
            name: event.toolName,
            input: event.toolArgs ?? {},
          })
          // Stream as assistant message with tool_use block
          this.send(
            createResponse(
              requestId,
              createAssistantToolUse(event.toolCallId, event.toolName, event.toolArgs ?? {}, this.currentRequest.model),
            ),
          )
        }
        break

      case "tool_result":
        if (event.toolCallId) {
          // Remove from pending
          this.currentRequest.pendingToolCalls.delete(event.toolCallId)
          this.currentRequest.numTurns++
          // Stream tool result as system message (tool results go back as user messages in full protocol,
          // but for streaming we emit them as system messages)
          this.send(
            createResponse(
              requestId,
              createSystemMessage("tool_result", {
                tool_result: createToolResult(event.toolCallId, event.content, false),
              }),
            ),
          )
        }
        break

      case "error":
        // Stream error as system message
        this.send(
          createResponse(
            requestId,
            createSystemMessage("error", {
              message: event.content,
            }),
          ),
        )
        break

      case "consolidation":
        if (event.consolidationResult?.ran) {
          this.send(
            createResponse(
              requestId,
              createSystemMessage("consolidation", {
                entries_created: event.consolidationResult.entriesCreated,
                entries_updated: event.consolidationResult.entriesUpdated,
                entries_archived: event.consolidationResult.entriesArchived,
                summary: event.consolidationResult.summary,
              }),
            ),
          )
        }
        break

      // Ignore 'user', 'done', 'compaction' events for JSON-RPC output
    }
  }

  /**
   * Handle a 'cancel' request - abort the current run.
   */
  private async handleCancel(request: JsonRpcRequest): Promise<void> {
    if (!this.currentRequest) {
      this.send(createErrorResponse(request.id, ErrorCodes.NOT_RUNNING, "No request is currently running"))
      return
    }

    const cancelledId = this.currentRequest.id
    const sessionId = this.currentRequest.sessionId
    const startTime = this.currentRequest.startTime
    const numTurns = this.currentRequest.numTurns
    const abortController = this.currentRequest.abortController

    // Clear currentRequest before aborting to prevent race with finally block
    this.currentRequest = null
    abortController.abort()

    log.info("request cancelled", { cancelledRequestId: cancelledId })

    // Send cancelled result for the original request
    this.send(
      createResponse(
        cancelledId,
        createResultMessage(sessionId, {
          subtype: "cancelled",
          durationMs: Date.now() - startTime,
          isError: false,
          numTurns,
        }),
      ),
    )

    // Send acknowledgement for the cancel request
    this.send(
      createResponse(
        request.id,
        createSystemMessage("status", {
          running: false,
        }),
      ),
    )
  }

  /**
   * Handle a 'status' request - return current state.
   */
  private async handleStatus(request: JsonRpcRequest): Promise<void> {
    this.send(
      createResponse(
        request.id,
        createSystemMessage("status", {
          running: this.currentRequest !== null,
          request_id: this.currentRequest?.id,
          session_id: this.currentRequest?.sessionId,
        }),
      ),
    )
  }

  /**
   * Send a JSON-RPC response to stdout.
   */
  private send(response: JsonRpcResponse): void {
    const line = JSON.stringify(response)
    process.stdout.write(line + "\n")
  }
}

/**
 * Start the JSON-RPC server.
 */
export async function runJsonRpc(options: JsonRpcServerOptions): Promise<void> {
  const server = new JsonRpcServer(options)
  await server.start()
}

// Re-export types
export type { JsonRpcRequest, JsonRpcResponse } from "./protocol"
