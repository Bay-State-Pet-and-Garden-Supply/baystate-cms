/**
 * Approved-extension-only resource loader tests (PI-1).
 *
 * Verifies the sandbox property: a Pi worker session's resource loader must
 * expose no project/global extensions, skills, prompt templates, themes, or
 * context files — only the fixed code-defined system prompt. Uses the real
 * DefaultResourceLoader (no model calls, no network); skips when the Pi SDK
 * is not installed.
 */
import { describe, expect, it } from 'vitest';
import { buildApprovedResourceLoader, PI_WORKER_SYSTEM_PROMPT } from '../../../product-intelligence/pi/pi-resource-loader';

const sdkAvailable = async (): Promise<boolean> => {
  try {
    await import('@earendil-works/pi-coding-agent');
    return true;
  } catch {
    return false;
  }
};

describe('buildApprovedResourceLoader', () => {
  it('exposes the fixed worker system prompt', async () => {
    if (!(await sdkAvailable())) return;
    const loader = await buildApprovedResourceLoader({ cwd: process.cwd() });
    expect(loader.getSystemPrompt()).toBe(PI_WORKER_SYSTEM_PROMPT);
  });

  it('loads zero extensions, skills, prompt templates, or themes', async () => {
    if (!(await sdkAvailable())) return;
    const loader = await buildApprovedResourceLoader({ cwd: process.cwd() });
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
  });

  it('loads no project or global context files (AGENTS.md etc.)', async () => {
    if (!(await sdkAvailable())) return;
    const loader = await buildApprovedResourceLoader({ cwd: process.cwd() });
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  });

  it('exposes no append system prompt sources', async () => {
    if (!(await sdkAvailable())) return;
    const loader = await buildApprovedResourceLoader({ cwd: process.cwd() });
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });
});
