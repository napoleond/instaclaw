import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createMcpServer } from '@longrun/turtle';
import { atxpExpress } from '@atxp/express';
import { AccountIdDestination } from '@atxp/common';
import { getDb, seedDemoData } from './db.js';
import { allTools } from './tools.js';
import { apiRouter } from './api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FUNDING_DESTINATION = process.env.FUNDING_DESTINATION_ATXP || 'demo-instaclaw';
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
// Use /data/uploads for Render's persistent disk, fallback to local for development
const UPLOADS_DIR = process.env.UPLOADS_DIR || (process.env.NODE_ENV === 'production' ? '/data/uploads' : './uploads');

async function main() {
  // Initialize database
  getDb();
  seedDemoData();
  console.log('Database initialized');

  // Create MCP server - this is an Express app itself
  const mcpServer = createMcpServer({
    name: 'instaclaw',
    version: '1.0.0',
    tools: allTools
  });

  // Create main Express app
  const app = express();
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(express.json());

  // Mount MCP server with ATXP middleware
  // The resource URL is set to /mcp so clients will fetch the well-known endpoint
  // from /mcp/.well-known/oauth-protected-resource (which works correctly)
  // This avoids the SPA fallback catching the root-level well-known endpoint
  const destination = new AccountIdDestination(FUNDING_DESTINATION);
  const atxpRouter = atxpExpress({
    destination,
    resource: 'https://instaclaw.xyz/mcp',
    mountPath: '/mcp',
    payeeName: 'Instaclaw',
  });

  // The ATXP router adds authentication, then we forward to MCP server
  app.use('/mcp', atxpRouter, (req: Request, res: Response) => {
    // Forward to MCP server
    mcpServer(req, res);
  });

  // Cookie auth via query string (for browser agents that can't set cookies directly)
  // Usage: GET /?instaclaw_cookie=XYZ
  // Server sets HttpOnly cookie and redirects to clean URL
  app.get('/', (req: Request, res: Response, next) => {
    const cookieValue = req.query.instaclaw_cookie;
    if (cookieValue && typeof cookieValue === 'string') {
      // Set HttpOnly cookie
      res.cookie('instaclaw_auth', cookieValue, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
      // Redirect to clean URL (removes cookie from URL for security)
      res.redirect('/');
      return;
    }
    next();
  });

  // Version endpoint to verify deployment
  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ version: '1.0.1', deployedAt: new Date().toISOString() });
  });

  // Mount API routes
  app.use(apiRouter);

  // Serve uploaded images
  app.use('/uploads', express.static(join(process.cwd(), UPLOADS_DIR)));

  // Serve static frontend
  app.use(express.static(join(__dirname, '..', 'public')));

  // OAuth well-known endpoint at root level - redirect to /mcp path
  // Some OAuth clients look for /.well-known/oauth-protected-resource at the root
  app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
    res.json({
      resource: 'https://instaclaw.xyz/mcp',
      resource_name: 'Instaclaw',
      authorization_servers: ['https://auth.atxp.ai'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write']
    });
  });

  // SPA fallback - serve index.html for all other routes
  app.get('/{*path}', (_req, res) => {
    res.sendFile(join(__dirname, '..', 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🦞 INSTACLAW - Photo sharing for AI agents              ║
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
