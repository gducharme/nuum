const CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function truncateToTokenBudget(text: string, budget: number): string {
  if (!Number.isFinite(budget) || budget <= 0) {
    return ""
  }

  const maxChars = Math.max(0, Math.floor(budget * CHARS_PER_TOKEN))
  if (text.length <= maxChars) {
    return text
  }

  if (maxChars <= 1) {
    return "…"
  }

  return `${text.slice(0, maxChars - 1)}…`
}

export function applyTokenBudgetToBlocks(
  blocks: string[],
  budget?: number,
): { blocks: string[]; truncated: boolean } {
  if (!Number.isFinite(budget)) {
    return { blocks, truncated: false }
  }

  if (budget <= 0) {
    return { blocks: [], truncated: blocks.length > 0 }
  }

  let totalTokens = 0
  const selected: string[] = []
  for (const block of blocks) {
    const blockTokens = estimateTokens(block)
    if (selected.length === 0 && blockTokens > budget) {
      return {
        blocks: [truncateToTokenBudget(block, budget)],
        truncated: true,
      }
    }

    if (totalTokens + blockTokens > budget) {
      break
    }

    selected.push(block)
    totalTokens += blockTokens
  }

  return {
    blocks: selected,
    truncated: selected.length < blocks.length,
  }
}

export function applyTokenBudgetToContextBlocks(
  blocks: string[],
  targetIndex: number,
  budget?: number,
): { blocks: string[]; truncated: boolean } {
  if (!Number.isFinite(budget)) {
    return { blocks, truncated: false }
  }

  if (budget <= 0) {
    return { blocks: [], truncated: blocks.length > 0 }
  }

  if (targetIndex < 0 || targetIndex >= blocks.length) {
    return { blocks: [], truncated: blocks.length > 0 }
  }

  const blockTokens = blocks.map((block) => estimateTokens(block))
  if (blockTokens[targetIndex] > budget) {
    return {
      blocks: [truncateToTokenBudget(blocks[targetIndex], budget)],
      truncated: true,
    }
  }

  const selected = new Set<number>()
  let totalTokens = 0
  const tryAdd = (index: number): boolean => {
    if (index < 0 || index >= blocks.length || selected.has(index)) {
      return false
    }

    const tokens = blockTokens[index]
    if (totalTokens + tokens > budget) {
      return false
    }

    selected.add(index)
    totalTokens += tokens
    return true
  }

  tryAdd(targetIndex)

  let left = targetIndex - 1
  let right = targetIndex + 1
  while (left >= 0 || right < blocks.length) {
    let added = false
    if (left >= 0) {
      added = tryAdd(left) || added
    }
    if (right < blocks.length) {
      added = tryAdd(right) || added
    }
    if (!added) {
      break
    }
    left -= 1
    right += 1
  }

  const ordered = Array.from(selected)
    .sort((a, b) => a - b)
    .map((index) => blocks[index])

  return {
    blocks: ordered,
    truncated: ordered.length < blocks.length,
  }
}
