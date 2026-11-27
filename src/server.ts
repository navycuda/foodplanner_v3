import express, { type NextFunction, type Request, type Response } from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDatabase } from './db.js';
import { registerItemRoutes } from './items.js';
import { registerRecipeRoutes } from './recipes.js';

const PORT = 3000;
const HOST = '0.0.0.0';

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled to dist/server.js. Pages, CSS, and the database live one level up.
const root = path.resolve(here, '..');

const db = openDatabase(path.join(root, 'foodPlanner.db'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'dist', 'web')));
app.use(express.static(path.join(root, 'public')));

registerItemRoutes(app, db);
registerRecipeRoutes(app, db);

app.get('/', (_req, res) => {
  res.sendFile(path.join(root, 'html', 'index.html'));
});
app.get('/groceries', (_req, res) => {
  res.sendFile(path.join(root, 'html', 'groceries.html'));
});
app.get('/recipes', (_req, res) => {
  res.sendFile(path.join(root, 'html', 'recipes.html'));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err === 'object' && err != null && 'status' in err && typeof err.status === 'number'
    ? err.status
    : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : 'Bad request.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Food planner listening on ${HOST}:${PORT}`);
  console.log(`  This computer: http://127.0.0.1:${PORT}`);
  const ips = lanIpv4();
  if (ips.length === 0) {
    console.log('  On the LAN:    no IPv4 address found on this computer.');
    console.log('  Mac:           ipconfig getifaddr en0   (try en1 if that is empty)');
    console.log('  Windows:       ipconfig, then the IPv4 address');
  } else {
    for (const ip of ips) console.log(`  On the LAN:    http://${ip}:${PORT}`);
  }
  console.log('Open the LAN address on a phone on the same Wi-Fi. Allow port 3000 on the local network.');
});

function lanIpv4(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number;
      if (entry.internal) continue;
      if (family === 'IPv4' || family === 4) found.push(entry.address);
    }
  }
  return found;
}
