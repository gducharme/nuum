/**
 * MCP (Model Context Protocol) client support
 *
 * Provides stdio and streamable-http transports for connecting to MCP servers.
 * Uses Claude-compatible config format for easy migration.
 *
 * Config loaded from:
 * 1. MIRIAD_MCP_CONFIG env var (JSON string)
 * 2. ~/.config/miriad/code.json file
 */

import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { tool } from "ai"
import { jsonSchema } from "ai"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

export namespace Mcp {
  // ============================================================================
  // Config Schema (Claude-compatible)
  // ============================================================================

  /**
   * Stdio server config - spawns a local process
   */
  export const StdioServerSchema = z.object({
    type: z.literal("stdio").optional().default("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    enabled: z.boolean().optional().default(true),
    timeout: z.number().optional().default(30000),
  })
  export type StdioServer = z.infer<typeof StdioServerSchema>

  /**
   * HTTP server config - connects to remote server via streamable-http or SSE
   */
  export const HttpServerSchema = z.object({
    type: z.enum(["http", "sse"]),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    enabled: z.boolean().optional().default(true),
    timeout: z.number().optional().default(30000),
  })
  export type HttpServer = z.infer<typeof HttpServerSchema>

  /**
   * Union of all server types
   */
  export const ServerSchema = z.union([StdioServerSchema, HttpServerSchema])
  export type Server = z.infer<typeof ServerSchema>

  /**
   * Full MCP config - map of server name to config
   */
  export const ConfigSchema = z.object({
    mcpServers: z.record(ServerSchema).optional().default({}),
  })
  export type Config = z.infer<typeof ConfigSchema>

  // ============================================================================
  // Config Loading
  // ============================================================================

  const CONFIG_FILE_PATH = path.join(os.homedir(), ".config", "miriad", "code.json")
  const CONFIG_ENV_VAR = "MIRIAD_MCP_CONFIG"

  /**
   * Load MCP config from env var or file
   * Priority: env var > file
   */
  export function loadConfig(): Config {
    // Try env var first
    const envConfig = process.env[CONFIG_ENV_VAR]
    if (envConfig) {
      try {
        const parsed = JSON.parse(envConfig)
        return ConfigSchema.parse(parsed)
      } catch (e) {
        console.error(`Failed to parse ${CONFIG_ENV_VAR}:`, e)
      }
    }

    // Try config file
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      try {
        const content = fs.readFileSync(CONFIG_FILE_PATH, "utf-8")
        const parsed = JSON.parse(content)
        return ConfigSchema.parse(parsed)
      } catch (e) {
        console.error(`Failed to parse ${CONFIG_FILE_PATH}:`, e)
      }
    }

    // Return empty config
    return { mcpServers: {} }
  }

  // ============================================================================
  // Client Management
  // ============================================================================

  interface ConnectedServer {
    name: string
    config: Server
    client: Client
    tools: Tool[]
    status: "connected" | "failed" | "disabled"
    error?: string
  }

  let connectedServers: Map<string, ConnectedServer> = new Map()

