/**
 * Channel → the production delivery the surface gate hashes itself.
 *
 * The gate must never take delivered bytes from the evidence file, because an
 * evidence file that returns its own golden proves nothing about the plugin: it can
 * return `'x'.repeat(64)` and satisfy its own hash. This map lives beside the gate,
 * so claiming a channel here is a deliberate change to the gate, and a fabricated
 * channel in test/prompt-surface-lanes.js fails the "the evidence file must not
 * supply delivery" assertion instead of passing quietly.
 *
 * Every entry must exercise the production composer for that channel. For the plan
 * channel that is `deliverPlan()`, the same composition the plugin runs at session
 * preparation; the gate hashes its return value and never formats anything itself.
 */
import { deliverPlan } from './prompt-surface-plan-lane.js'

export const PROMPT_SURFACE_COMPOSERS = Object.freeze({
  plan: async () => {
    const delivery = await deliverPlan()
    try {
      return delivery.text
    } finally {
      delivery.env.dispose()
    }
  },
})
