import { Hono } from 'hono';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import {
  getCurrentWorkspace, createWorkspace, loadWorkspace,
} from '../services/workspace-service';

const execPromise = promisify(exec);
const route = new Hono();

/**
 * GET /api/workspace - Get current workspace.
 */
route.get('/workspace', (c) => {
  const ws = getCurrentWorkspace();
  return c.json({
    workspace: ws ?? null,
    message: ws ? 'Workspace loaded' : 'No workspace loaded',
  });
});

/**
 * POST /api/workspace/init - Create a new workspace.
 */
route.post('/workspace/init', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { name, path: workspacePath } = body as { name?: string; path?: string };

  if (!name || !workspacePath) {
    return c.json({ error: 'Both "name" and "path" are required.' }, 400);
  }

  try {
    const result = createWorkspace(name, workspacePath);
    return c.json({
      success: true,
      workspace: result.workspace,
    });
  } catch (err) {
    return c.json({
      error: `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

/**
 * POST /api/workspace/open - Open an existing workspace.
 */
route.post('/workspace/open', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { path: workspacePath } = body as { path?: string };

  if (!workspacePath) {
    return c.json({ error: '"path" is required.' }, 400);
  }

  try {
    const workspace = loadWorkspace(workspacePath);
    if (!workspace) {
      return c.json({ error: 'No workspace found at this path.' }, 404);
    }
    return c.json({ success: true, workspace });
  } catch (err) {
    return c.json({
      error: `Failed to open workspace: ${err instanceof Error ? err.message : String(err)}`,
    }, 500);
  }
});

/**
 * POST /api/workspace/pick-directory - Open macOS native folder selector.
 */
route.post('/workspace/pick-directory', async (c) => {
  if (os.platform() !== 'darwin') {
    return c.json({
      success: false,
      error: 'unsupported',
      message: 'Directory picker is only supported on macOS.',
    }, 400);
  }

  try {
    const script = 'POSIX path of (choose folder with prompt "Select Workspace Folder")';
    const { stdout } = await execPromise(`osascript -e '${script}'`);
    const selectedPath = stdout.trim();
    return c.json({ success: true, path: selectedPath });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('User canceled')) {
      return c.json({
        success: false,
        error: 'cancelled',
        message: 'Folder selection was cancelled.',
      });
    }
    return c.json({
      success: false,
      error: 'failed',
      message: `Failed to open folder selector: ${message}`,
    }, 500);
  }
});

export default route;
