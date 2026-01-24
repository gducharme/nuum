/**
 * JSON-RPC protocol types for miriad-code
 *
 * Uses Claude Code SDK compatible message types.
 * See docs/claude-code-protocol.md for the specification.
 */

import { z } from "zod"

// =============================================================================
// JSON-RPC Request/Response Envelope
// =============================================================================

export const RunParamsSchema = z.object({
  prompt: z.string(),
  session_id: z.string().optional(),
})

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.enum(["run", "cancel", "status"]),
  params: z.unknown().optional(),
})

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>
export type RunParams = z.infer<typeof RunParamsSchema>

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: StreamMessage
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// =============================================================================
// Content Blocks (Claude Code SDK compatible)
// =============================================================================

export interface TextBlock {
  type: "text"
  text: string
}

export interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | null
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

// =============================================================================
// Stream Messages (Claude Code SDK compatible)
// =============================================================================

export interface AssistantMessage {
  type: "assistant"
  message: {
    role: "assistant"
    content: ContentBlock[]
    model: string
  }
}

export interface ResultMessage {
  type: "result"
  subtype: "success" | "error" | "cancelled"
  duration_ms: number
  is_error: boolean
  num_turns: number
  session_id: string
  result?: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export interface SystemMessage {
  type: "system"
  subtype: string
  [key: string]: unknown
}

export type StreamMessage = AssistantMessage | ResultMessage | SystemMessage

// =============================================================================
// Error Codes
// =============================================================================

export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  ALREADY_RUNNING: -32001,
  NOT_RUNNING: -32002,
  CANCELLED: -32003,
} as const

// =============================================================================
// Helper Functions
// =============================================================================

export function createResponse(id: string | number, result: StreamMessage): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result }
}

export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } }
}

export function parseRequest(line: string): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { error: createErrorResponse(null, ErrorCodes.PARSE_ERROR, "Parse error: invalid JSON") }
  }

  const result = JsonRpcRequestSchema.safeParse(parsed)
  if (!result.success) {
    return {
      error: createErrorResponse(
        (parsed as { id?: unknown })?.id ?? null,
        ErrorCodes.INVALID_REQUEST,
        "Invalid request",
        result.error.format(),
      ),
    }
  }

  return { request: result.data }
}

export function validateRunParams(params: unknown): { params: RunParams } | { error: string } {
  const result = RunParamsSchema.safeParse(params)
  if (!result.success) {
    return { error: result.error.format()._errors.join(", ") || "Invalid params" }
  }
  return { params: result.data }
}

// =============================================================================
// Message Builders
// =============================================================================

export function assistantText(text: string, model: string): AssistantMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], model },
  }
}

export function assistantToolUse(id: string, name: string, input: unknown, model: string): AssistantMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }], model },
  }
}

export function toolResult(toolUseId: string, content: string, isError = false): ToolResultBlock {
  return { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError || undefined }
}

export function resultMessage(
  sessionId: string,
  subtype: "success" | "error" | "cancelled",
  durationMs: number,
  numTurns: number,
  options: { result?: string; inputTokens?: number; outputTokens?: number } = {},
): ResultMessage {
  return {
    type: "result",
    subtype,
    duration_ms: durationMs,
    is_error: subtype === "error",
    num_turns: numTurns,
    session_id: sessionId,
    result: options.result,
    usage:
      options.inputTokens !== undefined
        ? { input_tokens: options.inputTokens, output_tokens: options.outputTokens ?? 0 }
        : undefined,
  }
}

export function systemMessage(subtype: string, data: Record<string, unknown> = {}): SystemMessage {
  return { type: "system", subtype, ...data }
}
