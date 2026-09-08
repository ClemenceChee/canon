/**
 * Unit tests for propose/scoring.ts (03 testing plan: "scoring: confidence
 * formula pinned at constant boundaries (min, caps, single-agent cap <= 0.5,
 * clamp 0.95); coverage counts; determinism (same input ⇒ same score)").
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORING_CONSTANTS } from '../../src/propose/scoring.constants.js';
import { candidateConfidence } from '../../src/propose/scoring.js';
import type { Coverage } from '../../src/store/proposals.js';

const CONSTANTS = DEFAULT_SCORING_CONSTANTS;

function coverage(partial: Partial<Coverage>): Coverage {
  return {
    traces: 5,
    observations: 10,
    agents: 1,
    sessions: 3,
    window: { from: '2025-08-01T00:00:00.000Z', to: '2025-08-31T00:00:00.000Z' },
    environments: ['production'],
    consistency: 1,
    ...partial,
  };
}

describe('candidateConfidence', () => {
  it('base confidence when support is exactly the floor and one agent', () => {
    expect(candidateConfidence('tool-choice', 4, coverage({ agents: 1, consistency: 1 }), false, CONSTANTS)).toBe(0.4);
  });

  it('per-trace bonus over the kind minimum, capped at +0.2', () => {
    // tool-choice floor 4: +0.05 per extra supporting trace (base 0.40)
    expect(candidateConfidence('tool-choice', 6, coverage({ agents: 1 }), false, CONSTANTS)).toBe(0.5);
    // the per-trace bonus itself is capped at +0.2: 24 supporting -> +0.2, and
    // a second agent adds its own +0.1 -> 0.40 + 0.20 + 0.10
    expect(candidateConfidence('tool-choice', 4 + 20, coverage({ agents: 2 }), false, CONSTANTS)).toBe(0.7);
  });

  it('per-agent bonus for additional agents over 1, capped at +0.3', () => {
    const two = coverage({ agents: 2 });
    expect(candidateConfidence('tool-choice', 4, two, false, CONSTANTS)).toBe(0.4 + 0.1);
    const many = coverage({ agents: 5 });
    expect(candidateConfidence('tool-choice', 4, many, false, CONSTANTS)).toBe(0.4 + 0.3);
  });

  it('score corroboration adds +0.05', () => {
    expect(candidateConfidence('tool-choice', 4, coverage({ agents: 1 }), true, CONSTANTS)).toBe(0.45);
  });

  it('single-agent proposals are capped at the single-agent cap (0.5)', () => {
    // side-effect-retry floor 5 with 7 supporting would score 0.60 without the cap
    expect(candidateConfidence('side-effect-retry', 7, coverage({ agents: 1 }), true, CONSTANTS)).toBe(0.5);
    // multi-agent side-effect retry clears the cap
    expect(candidateConfidence('side-effect-retry', 7, coverage({ agents: 2 }), true, CONSTANTS)).toBe(
      Math.round((0.45 + 0.1 + 0.1 + 0.05) * 10000) / 10000,
    );
  });

  it('global cap clamps at 0.95 and confidence never goes negative', () => {
    expect(candidateConfidence('retry-budget', 50, coverage({ agents: 5 }), true, CONSTANTS)).toBe(0.95);
  });

  it('is deterministic: identical inputs produce identical scores', () => {
    const a = candidateConfidence('model-usage', 9, coverage({ agents: 1 }), true, CONSTANTS);
    const b = candidateConfidence('model-usage', 9, coverage({ agents: 1 }), true, CONSTANTS);
    expect(a).toBe(b);
  });

  it('model-usage floor 8: 9 supporting + corrob scores 0.45 (base 0.35 + 0.05 + 0.05)', () => {
    expect(candidateConfidence('model-usage', 9, coverage({ agents: 1 }), true, CONSTANTS)).toBe(0.45);
  });
});
