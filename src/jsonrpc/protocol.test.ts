/**
 * Tests for JSON-RPC protocol parsing and validation.
 * Tests both legacy format and Claude Code SDK compatible format.
 */

import { describe, expect, test } from "bun:test"
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
} from "./protocol"

describe("parseRequest", () => {
  test("parses valid run request", () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"Hello"}}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.jsonrpc).toBe("2.0")
      expect(result.request.id).toBe(1)
      expect(result.request.method).toBe("run")
      expect(result.request.params).toEqual({ prompt: "Hello" })
    }
  })

  test("parses valid cancel request", () => {
    const line = '{"jsonrpc":"2.0","id":2,"method":"cancel"}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.method).toBe("cancel")
    }
  })

  test("parses valid status request", () => {
    const line = '{"jsonrpc":"2.0","id":"abc","method":"status"}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.id).toBe("abc")
      expect(result.request.method).toBe("status")
    }
  })

  test("returns error for invalid JSON", () => {
    const result = parseRequest("not json")
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error.error?.code).toBe(ErrorCodes.PARSE_ERROR)
    }
  })

  test("returns error for invalid request structure", () => {
    const result = parseRequest('{"foo":"bar"}')
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error.error?.code).toBe(ErrorCodes.INVALID_REQUEST)
    }
  })

  test("returns error for missing jsonrpc version", () => {
    const result = parseRequest('{"id":1,"method":"run"}')
    expect("error" in result).toBe(true)
  })

  test("returns error for invalid method", () => {
    const result = parseRequest('{"jsonrpc":"2.0","id":1,"method":"invalid"}')
    expect("error" in result).toBe(true)
  })
})

describe("validateRunParams", () => {
  test("validates correct params", () => {
    const result = validateRunParams({ prompt: "Hello world" })
    expect("params" in result).toBe(true)
    if ("params" in result) {
      expect(result.params.prompt).toBe("Hello world")
    }
  })

  test("validates params with session_id", () => {
    const result = validateRunParams({ prompt: "Hello", session_id: "sess_123" })
    expect("params" in result).toBe(true)
    if ("params" in result) {
      expect(result.params.prompt).toBe("Hello")
      expect(result.params.session_id).toBe("sess_123")
    }
  })

  test("returns error for missing prompt", () => {
    const result = validateRunParams({})
    expect("error" in result).toBe(true)
  })

  test("returns error for non-string prompt", () => {
    const result = validateRunParams({ prompt: 123 })
    expect("error" in result).toBe(true)
  })

  test("returns error for undefined params", () => {
    const result = validateRunParams(undefined)
    expect("error" in result).toBe(true)
  })
})

describe("createErrorResponse", () => {
  test("creates error with code and message", () => {
    const response = createErrorResponse(1, ErrorCodes.INTERNAL_ERROR, "Something broke")
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.error).toEqual({
      code: ErrorCodes.INTERNAL_ERROR,
      message: "Something broke",
    })
    expect(response.result).toBeUndefined()
  })

  test("creates error with data", () => {
    const response = createErrorResponse(1, ErrorCodes.INVALID_PARAMS, "Bad params", { field: "prompt" })
    expect(response.error?.data).toEqual({ field: "prompt" })
  })

  test("handles null id per JSON-RPC 2.0 spec", () => {
    const response = createErrorResponse(null, ErrorCodes.PARSE_ERROR, "Parse error")
    expect(response.id).toBeNull()
  })
})

// =============================================================================
// Claude Code SDK Compatible Message Builders
// =============================================================================

describe("createAssistantText", () => {
  test("creates assistant message with text block", () => {
    const msg = createAssistantText("Hello world", "claude-sonnet-4-20250514")
    expect(msg.type).toBe("assistant")
    expect(msg.message.role).toBe("assistant")
    expect(msg.message.model).toBe("claude-sonnet-4-20250514")
    expect(msg.message.content).toEqual([{ type: "text", text: "Hello world" }])
  })
})

describe("createAssistantToolUse", () => {
  test("creates assistant message with tool_use block", () => {
    const msg = createAssistantToolUse("call_123", "read", { filePath: "/tmp/test.txt" }, "claude-sonnet-4-20250514")
    expect(msg.type).toBe("assistant")
    expect(msg.message.content).toEqual([
      { type: "tool_use", id: "call_123", name: "read", input: { filePath: "/tmp/test.txt" } },
    ])
  })

  test("creates assistant message with preceding text and tool_use", () => {
    const msg = createAssistantToolUse(
      "call_123",
      "read",
      { filePath: "/tmp/test.txt" },
      "claude-sonnet-4-20250514",
      "Let me read that file.",
    )
    expect(msg.message.content).toEqual([
      { type: "text", text: "Let me read that file." },
      { type: "tool_use", id: "call_123", name: "read", input: { filePath: "/tmp/test.txt" } },
    ])
  })
})

