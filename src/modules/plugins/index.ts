import { Router, Request, Response } from 'express';
import multer from 'multer';
import prisma from '../../db';
import logger from '../../handlers/logger';
import { isAuthenticated } from '../../handlers/utils/auth/authUtil';
import { isAuthenticatedForServer } from '../../handlers/utils/auth/serverAuthUtil';
import { PluginRegistry } from './plugin.registry';
import { PluginJobManager } from './plugin.jobmanager';
import { PluginUpdateManager } from './plugin.updater';
import { PluginMetricsService } from './plugin.metrics';
import { PluginInstaller } from './plugin.installer';
import { PluginIsolationService } from './plugin.isolation';
import { SecurityScanner } from './plugin.scanner';
import { CompatibilityMatrixService } from './plugin.compatibility';
import { getServerStatus } from '../../handlers/utils/server/serverStatus';
import { checkForServerInstallation } from '../../handlers/checkForServerInstallation';
import fs from 'fs';
import path from 'path';

// Setup multer for plugin jar file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max upload
});

const getAuthenticatedUser = (req: Request) => {
  return req.session?.user;
};

function getServerStatusInput(server: any) {
  return {
    nodeAddress: server.node.address,
    nodePort: server.node.port,
    serverUUID: server.UUID,
    nodeKey: server.node.key,
  };
}

function getImageFeatures(image: any): string[] {
  if (!image) return [];
  try {
    const info = typeof image.info === 'string' ? JSON.parse(image.info) : image.info;
    return Array.isArray(info?.features) ? info.features : [];
  } catch {
    return [];
  }
}

