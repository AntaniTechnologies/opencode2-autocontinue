import type { SessionState } from "./types.js"

export function createSessionStateStore() {
  const states = new Map<string, SessionState>()

  function getState(sessionID: string): SessionState {
    const existing = states.get(sessionID)
    if (existing) return existing

    const created: SessionState = {
      lastInjectedAt: undefined,
      consecutiveCount: 0,
      lastAssistantMessageId: undefined,
      inFlight: false,
      deferredTimer: undefined,
    }
    states.set(sessionID, created)
    return created
  }

  function cleanup(sessionID: string): void {
    const state = states.get(sessionID)
    if (state?.deferredTimer) clearTimeout(state.deferredTimer)
    states.delete(sessionID)
  }

  function resetConsecutive(sessionID: string): void {
    const state = states.get(sessionID)
    if (state) {
      state.consecutiveCount = 0
    }
  }

  function dispose(): void {
    for (const state of states.values()) {
      if (state.deferredTimer) clearTimeout(state.deferredTimer)
    }
    states.clear()
  }

  return { getState, cleanup, resetConsecutive, dispose }
}

export type SessionStateStore = ReturnType<typeof createSessionStateStore>
