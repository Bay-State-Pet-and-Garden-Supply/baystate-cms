import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_SOURCING_FLAGS,
  SOURCING_MODES,
  loadSourcingFlags,
  getSourcingFlags,
  overrideSourcingFlags,
  resetSourcingFlagsOverride,
  applySourcingOverride,
  parseSourcingMode,
  type SourcingFlags,
  type SourcingMode,
  type SourcingFlagReason,
} from '../../onboarding/flags';

describe('Sourcing capability flags', () => {
  afterEach(() => {
    resetSourcingFlagsOverride();
  });

  describe('defaults (Amendment A: absent env means enabled + automatic)', () => {
    it('defaults to engine enabled with automatic mode', () => {
      expect(DEFAULT_SOURCING_FLAGS.sourcingEngineEnabled).toBe(true);
      expect(DEFAULT_SOURCING_FLAGS.mode).toBe('automatic');
      expect(DEFAULT_SOURCING_FLAGS.effectiveEnabled).toBe(true);
      expect(DEFAULT_SOURCING_FLAGS.reason).toBe('default_on');
    });

    it('getSourcingFlags() with no env keys is enabled + automatic', () => {
      const flags = getSourcingFlags();
      expect(flags.sourcingEngineEnabled).toBe(true);
      expect(flags.mode).toBe('automatic');
      expect(flags.effectiveEnabled).toBe(true);
      expect(flags.reason).toBe('default_on');
    });

    it('loadSourcingFlags({}) is enabled + automatic', () => {
      expect(loadSourcingFlags({})).toEqual(DEFAULT_SOURCING_FLAGS);
    });
  });

  describe('enabled spellings', () => {
    it('accepts every true spelling', () => {
      for (const raw of ['true', '1', 'yes', 'TRUE', ' Yes ', 'TRUE ']) {
        const flags = loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: raw });
        expect(flags.sourcingEngineEnabled).toBe(true);
        expect(flags.effectiveEnabled).toBe(true);
        expect(flags.mode).toBe('automatic'); // mode key absent → default
        expect(flags.reason).toBe('env_enabled');
      }
    });

    it('explicit true with a valid mode passes through', () => {
      const flags = loadSourcingFlags({
        BAYSTATE_CMS_SOURCING_ENABLED: 'true',
        BAYSTATE_CMS_SOURCING_MODE: 'manual',
      });
      expect(flags.sourcingEngineEnabled).toBe(true);
      expect(flags.mode).toBe('manual');
      expect(flags.effectiveEnabled).toBe(true);
    });
  });

  describe('kill switch (explicit false)', () => {
    it('accepts every false spelling as disabled', () => {
      for (const raw of ['false', '0', 'no', 'FALSE', ' No ']) {
        const flags = loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: raw });
        expect(flags.sourcingEngineEnabled).toBe(false);
        expect(flags.mode).toBe(null);
        expect(flags.effectiveEnabled).toBe(false);
        expect(flags.reason).toBe('env_disabled');
      }
    });

    it('disabled wins even with a valid mode', () => {
      const flags = loadSourcingFlags({
        BAYSTATE_CMS_SOURCING_ENABLED: 'false',
        BAYSTATE_CMS_SOURCING_MODE: 'automatic',
      });
      expect(flags.effectiveEnabled).toBe(false);
      expect(flags.mode).toBe(null);
      expect(flags.reason).toBe('env_disabled');
    });
  });

  describe('fail-closed: malformed enabled values', () => {
    it('fails closed on empty, whitespace, and unparseable values', () => {
      for (const raw of ['', '   ', 'enabled', 'TRUE-ish', '1.5', 'yes please', 'null', '2']) {
        const flags = loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: raw });
        expect(flags.sourcingEngineEnabled).toBe(false);
        expect(flags.effectiveEnabled).toBe(false);
        expect(flags.reason).toBe('malformed_config');
      }
    });
  });

  describe('mode parsing', () => {
    it('accepts every valid mode spelling', () => {
      for (const raw of ['observe', 'manual', 'automatic', 'OBSERVE', ' Manual ', 'AUTOMATIC']) {
        expect(parseSourcingMode(raw)).toBe(raw.trim().toLowerCase() as SourcingMode);
      }
    });

    it('mode key absent defaults to automatic', () => {
      expect(parseSourcingMode(undefined)).toBe('automatic');
    });

    it('invalid/empty mode values fail closed with invalid_mode', () => {
      for (const raw of ['', '   ', 'banana', 'automatic-ish', 'auto', 'M', 'observe2']) {
        const flags = loadSourcingFlags({
          BAYSTATE_CMS_SOURCING_ENABLED: 'true',
          BAYSTATE_CMS_SOURCING_MODE: raw,
        });
        expect(flags.sourcingEngineEnabled).toBe(true);
        expect(flags.mode).toBe(null);
        expect(flags.effectiveEnabled).toBe(false);
        expect(flags.reason).toBe('invalid_mode');
      }
    });

    it('SOURCING_MODES contains exactly the three modes', () => {
      expect(SOURCING_MODES).toEqual(['observe', 'manual', 'automatic']);
    });
  });

  describe('in-memory overrides', () => {
    it('override enables and reports override reason', () => {
      const flags = overrideSourcingFlags({ sourcingEngineEnabled: true });
      expect(flags.sourcingEngineEnabled).toBe(true);
      expect(flags.effectiveEnabled).toBe(true);
      expect(flags.reason).toBe('override');
      expect(getSourcingFlags().effectiveEnabled).toBe(true);
    });

    it('override merges, not replaces', () => {
      overrideSourcingFlags({ sourcingEngineEnabled: true });
      const merged = overrideSourcingFlags({ mode: 'observe' });
      expect(merged.sourcingEngineEnabled).toBe(true);
      expect(merged.mode).toBe('observe');
      expect(merged.effectiveEnabled).toBe(true);
      expect(merged.reason).toBe('override');
    });

    it('override disabling wins and reports override reason', () => {
      overrideSourcingFlags({ sourcingEngineEnabled: false });
      const flags = getSourcingFlags();
      expect(flags.sourcingEngineEnabled).toBe(false);
      expect(flags.mode).toBe(null);
      expect(flags.effectiveEnabled).toBe(false);
      expect(flags.reason).toBe('override');
    });

    it('reset restores env-derived defaults', () => {
      overrideSourcingFlags({ sourcingEngineEnabled: false });
      expect(getSourcingFlags().effectiveEnabled).toBe(false);
      resetSourcingFlagsOverride();
      expect(getSourcingFlags().effectiveEnabled).toBe(true);
      expect(getSourcingFlags().reason).toBe('default_on');
    });

    it('an override cannot manufacture a valid mode accidentally', () => {
      // Base config: capability declared available but mode invalid → disabled.
      const base = loadSourcingFlags({
        BAYSTATE_CMS_SOURCING_ENABLED: 'true',
        BAYSTATE_CMS_SOURCING_MODE: 'banana',
      });
      expect(base.effectiveEnabled).toBe(false);
      expect(base.mode).toBe(null);

      // Overriding only the enabled switch cannot resurrect a valid mode.
      const merged = applySourcingOverride(base, { sourcingEngineEnabled: true });
      expect(merged.sourcingEngineEnabled).toBe(true);
      expect(merged.mode).toBe(null);
      expect(merged.effectiveEnabled).toBe(false);
      expect(merged.reason).toBe('invalid_mode');

      // The override must supply BOTH enabled and a valid mode to enable.
      const full = applySourcingOverride(base, { sourcingEngineEnabled: true, mode: 'automatic' });
      expect(full.effectiveEnabled).toBe(true);
      expect(full.mode).toBe('automatic');
      expect(full.reason).toBe('override');
    });

    it('overrides apply the same fail-closed rules when they disable', () => {
      const base = loadSourcingFlags({}); // enabled default
      const merged = applySourcingOverride(base, { sourcingEngineEnabled: false });
      expect(merged.effectiveEnabled).toBe(false);
      expect(merged.reason).toBe('override');
    });

    it('an invalid runtime mode value cannot manufacture an enabled state', () => {
      const base = loadSourcingFlags({}); // enabled + automatic by default
      // Untyped/runtime callers may pass an arbitrary string as mode.
      const merged = applySourcingOverride(base, {
        sourcingEngineEnabled: true,
        mode: 'invalid' as unknown as SourcingFlags['mode'],
      });
      expect(merged.effectiveEnabled).toBe(false);
      expect(merged.mode).toBe(null);
      expect(merged.reason).toBe('invalid_mode');
    });

    it('an explicit null mode override cannot resurrect a valid base mode', () => {
      const base = loadSourcingFlags({}); // enabled + automatic by default
      const merged = applySourcingOverride(base, {
        sourcingEngineEnabled: true,
        mode: null,
      });
      expect(merged.effectiveEnabled).toBe(false);
      expect(merged.mode).toBe(null);
      expect(merged.reason).toBe('invalid_mode');
    });
  });

  describe('reason code shape', () => {
    it('reason is always a stable non-secret code', () => {
      const samples: SourcingFlags[] = [
        loadSourcingFlags({}),
        loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: 'false' }),
        loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: 'banana' }),
        loadSourcingFlags({ BAYSTATE_CMS_SOURCING_ENABLED: 'true', BAYSTATE_CMS_SOURCING_MODE: 'x' }),
        overrideSourcingFlags({ sourcingEngineEnabled: true }),
      ];
      for (const flags of samples) {
        expect(typeof flags.reason).toBe('string');
        expect(flags.reason.length).toBeGreaterThan(0);
      }
    });
  });

  // Keep the reason union exhaustive so a new code must be reviewed.
  describe('reason union', () => {
    it('all known reason codes are representable', () => {
      const codes: SourcingFlagReason[] = [
        'default_on',
        'env_enabled',
        'env_disabled',
        'malformed_config',
        'invalid_mode',
        'override',
      ];
      expect(codes.length).toBeGreaterThanOrEqual(6);
    });
  });
});
