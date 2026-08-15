import { describe, it, expect } from 'vitest';
import {
  STORE_MANAGER_TOOL_DISPLAY,
  approvalCardCopy,
  deniedOutcomeText,
  approvedAwaitingExecutionText,
  STORE_MANAGER_STATE_TERMS,
  STORE_MANAGER_RISK_LABELS,
} from '../../client/store-manager-logic';
// Pure module (no server/node imports) — used as ground truth so the client
// display map cannot drift from the enforcement registry.
import { STORE_MANAGER_TOOL_POLICIES } from '../../server/services/store-manager-tool-policy';

describe('Store Manager client logic (epic #42, #34)', () => {
  it('client display map covers every server policy tool with matching risk and approval', () => {
    const serverNames = Object.keys(STORE_MANAGER_TOOL_POLICIES);
    expect(serverNames.length).toBeGreaterThan(0);
    for (const name of serverNames) {
      const serverPolicy = STORE_MANAGER_TOOL_POLICIES[name];
      const display = STORE_MANAGER_TOOL_DISPLAY[name];
      expect(display, `client display missing for "${name}"`).toBeDefined();
      expect(display!.riskClass).toBe(serverPolicy.riskClass);
      expect(display!.requiresApproval).toBe(serverPolicy.requiresApproval);
      expect(display!.actionLabel.length).toBeGreaterThan(0);
      expect(display!.stateTransition.length).toBeGreaterThan(0);
    }
  });

  it('every approval-required tool has a readable risk label', () => {
    const classes = new Set(
      Object.values(STORE_MANAGER_TOOL_DISPLAY).map(d => d.riskClass),
    );
    for (const riskClass of classes) {
      expect(STORE_MANAGER_RISK_LABELS[riskClass].length).toBeGreaterThan(0);
    }
  });

  it('approval card copy names the exact action, risk, scope, and transition', () => {
    const stage = approvalCardCopy('stage_stored_proposal_in_change_set', {
      proposalId: 'prop-123',
    });
    expect(stage.title).toContain('Stage a stored proposal');
    expect(stage.risk).toContain('mutation');
    expect(stage.scope).toContain('prop-123');
    expect(stage.transition).toContain('staged in Change Set');
    expect(stage.transition).toContain('not approved');
    expect(stage.transition).toContain('not synced');

    const repair = approvalCardCopy('repair_approved_change_set_images', {
      changeSetId: 'cs-9',
    });
    expect(repair.title).toContain('Repair Change Set images');
    expect(repair.risk).toContain('Network + filesystem');
    expect(repair.scope).toContain('cs-9');
  });

  it('read tools produce card copy without mutation language', () => {
    const read = approvalCardCopy('getCatalogHealthReport', {});
    expect(read.title).toContain('Read');
    expect(read.transition).toBe('none');
  });

  it('denial outcome never claims execution happened', () => {
    expect(deniedOutcomeText('stage_stored_proposal_in_change_set')).toContain('Not executed');
    expect(deniedOutcomeText('stage_stored_proposal_in_change_set')).not.toContain('staged');
    expect(deniedOutcomeText('stage_stored_proposal_in_change_set')).not.toContain('Success');
  });

  it('approval outcome never claims catalog state changed before a result', () => {
    const text = approvedAwaitingExecutionText('store_product_field_normalization_proposals');
    expect(text).toContain('Approved');
    expect(text).toContain('unchanged until the tool result confirms it');
  });

  it('state vocabulary keeps every durable term distinct', () => {
    const values = Object.values(STORE_MANAGER_STATE_TERMS);
    expect(new Set(values).size).toBe(values.length);
    expect(STORE_MANAGER_STATE_TERMS.storedProposal).toContain('status: proposed');
    expect(STORE_MANAGER_STATE_TERMS.stagedInChangeSet).toContain('not approved');
    expect(STORE_MANAGER_STATE_TERMS.changeSetApproved).toContain('not necessarily');
    expect(STORE_MANAGER_STATE_TERMS.synced).toContain('confirmed');
  });
});