  /**
   * Create transport for a server config
   */
  function createTransport(config: Server) {
    if (config.type === "stdio" || !("url" in config)) {
      const stdioConfig = config as StdioServer
      return new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args,
        env: stdioConfig.env,
        cwd: stdioConfig.cwd,
        stderr: "pipe", // Capture stderr for logging
      })
    } else if (config.type === "http") {
      const httpConfig = config as HttpServer
      return new StreamableHTTPClientTransport(new URL(httpConfig.url), {
        requestInit: httpConfig.headers ? { headers: httpConfig.headers } : undefined,
      })
    } else if (config.type === "sse") {
      const sseConfig = config as HttpServer
      return new SSEClientTransport(new URL(sseConfig.url), {
        requestInit: sseConfig.headers ? { headers: sseConfig.headers } : undefined,
      })
    }
    throw new Error(`Unknown server type: ${(config as { type?: string }).type}`)
  }

  /**
   * Connect to a single MCP server
   */
  async function connectServer(name: string, config: Server): Promise<ConnectedServer> {
    if (!config.enabled) {
      return {
        name,
        config,
        client: null as unknown as Client,
        tools: [],
        status: "disabled",
      }
    }

    const client = new Client(
      { name: "miriad-code", version: "0.1.0" },
      { capabilities: {} },
    )

    try {
      const transport = createTransport(config)

      // Set up stderr logging for stdio transports
      if (transport instanceof StdioClientTransport && transport.stderr) {
        transport.stderr.on("data", (chunk: Buffer) => {
          console.error(`[mcp:${name}] ${chunk.toString().trim()}`)
        })
      }

      // Connect with timeout
      const timeoutMs = config.timeout ?? 30000
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Connection timeout")), timeoutMs),
        ),
      ])

      // Get available tools
      const toolsResult = await client.listTools()
      const tools = toolsResult.tools

      console.error(`[mcp:${name}] Connected, ${tools.length} tools available`)

      return {
        name,
        config,
        client,
        tools,
        status: "connected",
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error(`[mcp:${name}] Failed to connect: ${error}`)
      return {
        name,
        config,
        client,
        tools: [],
        status: "failed",
        error,
      }
    }
  }

  /**
   * Initialize all MCP servers from config
   */
  export async function initialize(config?: Config): Promise<void> {
    const mcpConfig = config ?? loadConfig()

    // Close any existing connections
    await shutdown()

    // Connect to all servers in parallel
    const entries = Object.entries(mcpConfig.mcpServers)
    const results = await Promise.all(
      entries.map(([name, serverConfig]) => connectServer(name, serverConfig)),
    )

    // Store connected servers
    for (const server of results) {
      connectedServers.set(server.name, server)
    }

    const connected = results.filter((s) => s.status === "connected").length
    const failed = results.filter((s) => s.status === "failed").length
    const disabled = results.filter((s) => s.status === "disabled").length

    if (entries.length > 0) {
      console.error(
        `[mcp] Initialized: ${connected} connected, ${failed} failed, ${disabled} disabled`,
      )
    }
  }

  /**
   * Shutdown all MCP connections
   */
  export async function shutdown(): Promise<void> {
    for (const [name, server] of connectedServers) {
      if (server.status === "connected") {
        try {
          await server.client.close()
          console.error(`[mcp:${name}] Disconnected`)
        } catch {
          // Ignore close errors
        }
      }
    }
    connectedServers.clear()
  }

  /**
   * Get status of all servers
   */
  export function getStatus(): Array<{
    name: string
    status: string
    toolCount: number
    error?: string
  }> {
    return Array.from(connectedServers.values()).map((s) => ({
      name: s.name,
      status: s.status,
      toolCount: s.tools.length,
      error: s.error,
    }))
  }

  // ============================================================================
  // Tool Integration
  // ============================================================================

  /**
   * Convert MCP tool to AI SDK tool format
   */
  function convertMcpTool(
    serverName: string,
    mcpTool: Tool,
    client: Client,
  ): ReturnType<typeof tool> {
    return tool({
      description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
      parameters: jsonSchema(mcpTool.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (args) => {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: args as Record<string, unknown>,
        })

        // Extract text content from result
        if ("content" in result && Array.isArray(result.content)) {
          const textParts = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
          return textParts.join("\n")
        }

        // Fallback to JSON stringification
        return JSON.stringify(result)
      },
    })
  }

  /**
   * Get all MCP tools as AI SDK tools
   * Tool names are prefixed with server name: "serverName__toolName"
   */
  export function getTools(): Record<string, ReturnType<typeof tool>> {
    const tools: Record<string, ReturnType<typeof tool>> = {}

    for (const [serverName, server] of connectedServers) {
      if (server.status !== "connected") continue

      for (const mcpTool of server.tools) {
        const toolName = `${serverName}__${mcpTool.name}`
        tools[toolName] = convertMcpTool(serverName, mcpTool, server.client)
      }
    }

    return tools
  }

  /**
   * Get list of all available MCP tool names
   */
  export function getToolNames(): string[] {
    return Object.keys(getTools())
  }
}
