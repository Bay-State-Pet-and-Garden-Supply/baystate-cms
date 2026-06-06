import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { resolve } from 'path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const root = resolve(import.meta.dirname, '..');

// Generate or read a per-dev API token for mutating request security
const tokenPath = join(root, '.shopsite-cms-dev-token');
let apiToken: string;
try {
  if (existsSync(tokenPath)) {
    apiToken = readFileSync(tokenPath, 'utf-8').trim();
  } else {
    apiToken = randomBytes(32).toString('hex');
    try { mkdirSync(join(root, '.shopsite-cms-dev-token-dir'), { recursive: true }); } catch { /* dir exists */ }
    writeFileSync(tokenPath, apiToken, { mode: 0o600 });
  }
} catch {
  apiToken = randomBytes(32).toString('hex');
}

const env = {
  ...process.env,
  NODE_ENV: 'development',
  SHOPSITE_CMS_API_TOKEN: apiToken,
  HOST: '127.0.0.1',
};

// Start API server
const server = spawn('bun', ['run', 'src/server/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env,
});

// Start Vite dev server - bind to 127.0.0.1 for security
const vite = spawn(
  'bunx',
  ['vite', '--host', '127.0.0.1'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_SHOPSITE_CMS_API_TOKEN: apiToken,
    },
  },
);

console.log(`ShopSite CMS dev mode started.`);
console.log(`API token: ${apiToken}`);
console.log(`Server bound to 127.0.0.1:${process.env.PORT ?? '3030'}`);
console.log(`Vite bound to 127.0.0.1:5173`);

process.on('SIGINT', () => {
  server.kill();
  vite.kill();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.kill();
  vite.kill();
  process.exit(0);
});