const pluginModule = {
  info: {
    name: 'Plugin Installer Module',
    description: 'Enterprise-grade native Minecraft Plugin Marketplace & Manager.',
    version: '2.0.0',
    moduleVersion: '1.0.0',
    author: 'CynexLabs',
    license: 'MIT'
  },

  router: () => {
    const router = Router();

    // Initialize Job Manager on start
    PluginJobManager.initialize().catch((err) => {
      logger.error(`Failed to initialize PluginJobManager: ${err.message}`);
    });

    // Start background worker for updates checking every 6 hours
    setInterval(() => {
      PluginUpdateManager.checkAllServersForUpdates().catch((err) => {
        logger.error(`Background updates checker failed: ${err.message}`);
      });
    }, 6 * 60 * 60 * 1000);

    // =========================================================================
    // PAGE ROUTES
    // =========================================================================

    // Global Marketplace View
    router.get('/plugins', isAuthenticated(), async (req: Request, res: Response) => {
      const user = getAuthenticatedUser(req);
      if (!user) return res.redirect('/login');

      // Fetch servers accessible to user
      const servers = user.isAdmin
        ? await prisma.server.findMany({ include: { node: true, image: true } })
        : await prisma.server.findMany({ where: { ownerId: user.id }, include: { node: true, image: true } });

      const settings = await prisma.settings.findUnique({ where: { id: 1 } });

      res.render('desktop/plugins/index', {
        title: 'Plugin Marketplace',
        user,
        req,
        settings,
        servers,
        selectedServerUuid: req.query.server || (servers[0]?.UUID || '')
      });
    });

    // Server Tab Redirect/View
    router.get('/server/:id/plugins', isAuthenticatedForServer('id'), async (req: Request, res: Response) => {
      try {
        const serverId = String(req.params.id);
        const server = (await prisma.server.findUnique({
          where: { UUID: serverId },
          include: { node: true, image: true, owner: true }
        })) as any;

        if (!server) {
          return res.status(404).send('Server not found.');
        }

        const user = getAuthenticatedUser(req);
        const settings = await prisma.settings.findUnique({ where: { id: 1 } });
        const features = getImageFeatures(server.image);
        const serverStatus = await getServerStatus(getServerStatusInput(server));
        const installed = await checkForServerInstallation(serverId);

        res.render('desktop/plugins/index', {
          title: 'Plugins',
          user,
          req,
          settings,
          server,
          serverStatus,
          features,
          installed,
          selectedServerUuid: server.UUID
        });
      } catch (err: any) {
        res.status(500).send(err.message);
      }
    });

    // =========================================================================
    // API ROUTES
    // =========================================================================

    // Search Marketplace
    router.get('/api/plugins/search', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const query = String(req.query.q || '');
        const category = String(req.query.category || '');
        const platform = String(req.query.platform || '');
        const version = String(req.query.version || '');
        const limit = parseInt(String(req.query.limit || '20'), 10);
        const offset = parseInt(String(req.query.offset || '0'), 10);

        const page = await PluginRegistry.search(query, {
          category,
          platform,
          version,
          limit,
          offset
        });

        res.json({ success: true, ...page });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Get Plugin Details
    router.get('/api/plugins/details', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const pluginId = String(req.query.pluginId || '');
        const providerId = String(req.query.provider || 'modrinth');

        const provider = PluginRegistry.getProvider(providerId);
        if (!provider) {
          return res.status(400).json({ success: false, error: 'Invalid provider.' });
        }

        const details = await provider.fetch(pluginId);
        res.json({ success: true, details });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Get Installed Plugins for Server
    router.get('/api/plugins/installed/:serverId', isAuthenticatedForServer('serverId'), async (req: Request, res: Response) => {
      try {
        const serverId = String(req.params.serverId);
        const installed = await prisma.pluginInstall.findMany({
          where: { serverId },
          include: { plugin: true }
        });

        res.json({ success: true, installed });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Install Plugin Trigger
    router.post('/api/plugins/install', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const { serverId, pluginId, versionId, provider, name } = req.body;

        if (!serverId || !pluginId || !versionId || !provider || !name) {
          return res.status(400).json({ success: false, error: 'Missing required parameters.' });
        }

        // Access check: Ensure user is authorized for server
        const user = getAuthenticatedUser(req);
        if (!user) return res.status(401).json({ success: false, error: 'Unauthenticated.' });

        const server = await prisma.server.findFirst({
          where: user.isAdmin ? { UUID: serverId } : { UUID: serverId, ownerId: user.id }
        });

        if (!server) {
          return res.status(403).json({ success: false, error: 'Access denied or server not found.' });
        }

        const jobId = await PluginJobManager.enqueueJob(serverId, pluginId, versionId, provider, name);
        res.json({ success: true, jobId, message: 'Installation enqueued successfully.' });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Upload Plugin JAR
    router.post('/api/plugins/upload', isAuthenticated(), upload.single('file'), async (req: Request, res: Response) => {
      const serverId = String(req.body.serverId);
      if (!req.file || !serverId) {
        return res.status(400).json({ success: false, error: 'Missing file or serverId.' });
      }

      const user = getAuthenticatedUser(req);
      if (!user) return res.status(401).json({ success: false, error: 'Unauthenticated.' });

      // Verify access to server
      const server = await prisma.server.findFirst({
        where: user.isAdmin ? { UUID: serverId } : { UUID: serverId, ownerId: user.id },
        include: { node: true, image: true }
      });

      if (!server) {
        return res.status(403).json({ success: false, error: 'Access denied.' });
      }

      // Write to temp workspace to scan
      const tempDir = path.join(__dirname, '../../../../storage/plugins/temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const tempFilePath = path.join(tempDir, `${Date.now()}_upload_${req.file.originalname}`);
      fs.writeFileSync(tempFilePath, req.file.buffer);

      try {
        // Run security scan
        const scanResult = await SecurityScanner.scan(tempFilePath, req.file.originalname);
        if (!scanResult.passed) {
          return res.status(400).json({ success: false, error: `Security Scan Failed: ${scanResult.reason}` });
        }

        // Deploy to daemon
        const serverEnv = CompatibilityMatrixService.resolveServerEnvironment(server);
        const installedPaths = await PluginInstaller.installPlugin(
          serverId,
          tempFilePath,
          req.file.originalname,
          serverEnv.software,
          () => {}
        );

        res.json({ success: true, message: 'Uploaded and installed successfully!', paths: installedPaths });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      }
    });

    // Uninstall Plugin
    router.post('/api/plugins/uninstall', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const { serverId, fileName, pluginId } = req.body;
        if (!serverId || !fileName) {
          return res.status(400).json({ success: false, error: 'Missing serverId or fileName.' });
        }

        const user = getAuthenticatedUser(req);
        if (!user) return res.status(401).json({ success: false, error: 'Unauthenticated.' });

        const server = await prisma.server.findFirst({
          where: user.isAdmin ? { UUID: serverId } : { UUID: serverId, ownerId: user.id }
        });

        if (!server) {
          return res.status(403).json({ success: false, error: 'Access denied.' });
        }

        const serverEnv = CompatibilityMatrixService.resolveServerEnvironment(server);
        await PluginInstaller.uninstallPlugin(serverId, fileName, serverEnv.software);

        // Delete from local DB if applicable
        if (pluginId) {
          await prisma.pluginInstall.deleteMany({
            where: {
              serverId,
              plugin: { pluginId }
            }
          });
        }

        res.json({ success: true, message: 'Plugin deleted successfully.' });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Get Active Jobs Log/Status
    router.get('/api/plugins/jobs', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const serverId = String(req.query.serverId || '');
        const jobs = await prisma.pluginJob.findMany({
          where: serverId ? { serverId } : {},
          orderBy: { createdAt: 'desc' },
          take: 20
        });

        res.json({ success: true, jobs });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Get Single Job Log
    router.get('/api/plugins/jobs/:jobId', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const job = await prisma.pluginJob.findUnique({
          where: { id: String(req.params.jobId) }
        });

        if (!job) {
          return res.status(404).json({ success: false, error: 'Job not found.' });
        }

        res.json({ success: true, job });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Get Metrics & Telemetry
    router.get('/api/plugins/metrics', isAuthenticated(), async (req: Request, res: Response) => {
      const user = getAuthenticatedUser(req);
      if (!user || !user.isAdmin) {
        return res.status(403).json({ success: false, error: 'Access Denied.' });
      }

      try {
        const metrics = await PluginMetricsService.getMetrics();
        res.json({ success: true, metrics });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Batch Update Plugins
    router.post('/api/plugins/update-batch', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const { serverId, pluginIds } = req.body;
        if (!serverId || !Array.isArray(pluginIds)) {
          return res.status(400).json({ success: false, error: 'Missing serverId or pluginIds.' });
        }

        const user = getAuthenticatedUser(req);
        if (!user) return res.status(401).json({ success: false, error: 'Unauthenticated.' });

        const server = await prisma.server.findFirst({
          where: user.isAdmin ? { UUID: serverId } : { UUID: serverId, ownerId: user.id }
        });

        if (!server) {
          return res.status(403).json({ success: false, error: 'Access denied.' });
        }

        const result = await PluginUpdateManager.triggerBatchUpdate(serverId, pluginIds);
        res.json({ success: true, ...result });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Cancel Job
    router.post('/api/plugins/jobs/cancel', isAuthenticated(), async (req: Request, res: Response) => {
      try {
        const { jobId } = req.body;
        if (!jobId) {
          return res.status(400).json({ success: false, error: 'Missing jobId.' });
        }

        const success = await PluginJobManager.cancelJob(jobId);
        res.json({ success });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    return router;
  }
};

export default pluginModule;
