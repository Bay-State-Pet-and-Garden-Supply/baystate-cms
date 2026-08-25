// story: e07s03
import { Hono } from 'hono';
import { z } from 'zod';
import { captureProfilePage } from '../../onboarding/profile-capture';

export const profileCaptureRoutes = new Hono();

const bodySchema = z.object({
  url: z.string().url(),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
});

profileCaptureRoutes.post('/capture', async (c) => {
  const body = await c.req.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const result = await captureProfilePage(parsed.data);
    return c.json({
      ok: true,
      ...result,
      screenshotBase64: result.screenshotBase64 ?? '',
      screenshotRef: (result as any).screenshotRef ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});
