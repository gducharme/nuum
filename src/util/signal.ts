/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/util/signal.ts
 * License: MIT
 */

export function signal() {
  let resolve: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return {
    trigger() {
      return resolve()
    },
    wait() {
      return promise
    },
  }
}
