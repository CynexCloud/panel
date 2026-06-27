import axios from 'axios';
import fs from 'fs';
import path from 'path';
import prisma from '../../db';
import logger from '../../handlers/logger';
import { daemonSchemeSync } from '../../handlers/utils/core/daemonRequest';
import { PluginIsolationService } from './plugin.isolation';

export class PluginInstaller {
  /**
   * Helper to get daemon base URL and auth
   */
  private static getDaemonConfig(server: any) {
    const scheme = daemonSchemeSync ? daemonSchemeSync() : (process.env.URL?.startsWith('https') ? 'https' : 'http');
    return {
      baseUrl: `${scheme}://${server.node.address}:${server.node.port}`,
      auth: {
        username: 'Airlink',
        password: server.node.key
      }
    };
  }

  /**
   * Deploys a local temporary jar file to a server container's plugin directory.
   * Implements snapshot rollbacks.
   */
  public static async installPlugin(
    serverId: string,
    tempFilePath: string,
    fileName: string,
    serverType: string,
    onProgress: (stage: string, percent: number, logLine: string) => void
  ): Promise<string[]> {
    // 1. Fetch server and node details
    const server = await prisma.server.findUnique({
      where: { UUID: serverId },
      include: { node: true }
    });

    if (!server) {
      throw new Error(`Server ${serverId} not found.`);
    }

    const { baseUrl, auth } = this.getDaemonConfig(server);

    // 2. Resolve and jail path
    const targetDir = PluginIsolationService.sanitizeAndJailPath('/plugins', serverType);
    if (!targetDir) {
      throw new Error('Paths traversal detected. Installation aborted.');
    }
    const targetFilePath = `${targetDir}/${fileName}`;

    onProgress('installing', 10, `Preparing workspace directory: ${targetDir}`);

    // 3. Rollback snapshot system: check if file already exists on daemon.
    // If it does, we backup the existing file by renaming it.
    let backupCreated = false;
    const backupFilePath = `${targetFilePath}.bak`;
    
    try {
      // Try to rename existing file to .bak to enable rollback
      onProgress('installing', 30, `Checking for existing installation of ${fileName}...`);
      await axios.post(
        `${baseUrl}/fs/rename`,
        {
          id: server.UUID,
          path: targetDir,
          oldname: fileName,
          newname: `${fileName}.bak`
        },
        { auth, timeout: 5000 }
      );
      backupCreated = true;
      onProgress('installing', 40, `Created rollback snapshot for existing plugin.`);
    } catch {
      // If it fails, either file doesn't exist or rename isn't supported. Ignore.
    }

    // 4. Read local file and start uploading
    try {
      const stats = fs.statSync(tempFilePath);
      const fileSize = stats.size;
      const fileBuffer = fs.readFileSync(tempFilePath);

      onProgress('installing', 50, `Uploading plugin package (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);

      if (fileSize < 10 * 1024 * 1024) {
        // Single upload
        const fileContentBase64 = fileBuffer.toString('base64');
        const mimetype = 'application/java-archive';
        const fileContentWithMeta = `data:${mimetype};base64,${fileContentBase64}`;

        await axios.post(
          `${baseUrl}/fs/upload`,
          {
            id: server.UUID,
            path: targetDir,
            fileName: fileName,
            fileContent: fileContentWithMeta
          },
          { auth, timeout: 30000 }
        );
      } else {
        // Chunked upload
        await axios.post(
          `${baseUrl}/fs/create-empty-file`,
          {
            id: server.UUID,
            path: targetDir,
            fileName: fileName
          },
          { auth, timeout: 10000 }
        );

        const CHUNK_SIZE = 5 * 1024 * 1024;
        const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, fileSize);
          const chunk = fileBuffer.slice(start, end);
          const chunkBase64 = chunk.toString('base64');
          const chunkWithMeta = `data:application/java-archive;base64,${chunkBase64}`;

          onProgress(
            'installing',
            50 + Math.round((i / totalChunks) * 40),
            `Uploading chunk ${i + 1}/${totalChunks}...`
          );

          await axios.post(
            `${baseUrl}/fs/append-file`,
            {
              id: server.UUID,
              path: targetDir,
              fileName: fileName,
              fileContent: chunkWithMeta,
              chunkIndex: i,
              totalChunks: totalChunks
            },
            { auth, timeout: 30000 }
          );
        }
      }

      onProgress('finalizing', 95, `Cleaning temporary files and resolving dependencies...`);

      // Delete rollback backup file on success
      if (backupCreated) {
        try {
          await axios.post(
            `${baseUrl}/fs/rm`,
            {
              id: server.UUID,
              path: backupFilePath
            },
            { auth, timeout: 5000 }
          );
        } catch (err: any) {
          logger.warn(`Failed to clean rollback backup file: ${err.message}`);
        }
      }

      onProgress('completed', 100, `Plugin successfully installed to ${targetFilePath}`);
      return [targetFilePath];
    } catch (uploadErr: any) {
      // UPLOAD FAILED -> TRIGGER ROLLBACK Snapshot Restore
      onProgress('installing', 80, `[ERROR] Upload failed: ${uploadErr.message}. Triggering rollback snapshot...`);

      if (backupCreated) {
        try {
          // Rename the backup file back to original file name
          await axios.post(
            `${baseUrl}/fs/rename`,
            {
              id: server.UUID,
              path: targetDir,
              oldname: `${fileName}.bak`,
              newname: fileName
            },
            { auth, timeout: 5000 }
          );
          onProgress('failed', 100, `Rollback executed successfully. Previous version restored.`);
        } catch (rollbackErr: any) {
          onProgress('failed', 100, `Rollback failed: ${rollbackErr.message}. Workspace might be corrupted.`);
        }
      }

      throw uploadErr;
    }
  }

  /**
   * Uninstalls a plugin jar from the server's plugins directory.
   */
  public static async uninstallPlugin(serverId: string, fileName: string, serverType: string): Promise<void> {
    const server = await prisma.server.findUnique({
      where: { UUID: serverId },
      include: { node: true }
    });

    if (!server) {
      throw new Error(`Server ${serverId} not found.`);
    }

    const { baseUrl, auth } = this.getDaemonConfig(server);
    const targetDir = PluginIsolationService.sanitizeAndJailPath('/plugins', serverType);
    if (!targetDir) {
      throw new Error('Paths traversal detected. Action aborted.');
    }
    const targetFilePath = `${targetDir}/${fileName}`;

    await axios.post(
      `${baseUrl}/fs/rm`,
      {
        id: server.UUID,
        path: targetFilePath
      },
      { auth, timeout: 10000 }
    );
  }
}
