/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/util/lazy.ts
 * License: MIT
 */

export function lazy<T>(fn: () => T) {
  let value: T | undefined
  let loaded = false

  const result = (): T => {
    if (loaded) return value as T
    loaded = true
    value = fn()
    return value as T
  }

  result.reset = () => {
    loaded = false
    value = undefined
  }

  return result
}
