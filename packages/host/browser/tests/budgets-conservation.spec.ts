/**
 * Budget conservation (2026-10-23 D3): every product latency lives in
 * `budgets.ts` and the relations between them are asserted here, so changing a
 * literal or a formula somewhere else makes a test fail.
 */
import { describe, expect, it } from 'vitest'
import {
  BROWSER_DOWNLOAD_TOOL_TIMEOUT_MS,
  BROWSER_PROGRAM_TOOL_TIMEOUT_MS,
  BROWSER_TOOL_TIMEOUT_MS,
  BROWSER_WAIT_FOR_DEADLINE_MS,
  DOWNLOAD_COMPLETION_TIMEOUT_MS,
  EXPECT_TIMEOUT_MAX_MS,
  FRAME_INDEX_LEG_MS,
  NAVIGATE_LOAD_BOUND_MS,
  PROGRAM_SCRIPT_BUDGET_MS,
  TAB_SLOT_WAIT_TIMEOUT_MS,
  TOOL_DEADLINE_MARGIN_MS,
  USER_GATE_TIMEOUT_MS,
  WAIT_FOR_MAX_MS,
} from '../src/budgets.ts'

describe('budget conservation', () => {
  it('registration budget covers user gate + slot wait + margin', () => {
    expect(BROWSER_TOOL_TIMEOUT_MS).toBeGreaterThan(USER_GATE_TIMEOUT_MS)
    expect(USER_GATE_TIMEOUT_MS + TAB_SLOT_WAIT_TIMEOUT_MS + TOOL_DEADLINE_MARGIN_MS)
      .toBeLessThanOrEqual(BROWSER_TOOL_TIMEOUT_MS)
  })

  it('the wait_for deadline is derived, never a literal', () => {
    expect(BROWSER_WAIT_FOR_DEADLINE_MS).toBe(USER_GATE_TIMEOUT_MS + WAIT_FOR_MAX_MS + 5_000)
  })

  it('long-run tools keep their internal wait below the registered budget', () => {
    expect(BROWSER_DOWNLOAD_TOOL_TIMEOUT_MS).toBeGreaterThan(DOWNLOAD_COMPLETION_TIMEOUT_MS + TOOL_DEADLINE_MARGIN_MS)
    expect(BROWSER_PROGRAM_TOOL_TIMEOUT_MS).toBeGreaterThan(PROGRAM_SCRIPT_BUDGET_MS)
    expect(EXPECT_TIMEOUT_MAX_MS).toBeLessThan(BROWSER_TOOL_TIMEOUT_MS - USER_GATE_TIMEOUT_MS)
  })

  it('a single navigate/eval leg stays inside the tool budget', () => {
    expect(NAVIGATE_LOAD_BOUND_MS + USER_GATE_TIMEOUT_MS + TOOL_DEADLINE_MARGIN_MS)
      .toBeLessThanOrEqual(BROWSER_TOOL_TIMEOUT_MS)
    expect(FRAME_INDEX_LEG_MS).toBeLessThan(USER_GATE_TIMEOUT_MS)
  })
})
