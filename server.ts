import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'cadence-meet-server' });
  });

  app.post('/api/meet/validate', (req, res) => {
    const rawUrl = typeof req.body?.meetUrl === 'string' ? req.body.meetUrl.trim() : '';
    if (!rawUrl) {
      return res.status(400).json({ valid: false, error: 'Please enter a Google Meet link.' });
    }

    let candidate = rawUrl;
    if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(candidate)) {
      candidate = `https://meet.google.com/${candidate.toLowerCase()}`;
    } else if (!/^https?:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return res.status(400).json({ valid: false, error: 'Only HTTPS Google Meet links are supported.' });
      }
      if (parsed.hostname.toLowerCase() !== 'meet.google.com') {
        return res.status(400).json({
          valid: false,
          error: 'URL must be a valid meet.google.com meeting link (e.g. https://meet.google.com/abc-defg-hij).',
        });
      }
      const pathParts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
      const code = pathParts[0] || '';
      if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(code)) {
        return res.status(400).json({
          valid: false,
          error: 'Meeting code should match the Google Meet format xxx-yyyy-zzz.',
        });
      }
      const normalizedUrl = `https://meet.google.com/${code.toLowerCase()}`;
      return res.json({
        valid: true,
        meetingCode: code.toLowerCase(),
        normalizedUrl,
      });
    } catch {
      return res.status(400).json({ valid: false, error: 'Invalid URL format.' });
    }
  });

  if (!IS_PROD) {
    process.env.DISABLE_HMR = 'true';
    app.get('/@vite/client', (_req, res) => {
      res.type('application/javascript').send(`
export function createHotContext() {
  return {
    accept() {},
    dispose() {},
    prune() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
    data: {}
  };
}
export function updateStyle(id, content) {
  let style = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = document.querySelector('style[data-vite-dev-id="' + id + '"]');
  if (style) style.remove();
}
export function injectQuery(url) { return url; }
`);
    });

    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cadence Meet server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
