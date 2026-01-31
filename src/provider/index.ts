/**
 * Provider integration for miriad-code.
 * Supports Anthropic, OpenAI/Codex, and OpenAI-compatible endpoints.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import {
  generateText,
  streamText,
  tool,
  InvalidToolArgumentsError,
  NoSuchToolError,
  type CoreMessage,
  type CoreTool,
  type LanguageModel,
  type StreamTextResult,
  type GenerateTextResult,
  type ToolSet,
} from "ai"
import { z } from "zod"
import { Config } from "../config"
import { Log } from "../util/log"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  export interface ProviderCapabilities {
    supportsSystemPromptCache: boolean
    supportsMessageCacheMarkers: boolean
    supportsCacheUsageMetadata: boolean
  }

  type ProviderFactory = (modelId: string) => LanguageModel
  type ProviderCreator = (config: Config.Config) => ProviderFactory

  const providerRegistry: Record<string, ProviderCreator> = {
    anthropic: createAnthropicProvider,
    openai: createOpenAIProvider,
    codex: createOpenAIProvider,
    "openai-compatible": createOpenAICompatibleProvider,
  }

  const providerCapabilities: Record<string, ProviderCapabilities> = {
    anthropic: {
      supportsSystemPromptCache: true,
      supportsMessageCacheMarkers: true,
      supportsCacheUsageMetadata: true,
    },
    openai: {
      supportsSystemPromptCache: false,
      supportsMessageCacheMarkers: false,
      supportsCacheUsageMetadata: false,
    },
    codex: {
      supportsSystemPromptCache: false,
      supportsMessageCacheMarkers: false,
      supportsCacheUsageMetadata: false,
    },
    "openai-compatible": {
      supportsSystemPromptCache: false,
      supportsMessageCacheMarkers: false,
      supportsCacheUsageMetadata: false,
    },
  }

  let cachedProvider: { key: string; provider: ProviderFactory } | null = null

  /**
   * Get a required API key from environment.
   */
  function getRequiredEnv(keyName: string, guidance: string): string {
    const key = process.env[keyName]
    if (!key) {
      throw new Error(
        `${keyName} environment variable is required.\n${guidance}`,
      )
    }
    return key
  }

  /**
   * Create an Anthropic provider instance.
   */
  function createAnthropicProvider(): ProviderFactory {
    return createAnthropic({
      apiKey: getRequiredEnv(
        "ANTHROPIC_API_KEY",
        "Set it with: export ANTHROPIC_API_KEY=sk-...",
      ),
      headers: {
        // Enable Claude Code beta features
        // - claude-code: Claude Code specific features
        // - interleaved-thinking: Extended thinking with interleaved output
        // - context-1m: 1M token context window for Sonnet
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
      },
    })
  }

  /**
   * Create an OpenAI/Codex provider instance.
   */
  function createOpenAIProvider(config: Config.Config): ProviderFactory {
    const providerConfig = config.providers.openai
    const apiKey = providerConfig.apiKey ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required.\n" +
          "Set it with: export OPENAI_API_KEY=sk-...",
      )
    }
    const baseURL =
      providerConfig.baseUrl ??
      process.env.OPENAI_BASE_URL ??
      process.env.LLM_BASE_URL
    return createOpenAI({
      apiKey,
      baseURL,
    })
  }

  /**
   * Create an OpenAI-compatible provider instance (local or alternative hosts).
   */
  function createOpenAICompatibleProvider(config: Config.Config): ProviderFactory {
    const providerConfig = config.providers.openaiCompatible
    const baseURL =
      providerConfig.baseUrl ??
      process.env.OPENAI_COMPATIBLE_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      process.env.LLM_BASE_URL

    if (!baseURL) {
      throw new Error(
        "OpenAI-compatible base URL is required via providers.openaiCompatible.baseUrl or " +
          "OPENAI_COMPATIBLE_BASE_URL/OPENAI_BASE_URL/LLM_BASE_URL.\n" +
          "Set it with: export OPENAI_COMPATIBLE_BASE_URL=http://localhost:8000/v1",
      )
    }

    const apiKey =
      providerConfig.apiKey ??
      process.env.OPENAI_COMPATIBLE_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "no-key"

    if (apiKey === "no-key") {
      log.warn("openai-compatible provider missing API key; continuing without one")
    }

    return createOpenAI({
      apiKey,
      baseURL,
    })
  }

  /**
   * Create provider factory based on config.
   */
  function createProvider(config: Config.Config): ProviderFactory {
    const providerCreator = providerRegistry[config.provider]
    if (!providerCreator) {
      const available = Object.keys(providerRegistry).sort().join(", ")
      throw new Error(
        `Unsupported provider "${config.provider}". Available providers: ${available}`,
      )
    }
    return providerCreator(config)
  }

  function getProviderFactory(): ProviderFactory {
    const config = Config.get()
    if (cachedProvider?.key === config.provider) {
      return cachedProvider.provider
    }
    const provider = createProvider(config)
    cachedProvider = { key: config.provider, provider }
    return provider
  }

  export function getCapabilities(): ProviderCapabilities {
    const config = Config.get()
    return (
      providerCapabilities[config.provider] ?? {
        supportsSystemPromptCache: false,
        supportsMessageCacheMarkers: false,
        supportsCacheUsageMetadata: false,
      }
    )
  }

  /**
   * Get a language model for a given model ID.
   */
  export function getModel(modelId: string): LanguageModel {
    const provider = getProviderFactory()
    return provider(modelId)
  }

  /**
   * Get a language model for a given tier.
   */
  export function getModelForTier(tier: Config.ModelTier): LanguageModel {
    const modelId = getModelIdForTier(tier)
    log.debug("resolving model tier", { tier, modelId })
    return getModel(modelId)
  }

  /**
   * Get the configured model ID for a given tier.
   * This routes through the active provider configuration.
   */
  export function getModelIdForTier(tier: Config.ModelTier): string {
    const config = Config.get()
    assertProviderModelIdConfigured(config, tier)
    const modelIds = getEffectiveModelIds(config)
    const modelId = modelIds[tier]
    log.debug("resolved model ID for tier", { tier, modelId, provider: config.provider })
    return modelId
  }

  function assertProviderModelIdConfigured(
    config: Config.Config,
    tier: Config.ModelTier,
  ): void {
    if (config.provider === "openai" || config.provider === "codex") {
      const modelId = config.providers.openai.models[tier]
      if (!modelId) {
        const envVar = `OPENAI_MODEL_${tier.toUpperCase()}`
        throw new Error(
          `Missing OpenAI model ID for "${tier}" tier. ` +
            `Set ${envVar} (or providers.openai.models.${tier}) when AGENT_PROVIDER is "${config.provider}".`,
        )
      }
    }

    if (config.provider === "openai-compatible") {
      const modelId = config.providers.openaiCompatible.models[tier]
      if (!modelId) {
        const envVar = `OPENAI_COMPAT_MODEL_${tier.toUpperCase()}`
        throw new Error(
          `Missing OpenAI-compatible model ID for "${tier}" tier. ` +
            `Set ${envVar} (or providers.openaiCompatible.models.${tier}) when AGENT_PROVIDER is "openai-compatible".`,
        )
      }
    }
  }

  function getEffectiveModelIds(
    config: Config.Config,
  ): Record<Config.ModelTier, string> {
    let providerModels: Partial<Record<Config.ModelTier, string>> = {}

    if (config.provider === "openai" || config.provider === "codex") {
      providerModels = config.providers.openai.models
    } else if (config.provider === "openai-compatible") {
      providerModels = config.providers.openaiCompatible.models
    }

    return {
      reasoning: providerModels.reasoning ?? config.models.reasoning,
      workhorse: providerModels.workhorse ?? config.models.workhorse,
      fast: providerModels.fast ?? config.models.fast,
    }
  }

  /**
   * Options for text generation
   */
  export interface GenerateOptions {
    model: LanguageModel
    messages: CoreMessage[]
    tools?: Record<string, CoreTool>
    maxTokens?: number
    temperature?: number
    abortSignal?: AbortSignal
    system?: string
    /** Enable Anthropic prompt caching for the system prompt */
    cacheSystemPrompt?: boolean
  }

  /**
   * Internal tool name for surfacing validation errors to the model.
   * This tool is added to every tool set and used by repairToolCall
   * to redirect invalid tool calls.
   */
  const INVALID_TOOL_CALL = "__invalid_tool_call__"

  /**
   * Create the internal error tool that surfaces validation errors.
   * The tool result includes what the agent tried to do so they can fix it.
   */
  function createInvalidToolCallTool(): CoreTool {
    return tool({
      description: "Internal tool - surfaces validation errors for invalid tool calls",
      parameters: z.object({
        toolName: z.string().describe("The tool that was called"),
        args: z.string().describe("The arguments that were provided (as JSON)"),
        error: z.string().describe("The validation error message"),
      }),
      execute: async ({ toolName, args, error }) => {
        return `Error: Invalid tool call to "${toolName}"

You provided these arguments:
${args}

Validation error:
${error}

Please check the tool's parameter schema and try again with correct arguments.`
      },
    })
  }

  /**
   * Create a repair function that redirects invalid tool calls to our error tool.
   * 
   * When the model makes a tool call with invalid arguments, instead of crashing
   * the turn, we redirect to __invalid_tool_call__ which returns the error as
   * a tool result. The model sees what it tried to do and can retry.
   */
  function createToolCallRepairFunction<TOOLS extends ToolSet>() {
    return async ({ toolCall, error }: {
      toolCall: { toolName: string; toolCallId: string; args: unknown }
      tools: TOOLS
      parameterSchema: (options: { toolName: string }) => unknown
      error: NoSuchToolError | InvalidToolArgumentsError
    }) => {
      const errorMessage = error.message || String(error)
      
      log.warn("invalid tool call - redirecting to error tool", {
        toolName: toolCall.toolName,
        error: errorMessage,
      })

      // Redirect to our error tool with full context
      // Note: args must be a stringified JSON per LanguageModelV1FunctionToolCall type
      return {
        toolCallType: "function" as const,
        toolName: INVALID_TOOL_CALL,
        toolCallId: toolCall.toolCallId,
        args: JSON.stringify({
          toolName: toolCall.toolName,
          args: JSON.stringify(toolCall.args, null, 2),
          error: errorMessage,
        }),
      }
    }
  }

  /**
   * Prepare messages with optional system prompt caching.
   * 
   * When cacheSystemPrompt is true, converts the system string to a system message
   * with Anthropic cache control. This enables prompt caching for the (typically large
   * and stable) system prompt.
   */
  function prepareMessages(
    messages: CoreMessage[],
    system: string | undefined,
    cacheSystemPrompt: boolean,
    supportsSystemPromptCache: boolean,
  ): { messages: CoreMessage[]; system: string | undefined } {
    if (!system) {
      return { messages, system: undefined }
    }

    if (!cacheSystemPrompt || !supportsSystemPromptCache) {
      // No caching - use the standard system parameter
      return { messages, system }
    }

    // With caching - convert system to a message with cache control
    // The AI SDK requires system prompts to be in the messages array to add providerOptions
    const systemMessage: CoreMessage = {
      role: "system",
      content: system,
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" }
        }
      }
    } as CoreMessage // Type assertion needed for providerOptions

    return {
      messages: [systemMessage, ...messages],
      system: undefined // Don't pass system separately when it's in messages
    }
  }

  /**
   * Add the invalid tool call handler and wrap tools for runtime error resilience.
   * 
   * This does two things:
   * 1. Adds __invalid_tool_call__ tool for surfacing validation errors
   * 2. Wraps each tool's execute to catch runtime errors
   */
  function prepareTools(
    tools: Record<string, CoreTool> | undefined
  ): Record<string, CoreTool> | undefined {
    if (!tools) return undefined

    const prepared: Record<string, CoreTool> = {
      // Add our error handling tool
      [INVALID_TOOL_CALL]: createInvalidToolCallTool(),
    }

    for (const [name, t] of Object.entries(tools)) {
      const originalExecute = t.execute

      if (!originalExecute) {
        // Tool without execute - pass through unchanged
        prepared[name] = t
        continue
      }

      prepared[name] = {
        ...t,
        // Keep original schema so model sees proper parameter documentation
        execute: async (args: unknown, context: unknown) => {
          try {
            return await originalExecute(args, context as Parameters<typeof originalExecute>[1])
          } catch (error) {
            // Return error as result instead of throwing
            const message = error instanceof Error ? error.message : String(error)
            log.warn("tool execution error - returning to model", {
              toolName: name,
              error: message,
            })
            return `Error executing tool "${name}": ${message}`
          }
        },
      }
    }

    return prepared
  }



  /**
   * Generate text without streaming.
   */
  export async function generate(options: GenerateOptions): Promise<GenerateTextResult<Record<string, CoreTool>, never>> {
    const config = Config.get()
    const providerKey = config.provider
    const capabilities = getCapabilities()
    const cacheSystemPrompt =
      capabilities.supportsSystemPromptCache && (options.cacheSystemPrompt ?? false)
    const { messages, system } = prepareMessages(
      options.messages,
      options.system,
      cacheSystemPrompt,
      capabilities.supportsSystemPromptCache,
    )

    log.debug("generate", {
      model: options.model.modelId,
      messageCount: messages.length,
      hasTools: !!options.tools,
      provider: providerKey,
      cacheSystemPrompt,
    })

    return generateText({
      model: options.model,
      messages,
      tools: prepareTools(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system,
      experimental_repairToolCall: createToolCallRepairFunction(),
    })
  }

  /**
   * Stream text generation.
   */
  export async function stream(
    options: GenerateOptions,
  ): Promise<StreamTextResult<Record<string, CoreTool>, never>> {
    const config = Config.get()
    const providerKey = config.provider
    const capabilities = getCapabilities()
    const cacheSystemPrompt =
      capabilities.supportsSystemPromptCache && (options.cacheSystemPrompt ?? false)
    const { messages, system } = prepareMessages(
      options.messages,
      options.system,
      cacheSystemPrompt,
      capabilities.supportsSystemPromptCache,
    )

    log.debug("stream", {
      model: options.model.modelId,
      messageCount: messages.length,
      hasTools: !!options.tools,
      provider: providerKey,
      cacheSystemPrompt,
    })

    return streamText({
      model: options.model,
      messages,
      tools: prepareTools(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system,
      experimental_repairToolCall: createToolCallRepairFunction(),
    })
  }

  /**
   * Tool definition schema for validation
   */
  export const ToolCallSchema = z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.unknown()),
  })
  export type ToolCall = z.infer<typeof ToolCallSchema>

  /**
   * Tool result schema for validation
   */
  export const ToolResultSchema = z.object({
    toolCallId: z.string(),
    result: z.unknown(),
  })
  export type ToolResult = z.infer<typeof ToolResultSchema>
}
