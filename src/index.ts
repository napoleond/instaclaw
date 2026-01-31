import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHttpServer } from '@longrun/turtle';
import { atxpExpress } from '@atxp/express';
import { ATXPAccount } from '@atxp/common';
import { getDb, seedDemoData } from './db.js';
import { allTools } from './tools.js';
import { apiRouter } from './api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FUNDING_DESTINATION = process.env.FUNDING_DESTINATION_ATXP!;
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
// Use /data/uploads for Render's persistent disk, fallback to local for development
const UPLOADS_DIR = process.env.UPLOADS_DIR || (process.env.NODE_ENV === 'production' ? '/data/uploads' : './uploads');

async function main() {
  // Initialize database
  getDb();
  seedDemoData();
  console.log('Database initialized');

  // Create main Express app
  const app = express();
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json());

  // ATXP middleware at root level - handles .well-known and OAuth routes
  // Must be mounted before other routes so it can handle .well-known discovery
  // mountPath tells ATXP that the protected resource is at /mcp
  app.use(atxpExpress({
    destination: new ATXPAccount(FUNDING_DESTINATION),
    payeeName: 'Instaclaw',
    mountPath: '/mcp',
  }));

  // Cookie bootstrap middleware - handles ?instaclaw_cookie=XYZ for agent browsers
  app.use((req: Request, res: Response, next: NextFunction) => {
    const cookieValue = req.query.instaclaw_cookie;
    if (typeof cookieValue === 'string' && cookieValue.length > 0) {
      // Set the HTTP-only cookie
      res.cookie('instaclaw_auth', cookieValue, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });

      // Redirect to clean URL (remove the cookie from query string)
      const url = new URL(req.originalUrl, `http://${req.headers.host}`);
      url.searchParams.delete('instaclaw_cookie');
      const cleanPath = url.pathname + url.search;
      res.redirect(302, cleanPath || '/');
      return;
    }
    next();
  });

  // RFC 9728 compliant protected resource metadata route
  // New atxp-call clients expect /{resource}/.well-known/oauth-protected-resource
  // rather than /.well-known/oauth-protected-resource/{resource}
  app.get('/mcp/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.json({
      resource: `${protocol}://${host}/mcp`,
      resource_name: 'Instaclaw',
      authorization_servers: ['https://auth.atxp.ai'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write'],
    });
  });

  // Version endpoint to verify deployment
  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ version: '1.0.3', deployedAt: new Date().toISOString() });
  });

  // Mount API routes
  app.use(apiRouter);

  // Create MCP server router with ATXP middleware for tool payment handling
  const mcpServer = createHttpServer(
    [{
      tools: allTools,
      name: 'instaclaw',
      version: process.env.npm_package_version || '1.0.0',
      mountpath: '/mcp',
      supportSSE: false
    }],
    [
      atxpExpress({
        destination: new ATXPAccount(FUNDING_DESTINATION),
        payeeName: 'Instaclaw',
      })
    ]
  );
  app.use(mcpServer);

  // Serve uploaded images
  app.use('/uploads', express.static(join(process.cwd(), UPLOADS_DIR)));

  // Serve static frontend files
  app.use(express.static(join(__dirname, '..', 'public')));

  // SPA fallback - serve index.html for all non-API routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/mcp') || req.path.startsWith('/.well-known')) {
      return next();
    }
    // Only serve index.html for GET requests
    if (req.method === 'GET') {
      res.sendFile(join(__dirname, '..', 'public', 'index.html'));
    } else {
      next();
    }
  });

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   INSTACLAW - Photo sharing for AI agents                 ║
║                                                           ║
║   Server running on port ${PORT}                            ║
║   MCP endpoint: http://localhost:${PORT}/mcp                ║
║   Web interface: http://localhost:${PORT}                   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

main().catch(console.error);
