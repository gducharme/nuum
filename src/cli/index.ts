#!/usr/bin/env node
/**
 * miriad-code CLI entry point
 *
 * Phase 1 deliverable: `miriad-code -p "prompt" --verbose`
 */

import { parseArgs } from "util"
import { runBatch } from "./batch"

interface CliOptions {
  prompt: string | undefined
  verbose: boolean
  db: string
  format: "text" | "json"
  help: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
      db: { type: "string", default: "./agent.db" },
      format: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  })

  return {
    prompt: values.prompt,
    verbose: values.verbose ?? false,
    db: values.db ?? "./agent.db",
    format: (values.format as "text" | "json") ?? "text",
    help: values.help ?? false,
  }
}

function printHelp(): void {
  console.log(`
miriad-code - A coding agent with persistent memory

Usage:
  miriad-code -p "prompt"           Run agent with a prompt
  miriad-code -p "prompt" --verbose Show debug output
  miriad-code --help                Show this help

Options:
  -p, --prompt <text>   The prompt to send to the agent (required)
  -v, --verbose         Show memory state, token usage, and execution trace
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show this help message

Examples:
  miriad-code -p "What files are in src/"
  miriad-code -p "Refactor the auth module" --verbose
  miriad-code -p "List todos" --format=json
`)
}

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  if (!options.prompt) {
    console.error("Error: --prompt (-p) is required")
    console.error("Run with --help for usage information")
    process.exit(1)
  }

  try {
    await runBatch({
      prompt: options.prompt,
      verbose: options.verbose,
      dbPath: options.db,
      format: options.format,
    })
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
      if (options.verbose && error.stack) {
        console.error(error.stack)
      }
    } else {
      console.error("Unknown error:", error)
    }
    process.exit(1)
  }
}

main()
