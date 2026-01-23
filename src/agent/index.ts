/**
 * Core agent implementation for miriad-code
 *
 * Main agent loop that:
 * 1. Builds the prompt from memory (temporal, present, LTM)
 * 2. Calls the AI model with tools
 * 3. Executes tool calls
 * 4. Logs everything to temporal memory
 * 5. Updates present state
 */

import { tool } from "ai"
import type {
  CoreMessage,
  CoreTool,
  CoreAssistantMessage,
  CoreToolMessage,
  ToolCallPart,
  ToolResultPart,
  TextPart,
} from "ai"
import { z } from "zod"
import { Provider } from "../provider"
import { Config } from "../config"
import type { Storage, Task } from "../storage"
import { Identifier } from "../id"
import { Tool, BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from "../tool"

const MAX_TURNS = 50

export interface AgentOptions {
  storage: Storage
  verbose?: boolean
  onEvent?: (event: AgentEvent) => void
}

export interface AgentEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error" | "done"
  content: string
  toolName?: string
  toolCallId?: string
}

export interface AgentResult {
  response: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build the system prompt including memory state.
 */
async function buildSystemPrompt(storage: Storage): Promise<{ prompt: string; tokens: number }> {
  // Get identity and behavior from LTM
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")

  // Get present state
  const present = await storage.present.get()

  // Get temporal history (previous messages for multi-turn persistence)
  const config = Config.get()
  const temporalBudget = config.tokenBudgets.temporalBudget
  const allMessages = await storage.temporal.getMessages()

  // Select recent messages that fit within budget (newest first)
  const selectedMessages: typeof allMessages = []
  let temporalTokens = 0
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i]
    if (temporalTokens + msg.tokenEstimate > temporalBudget) break
    selectedMessages.unshift(msg)
    temporalTokens += msg.tokenEstimate
  }

  // Build system prompt
  let prompt = `You are a coding assistant with persistent memory.

Your memory spans across conversations, allowing you to remember past decisions, track ongoing projects, and learn user preferences.

`

  // Add identity
  if (identity) {
    prompt += `<identity>
${identity.body}
</identity>

`
  }

  // Add behavior
  if (behavior) {
    prompt += `<behavior>
${behavior.body}
</behavior>

`
  }

  // Add temporal history (conversation memory from previous sessions)
  if (selectedMessages.length > 0) {
    prompt += `<conversation_history>
The following is your memory of previous interactions with this user:

`
    for (const msg of selectedMessages) {
      const role = msg.type === "user" ? "User" :
                   msg.type === "assistant" ? "Assistant" :
                   msg.type === "tool_call" ? "Tool Call" :
                   msg.type === "tool_result" ? "Tool Result" : msg.type

      // Truncate very long content for context efficiency
      const content = msg.content.length > 500
        ? msg.content.slice(0, 500) + "..."
        : msg.content

      prompt += `[${role}]: ${content}\n`
    }
    prompt += `</conversation_history>

`
  }

  // Add present state
  prompt += `<present_state>
<mission>${present.mission ?? "(none)"}</mission>
<status>${present.status ?? "(none)"}</status>
<tasks>
`
  for (const task of present.tasks) {
    prompt += `  <task status="${task.status}">${task.content}</task>\n`
  }
  prompt += `</tasks>
</present_state>

`

  // Add available tools description
  prompt += `You have access to tools for file operations (read, write, edit, bash, glob, grep).
Use tools to accomplish tasks. Always explain what you're doing.

When you're done with a task, update the present state if appropriate.
`

  return { prompt, tokens: estimateTokens(prompt) }
}

/**
 * Convert our Tool definitions to AI SDK CoreTool format.
 */
function buildTools(): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {}

  // Bash tool
  tools.bash = tool({
    description: BashTool.definition.description,
    parameters: BashTool.definition.parameters,
  })

  // Read tool
  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
  })

  // Write tool
  tools.write = tool({
    description: WriteTool.definition.description,
    parameters: WriteTool.definition.parameters,
  })

  // Edit tool
  tools.edit = tool({
    description: EditTool.definition.description,
    parameters: EditTool.definition.parameters,
  })

  // Glob tool
  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
  })

  // Grep tool
  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
  })

  // Present state tools
  tools.present_set_mission = tool({
    description: "Set the current mission (high-level objective)",
    parameters: z.object({
      mission: z.string().nullable().describe("The mission to set, or null to clear"),
    }),
  })

  tools.present_set_status = tool({
    description: "Set the current status (what you're working on now)",
    parameters: z.object({
      status: z.string().nullable().describe("The status to set, or null to clear"),
    }),
  })

  tools.present_update_tasks = tool({
    description: "Update the task list",
    parameters: z.object({
      tasks: z.array(
        z.object({
          id: z.string().describe("Unique task ID"),
          content: z.string().describe("Task description (imperative form)"),
          status: z.enum(["pending", "in_progress", "completed", "blocked"]),
          blockedReason: z.string().optional().describe("Why the task is blocked"),
        }),
      ),
    }),
  })

  return tools
}

/**
 * Execute a tool call and return the result.
 */