describe("createToolResult", () => {
  test("creates tool result block", () => {
    const block = createToolResult("call_123", "File contents here")
    expect(block.type).toBe("tool_result")
    expect(block.tool_use_id).toBe("call_123")
    expect(block.content).toBe("File contents here")
    expect(block.is_error).toBeUndefined()
  })

  test("creates error tool result block", () => {
    const block = createToolResult("call_123", "File not found", true)
    expect(block.is_error).toBe(true)
  })
})

describe("createResultMessage", () => {
  test("creates success result message", () => {
    const msg = createResultMessage("sess_123", {
      subtype: "success",
      durationMs: 1234,
      numTurns: 3,
      result: "Done!",
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(msg.type).toBe("result")
    expect(msg.subtype).toBe("success")
    expect(msg.duration_ms).toBe(1234)
    expect(msg.is_error).toBe(false)
    expect(msg.num_turns).toBe(3)
    expect(msg.session_id).toBe("sess_123")
    expect(msg.result).toBe("Done!")
    expect(msg.usage).toEqual({ input_tokens: 100, output_tokens: 50 })
  })

  test("creates error result message", () => {
    const msg = createResultMessage("sess_123", {
      subtype: "error",
      isError: true,
      result: "Something went wrong",
    })
    expect(msg.subtype).toBe("error")
    expect(msg.is_error).toBe(true)
  })

  test("creates cancelled result message", () => {
    const msg = createResultMessage("sess_123", {
      subtype: "cancelled",
    })
    expect(msg.subtype).toBe("cancelled")
    expect(msg.is_error).toBe(false)
  })

  test("creates minimal result message with defaults", () => {
    const msg = createResultMessage("sess_123")
    expect(msg.subtype).toBe("success")
    expect(msg.duration_ms).toBe(0)
    expect(msg.is_error).toBe(false)
    expect(msg.num_turns).toBe(1)
    expect(msg.usage).toBeUndefined()
  })
})

describe("createSystemMessage", () => {
  test("creates system message with subtype", () => {
    const msg = createSystemMessage("status", { running: true })
    expect(msg.type).toBe("system")
    expect(msg.subtype).toBe("status")
    expect(msg.running).toBe(true)
  })

  test("creates system message with tool_result", () => {
    const msg = createSystemMessage("tool_result", {
      tool_result: createToolResult("call_123", "Result"),
    })
    expect(msg.subtype).toBe("tool_result")
    expect(msg.tool_result).toEqual({
      type: "tool_result",
      tool_use_id: "call_123",
      content: "Result",
    })
  })
})

describe("NDJSON format", () => {
  test("assistant message serializes to valid JSON", () => {
    const msg = createAssistantText("Hello", "claude-sonnet-4-20250514")
    const response = createResponse(1, msg)
    const json = JSON.stringify(response)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test("multiple responses can be joined with newlines", () => {
    const responses = [
      createResponse(1, createAssistantText("Hello", "claude-sonnet-4-20250514")),
      createResponse(1, createAssistantToolUse("call_1", "read", { path: "/tmp" }, "claude-sonnet-4-20250514")),
      createResponse(
        1,
        createResultMessage("sess_123", {
          result: "Done",
          inputTokens: 10,
          outputTokens: 5,
        }),
      ),
    ]
    const ndjson = responses.map((r) => JSON.stringify(r)).join("\n")
    const lines = ndjson.split("\n")
    expect(lines.length).toBe(3)
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow()
    })
  })
})

// =============================================================================
// Legacy Format Tests (backwards compatibility)
// =============================================================================

describe("legacy format (backwards compatibility)", () => {
  test("createResponse accepts legacy text chunk", () => {
    const response = createResponse(1, { type: "text", chunk: "Hello" })
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.result).toEqual({ type: "text", chunk: "Hello" })
  })

  test("createResponse accepts legacy complete", () => {
    const response = createResponse("abc", {
      type: "complete",
      response: "Done!",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(response.result).toEqual({
      type: "complete",
      response: "Done!",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
  })

  test("createResponse accepts legacy tool_call", () => {
    const response = createResponse(1, {
      type: "tool_call",
      callId: "call_123",
      name: "read",
      args: { path: "/foo" },
    })
    expect(response.result).toEqual({
      type: "tool_call",
      callId: "call_123",
      name: "read",
      args: { path: "/foo" },
    })
  })
})
