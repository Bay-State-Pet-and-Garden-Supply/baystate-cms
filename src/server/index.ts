import { serve } from 'bun';
import app from './app';
import { createStoreManagerScheduler } from './services/store-manager-scheduler';
import { getStoreManagerFlags } from '../store-manager/flags';

const PORT = parseInt(process.env.PORT ?? '3030', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

// ── Store Manager operations console (Issue 4): leased scheduled read-only
// runs. The scheduler is inert unless the feature flag enables it AND the
// kill switch is off. This is a small isolated wiring block — no catalog,
// onboarding, or migration behavior is touched. ──────────────────────────────
const storeManagerScheduler = createStoreManagerScheduler();
const schedulerStarted = (() => {
  const flags = getStoreManagerFlags();
  if (!flags.schedulesEnabled || flags.killSwitch) return false;
  storeManagerScheduler.start();
  return true;
})();

const shutdown = () => {
  storeManagerScheduler.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const server = serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
  idleTimeout: 60, // SSE connections need longer idle timeout than Bun's default of 10s
});

console.log(`Baystate CMS API server running on http://${HOST}:${PORT}`);
console.log(`Store Manager scheduler: ${schedulerStarted ? 'running' : 'inert (flag off or kill switch on)'}`);
if (process.env.BAYSTATE_CMS_API_TOKEN) {
  console.log(`API token authentication is enabled for mutating requests.`);
} else {
  console.log(`No API token configured. Mutating requests are unauthenticated - set BAYSTATE_CMS_API_TOKEN for production use.`);
}

export { server };