async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  sessionId: string,
  messageId: string,
  callId: string,
): Promise<string> {
  const ctx = Tool.createContext({
    sessionID: sessionId,
    messageID: messageId,
    callID: callId,
  })

  switch (toolName) {
    case "bash": {
      const result = await BashTool.definition.execute(args as z.infer<typeof BashTool.definition.parameters>, ctx)
      return result.output
    }
    case "read": {
      const result = await ReadTool.definition.execute(args as z.infer<typeof ReadTool.definition.parameters>, ctx)
      return result.output
    }
    case "write": {
      const result = await WriteTool.definition.execute(args as z.infer<typeof WriteTool.definition.parameters>, ctx)
      return result.output
    }
    case "edit": {
      const result = await EditTool.definition.execute(args as z.infer<typeof EditTool.definition.parameters>, ctx)
      return result.output
    }
    case "glob": {
      const result = await GlobTool.definition.execute(args as z.infer<typeof GlobTool.definition.parameters>, ctx)
      return result.output
    }
    case "grep": {
      const result = await GrepTool.definition.execute(args as z.infer<typeof GrepTool.definition.parameters>, ctx)
      return result.output
    }
    case "present_set_mission": {
      const { mission } = args as { mission: string | null }
      await storage.present.setMission(mission)
      return `Mission ${mission ? "set to: " + mission : "cleared"}`
    }
    case "present_set_status": {
      const { status } = args as { status: string | null }
      await storage.present.setStatus(status)
      return `Status ${status ? "set to: " + status : "cleared"}`
    }
    case "present_update_tasks": {
      const { tasks } = args as { tasks: Task[] }
      await storage.present.setTasks(tasks)
      return `Tasks updated (${tasks.length} tasks)`
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

/**
 * Run the main agent loop.
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { storage, onEvent } = options
  const sessionId = Identifier.ascending("session")

  // Get the model
  const model = Provider.getModelForTier("reasoning")

  // Build system prompt
  const { prompt: systemPrompt } = await buildSystemPrompt(storage)

  // Build tools
  const tools = buildTools()

  // Initialize messages with user prompt
  const messages: CoreMessage[] = [
    { role: "user", content: prompt },
  ]

  // Log user message to temporal
  const userMessageId = Identifier.ascending("message")
  await storage.temporal.appendMessage({
    id: userMessageId,
    type: "user",
    content: prompt,
    tokenEstimate: estimateTokens(prompt),
    createdAt: new Date().toISOString(),
  })

  onEvent?.({ type: "user", content: prompt })

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let finalResponse = ""

  // Agent loop
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const result = await Provider.generate({
      model,
      system: systemPrompt,
      messages,
      tools,
      maxTokens: 8192,
    })

    totalInputTokens += result.usage.promptTokens
    totalOutputTokens += result.usage.completionTokens

    // Handle text response
    if (result.text) {
      finalResponse = result.text

      // Log to temporal
      const assistantMessageId = Identifier.ascending("message")
      await storage.temporal.appendMessage({
        id: assistantMessageId,
        type: "assistant",
        content: result.text,
        tokenEstimate: estimateTokens(result.text),
        createdAt: new Date().toISOString(),
      })

      onEvent?.({ type: "assistant", content: result.text })
    }

    // Handle tool calls
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Build assistant message with tool calls
      const assistantParts: (TextPart | ToolCallPart)[] = []

      if (result.text) {
        assistantParts.push({ type: "text", text: result.text })
      }

      const toolResultParts: ToolResultPart[] = []

      for (const toolCall of result.toolCalls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        })

        // Log tool call to temporal
        const toolCallMsgId = Identifier.ascending("message")
        await storage.temporal.appendMessage({
          id: toolCallMsgId,
          type: "tool_call",
          content: JSON.stringify({ name: toolCall.toolName, args: toolCall.args }),
          tokenEstimate: estimateTokens(JSON.stringify(toolCall.args)),
          createdAt: new Date().toISOString(),
        })

        onEvent?.({
          type: "tool_call",
          content: `${toolCall.toolName}(${JSON.stringify(toolCall.args).slice(0, 100)}...)`,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        })

        // Execute tool
        let toolResult: string
        try {
          toolResult = await executeTool(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            storage,
            sessionId,
            userMessageId,
            toolCall.toolCallId,
          )
        } catch (error) {
          toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`
          onEvent?.({ type: "error", content: toolResult })
        }

        // Log tool result to temporal
        const toolResultMsgId = Identifier.ascending("message")
        await storage.temporal.appendMessage({
          id: toolResultMsgId,
          type: "tool_result",
          content: toolResult,
          tokenEstimate: estimateTokens(toolResult),
          createdAt: new Date().toISOString(),
        })

        onEvent?.({
          type: "tool_result",
          content: toolResult.slice(0, 200) + (toolResult.length > 200 ? "..." : ""),
          toolCallId: toolCall.toolCallId,
        })

        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: toolResult,
        })
      }

      // Add assistant message with tool calls
      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: assistantParts,
      }
      messages.push(assistantMsg)

      // Add tool results
      const toolMsg: CoreToolMessage = {
        role: "tool",
        content: toolResultParts,
      }
      messages.push(toolMsg)

      // Continue the loop for more turns
      continue
    }

    // No tool calls - we're done
    if (result.text) {
      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: result.text,
      }
      messages.push(assistantMsg)
    }
    break
  }

  onEvent?.({ type: "done", content: finalResponse })

  return {
    response: finalResponse,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  }
}
