/**
 * PI-5 policy gateway + snapshot verification tests.
 *
 * DB-backed (bun test): SSRF protection, local_only/cloud_models_only
 * enforcement, domain allowlists, protocol/port validation, redirect
 * revalidation, response-size and content-type limits, budget enforcement,
 * audit recording with reason codes, and immutable snapshot verification.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/22
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createPiRun, transitionPiRunStatus } from '../../db/repositories/product-intelligence-repo';
import {
  PolicyDeniedError,
  PolicyGateway,
  classifyIp,
  isPrivateOrLinkLocal,
} from '../../product-intelligence/policy/policy-gateway';
import { verifyPolicySnapshot } from '../../product-intelligence/policy';
import { buildDefaultPiPolicy } from '../../product-intelligence/run-service';
import type { ProductIntelligencePolicy } from '../../product-intelligence/contracts';

const wsId = 'pi-policy-test-workspace';

function testPolicy(overrides: Record<string, unknown> = {}): ProductIntelligencePolicy {
  return buildDefaultPiPolicy();
}

function makeGateway(resolver: (hostname: string) => Promise<string[]>, fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return new PolicyGateway({ resolveHostname: resolver, fetchFn });
}

describe('PI-5 policy gateway', () => {
  const testDbPath = path.resolve(import.meta.dirname, 'pi-policy-test.db');

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    insertWorkspace({
      id: wsId,
      name: 'PI Policy Test',
      workspacePath: '/tmp/pi-policy-workspace',
      gitPath: '/tmp/pi-policy-workspace/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  function runningRun() {
    const run = createPiRun({
      workspaceId: wsId,
      mode: 'shadow',
      executor: 'pi',
      inputJson: '{}',
      policyJson: '{}',
      configSnapshotId: 'c',
      configSnapshotHash: 'c',
    });
    return run.id;
  }

  const publicResolver = async (hostname: string): Promise<string[]> =>
    hostname === 'public.example.com' || hostname === 'www.brand.example.com' || hostname === 'brand.example.com'
      ? ['93.184.216.34']
      : hostname === 'private.example.com'
        ? ['192.168.1.10']
        : hostname === 'link.example.com'
          ? ['169.254.10.10']
          : [];

  it('classifies private and link-local addresses', () => {
    expect(isPrivateOrLinkLocal('127.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('10.0.0.5')).toBe(true);
    expect(isPrivateOrLinkLocal('172.16.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('192.168.1.1')).toBe(true);
    expect(isPrivateOrLinkLocal('169.254.1.1')).toBe(true);
    expect(isPrivateOrLinkLocal('::1')).toBe(true);
    expect(isPrivateOrLinkLocal('fe80::1')).toBe(true);
    expect(isPrivateOrLinkLocal('fc00::1')).toBe(true);
    expect(isPrivateOrLinkLocal('93.184.216.34')).toBe(false);
    expect(classifyIp('8.8.8.8')).toBe('public');
  });

  it('denies private-network destinations with a recorded reason (SSRF)', async () => {
    const runId = runningRun();
    const gateway = makeGateway(publicResolver);
    const ctx = { runId, policy: testPolicy() };
    const denied = await gateway.checkNetworkRequest(ctx, 'https://private.example.com/secret');
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('private_network_destination');
    const rows = getDb().query('SELECT reason_code AS reasonCode, decision FROM product_intelligence_policy_decisions WHERE run_id = ? AND target_type = ?').all(runId, 'network') as Array<{ reasonCode: string; decision: string }>;
    expect(rows.some((r) => r.reasonCode === 'private_network_destination' && r.decision === 'deny')).toBe(true);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('blocks localhost and link-local hosts even when publicly-named', async () => {
    const runId = runningRun();
    const gateway = makeGateway(async () => ['127.0.0.1']);
    const ctx = { runId, policy: testPolicy() };
    const denied = await gateway.checkNetworkRequest(ctx, 'https://dns-rebinding.example.com/');
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('private_network_destination');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('enforces domain allowlists with suffix matching', async () => {
    const runId = runningRun();
    const policy = { ...testPolicy(), allowedSourceDomains: ['brand.example.com'] };
    const gateway = makeGateway(publicResolver);
    const ctx = { runId, policy };
    const ok = await gateway.checkNetworkRequest(ctx, 'https://www.brand.example.com/p/1');
    expect(ok.allowed).toBe(true);
    const denied = await gateway.checkNetworkRequest(ctx, 'https://other.example.com/p/1');
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('destination_not_allowlisted');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('rejects non-http protocols and non-standard ports', async () => {
    const runId = runningRun();
    const gateway = makeGateway(publicResolver);
    const ctx = { runId, policy: testPolicy() };
    const protocol = await gateway.checkNetworkRequest(ctx, 'ftp://public.example.com/file');
    expect(protocol.allowed).toBe(false);
    expect(protocol.reasonCode).toBe('invalid_protocol');
    const port = await gateway.checkNetworkRequest(ctx, 'https://public.example.com:8080/x');
    expect(port.allowed).toBe(false);
    expect(port.reasonCode).toBe('invalid_port');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('local_only network policy denies every outbound fetch', async () => {
    const runId = runningRun();
    const policy = { ...testPolicy(), networkPolicy: 'local_only' as const };
    const gateway = makeGateway(publicResolver);
    const denied = await gateway.checkNetworkRequest({ runId, policy }, 'https://public.example.com/');
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('local_only_denies_network');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('local_only data-sharing denies every remote model call and fallback', async () => {
    const runId = runningRun();
    const policy = { ...testPolicy(), dataSharingPolicy: 'local_only' as const, modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' as const } };
    const gateway = makeGateway(publicResolver);
    const denied = await gateway.checkModelCall({ runId, policy }, { provider: 'openai', model: 'gpt-4o-mini', dataClassification: 'product_input' });
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('local_only_denies_model');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('cloud_models_only allows the routed model but denies network fetches', async () => {
    const runId = runningRun();
    const policy = {
      ...testPolicy(),
      dataSharingPolicy: 'cloud_models_only' as const,
      modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' as const },
      networkPolicy: 'allowlisted_remote' as const,
    };
    const gateway = makeGateway(publicResolver);
    const model = await gateway.checkModelCall({ runId, policy }, { provider: 'openai', model: 'gpt-4o-mini', dataClassification: 'fetched_content' });
    expect(model.allowed).toBe(true);
    const network = await gateway.checkNetworkRequest({ runId, policy }, 'https://public.example.com/');
    expect(network.allowed).toBe(false);
    expect(network.reasonCode).toBe('cloud_models_only_denies_network');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('never silently switches model providers (fallback denied)', async () => {
    const runId = runningRun();
    const policy = {
      ...testPolicy(),
      dataSharingPolicy: 'cloud_models_and_sources' as const,
      modelRoute: { provider: 'openai', model: 'gpt-4o-mini', thinkingLevel: 'off' as const },
    };
    const gateway = makeGateway(publicResolver);
    const fallback = await gateway.checkModelCall({ runId, policy }, { provider: 'anthropic', model: 'claude-sonnet', dataClassification: 'fetched_content' });
    expect(fallback.allowed).toBe(false);
    expect(fallback.reasonCode).toBe('model_not_in_route');
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('blocks redirects to denied destinations (redirect revalidation)', async () => {
    const runId = runningRun();
    const gateway = makeGateway(publicResolver, async (input) => {
      const url = String(input);
      if (url.startsWith('https://public.example.com/start')) {
        return new Response(null, { status: 302, headers: { location: 'https://private.example.com/internal' } });
      }
      return new Response('ok', { status: 200 });
    });
    const ctx = { runId, policy: testPolicy() };
    await expect(gateway.gatewayFetch(ctx, 'https://public.example.com/start')).rejects.toThrow(PolicyDeniedError);
    const rows = getDb().query('SELECT reason_code AS reasonCode FROM product_intelligence_policy_decisions WHERE run_id = ?').all(runId) as Array<{ reasonCode: string }>;
    expect(rows.some((r) => r.reasonCode === 'private_network_destination')).toBe(true);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('enforces response-size and content-type limits', async () => {
    const runId = runningRun();
    const gateway = makeGateway(publicResolver, async () => new Response('x'.repeat(10_000), { status: 200, headers: { 'content-type': 'text/html' } }));
    const ctx = { runId, policy: testPolicy() };

    await expect(
      gateway.gatewayFetch(ctx, 'https://public.example.com/big', {}, { allowedContentTypes: ['image/'] }),
    ).rejects.toMatchObject({ decision: { reasonCode: 'content_type_denied' } });

    const oversized = await gateway.gatewayFetch(ctx, 'https://public.example.com/big', {}, { maxResponseBytes: 1_000 });
    // The size limit is enforced while the body streams.
    await expect(oversized.arrayBuffer()).rejects.toMatchObject({ decision: { reasonCode: 'response_too_large' } });
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('enforces tool and model budgets with recorded reason codes', async () => {
    const runId = runningRun();
    const gateway = makeGateway(publicResolver);
    const ctx = { runId, policy: testPolicy() };

    const toolDeny = gateway.checkToolBudget(ctx, 100, 100);
    expect(toolDeny.allowed).toBe(false);
    expect(toolDeny.reasonCode).toBe('budget_exceeded');

    const modelDeny = gateway.checkModelBudget(ctx, 2.5, 1);
    expect(modelDeny.allowed).toBe(false);
    expect(modelDeny.reasonCode).toBe('budget_exceeded');
    const modelAllow = gateway.checkModelBudget(ctx, 0.5, 1);
    expect(modelAllow.allowed).toBe(true);

    // Auditing is asynchronous (lazy DB import) — let it flush.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = getDb().query('SELECT reason_code AS reasonCode FROM product_intelligence_policy_decisions WHERE run_id = ? AND target_type IN (?, ?)').all(runId, 'budget', 'tool') as Array<{ reasonCode: string }>;
    expect(rows.filter((r) => r.reasonCode === 'budget_exceeded').length).toBe(2);
    transitionPiRunStatus(runId, 'completed', {});
  });

  it('verifies the immutable policy snapshot (tamper detection)', () => {
    const policy = testPolicy();
    expect(verifyPolicySnapshot(policy).valid).toBe(true);
    const tampered = { ...policy, maxToolCalls: policy.maxToolCalls + 1 };
    const result = verifyPolicySnapshot(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('refuses to start a run with a tampered policy snapshot', async () => {
    const { startProductIntelligenceRun } = await import('../../product-intelligence/run-service');
    const tampered = { ...testPolicy(), deadlineMs: 60_000 };
    await expect(
      startProductIntelligenceRun(
        { name: 'pi', version: '1', startResearch: async () => ({}) as never },
        { input: { gtin: '036000291452', registerName: 'X' }, mode: 'shadow', policy: tampered },
        { workspaceId: wsId, workspacePath: '/tmp/pi-policy-workspace' },
      ),
    ).rejects.toThrow(/Refusing to start run/);
  });
});
