#!/usr/bin/env node
/**
 * @fileoverview Entry point for the ClinicalTrials.gov MCP server powered by mcp-framework.
 * Initializes configuration, telemetry, logger, and launches the MCP server (stdio or HTTP).
 * @module src/index
 */

// Disable ANSI color codes before any imports when running via MCP clients.
const transportType = process.env.MCP_TRANSPORT_TYPE?.toLowerCase();
const isStdioMode = !transportType || transportType === 'stdio';
const isHttpModeWithoutTty = transportType === 'http' && !process.stdout.isTTY;

if (isStdioMode || isHttpModeWithoutTty) {
  process.env.NO_COLOR = '1';
  process.env.FORCE_COLOR = '0';
}

import 'reflect-metadata';
import {
  MCPServer,
  type TransportConfig,
  type HttpStreamTransportConfig,
} from 'mcp-framework';

import { config as appConfigType } from '@/config/index.js';
import container, { AppConfig, composeContainer } from '@/container/index.js';
import {
  initializePerformance_Hrt,
  requestContextService,
} from '@/utils/index.js';
import { type McpLogLevel, logger } from '@/utils/internal/logger.js';
import {
  initializeOpenTelemetry,
  shutdownOpenTelemetry,
} from '@/utils/telemetry/instrumentation.js';

type AppConfigType = typeof appConfigType;

let config: AppConfigType;
let server: MCPServer | null = null;
let isShuttingDown = false;

function buildTransportConfig(): TransportConfig {
  if (config.mcpTransportType === 'http') {
    const cors =
      config.mcpAllowedOrigins && config.mcpAllowedOrigins.length > 0
        ? {
            allowOrigin:
              config.mcpAllowedOrigins.length === 1
                ? config.mcpAllowedOrigins[0]!
                : '*',
          }
        : undefined;

    const sessionConfig: HttpStreamTransportConfig['session'] =
      config.mcpSessionMode === 'stateless'
        ? { enabled: false }
        : config.mcpSessionMode === 'stateful'
          ? {
              enabled: true,
              sessionTimeout: config.mcpStatefulSessionStaleTimeoutMs,
            }
          : undefined;

    const httpOptions: HttpStreamTransportConfig = {
      port: config.mcpHttpPort,
      endpoint: config.mcpHttpEndpointPath,
      responseMode: 'batch',
      ...(cors ? { cors } : {}),
      ...(sessionConfig ? { session: sessionConfig } : {}),
    };

    return {
      type: 'http-stream',
      options: httpOptions,
    };
  }

  return { type: 'stdio' };
}

const shutdown = async (signal: string): Promise<void> => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  const shutdownContext = requestContextService.createRequestContext({
    operation: 'ServerShutdown',
    triggerEvent: signal,
  });

  logger.info(
    `Received ${signal}. Initiating graceful shutdown...`,
    shutdownContext,
  );

  try {
    if (server?.IsRunning) {
      logger.info('Stopping MCP server transport...', shutdownContext);
      await server.stop();
    }

    logger.info(
      'Graceful shutdown completed successfully. Exiting.',
      shutdownContext,
    );

    await shutdownOpenTelemetry();
    await logger.close();

    process.exit(0);
  } catch (error) {
    logger.error(
      'Critical error during shutdown process.',
      error as Error,
      shutdownContext,
    );
    try {
      await logger.close();
    } catch (_e) {
      // Ignore errors during final logger close attempt
    }
    process.exit(1);
  }
};

const start = async (): Promise<void> => {
  try {
    composeContainer();
    const resolvedConfig = container.resolve<AppConfigType>(AppConfig);
    config = resolvedConfig;
  } catch (_error) {
    if (process.stdout.isTTY) {
      console.error('Halting due to critical configuration error.');
    }
    await shutdownOpenTelemetry();
    process.exit(1);
  }

  requestContextService.configure({
    appName: config.mcpServerName,
    appVersion: config.mcpServerVersion,
    environment: config.environment,
  });

  try {
    await initializeOpenTelemetry();
  } catch (error) {
    console.error('[Startup] Failed to initialize OpenTelemetry:', error);
  }

  await initializePerformance_Hrt();

  const validMcpLogLevels: McpLogLevel[] = [
    'debug',
    'info',
    'notice',
    'warning',
    'error',
    'crit',
    'alert',
    'emerg',
  ];
  const initialLogLevelConfig = config.logLevel;

  let validatedMcpLogLevel: McpLogLevel = 'info';
  if (validMcpLogLevels.includes(initialLogLevelConfig as McpLogLevel)) {
    validatedMcpLogLevel = initialLogLevelConfig as McpLogLevel;
  } else if (process.stdout.isTTY) {
    console.warn(
      `[Startup Warning] Invalid MCP_LOG_LEVEL "${initialLogLevelConfig}". Defaulting to "info".`,
    );
  }

  await logger.initialize(validatedMcpLogLevel, config.mcpTransportType);

  logger.info(
    `Storage service initialized with provider: ${config.storage.providerType}`,
    requestContextService.createRequestContext({ operation: 'StorageInit' }),
  );

  const startupContext = requestContextService.createRequestContext({
    operation: 'ServerStartup',
    applicationName: config.mcpServerName,
    applicationVersion: config.mcpServerVersion,
    nodeEnvironment: config.environment,
  });

  logger.info(
    `Starting ${config.mcpServerName} (v${config.mcpServerVersion})...`,
    startupContext,
  );

  try {
    server = new MCPServer({
      name: config.mcpServerName,
      version: config.mcpServerVersion,
      transport: buildTransportConfig(),
    });

    await server.start();

    logger.info(
      `${config.mcpServerName} is now running and ready.`,
      startupContext,
    );

    if (config.mcpTransportType === 'http') {
      logger.info(
        `Listening on http://${config.mcpHttpHost}:${config.mcpHttpPort}${config.mcpHttpEndpointPath}`,
        startupContext,
      );
    }

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('uncaughtException', (error: Error) => {
      logger.fatal(
        'FATAL: Uncaught exception detected.',
        error,
        startupContext,
      );
      void shutdown('uncaughtException');
    });
    process.on('unhandledRejection', (reason: unknown) => {
      logger.fatal(
        'FATAL: Unhandled promise rejection detected.',
        reason as Error,
        startupContext,
      );
      void shutdown('unhandledRejection');
    });
  } catch (error) {
    logger.fatal(
      'CRITICAL ERROR DURING STARTUP.',
      error as Error,
      startupContext,
    );
    await shutdownOpenTelemetry();
    process.exit(1);
  }
};

void (async () => {
  try {
    await start();
  } catch (error) {
    if (process.stdout.isTTY) {
      console.error('[GLOBAL CATCH] A fatal, unhandled error occurred:', error);
    }
    process.exit(1);
  }
})();
