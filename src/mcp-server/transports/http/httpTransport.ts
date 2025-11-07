/**
 * @fileoverview Configures and starts the HTTP MCP transport using Hono.
 * This implementation now relies on the official MCP TypeScript SDK
 * `StreamableHTTPServerTransport`, ensuring feature parity with the spec.
 *
 * Implements MCP Specification 2025-06-18 Streamable HTTP Transport.
 * @see {@link https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http | MCP Streamable HTTP Transport}
 * @module src/mcp-server/transports/http/httpTransport
 */
import { type ServerType, serve } from '@hono/node-server';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import http, { type IncomingMessage } from 'http';

import { config } from '@/config/index.js';
import {
  authContext,
  type AuthInfo,
  createAuthMiddleware,
  createAuthStrategy,
} from '@/mcp-server/transports/auth/index.js';
import { httpErrorHandler } from '@/mcp-server/transports/http/httpErrorHandler.js';
import type { HonoNodeBindings } from '@/mcp-server/transports/http/httpTypes.js';
import { generateSecureSessionId } from '@/mcp-server/transports/http/sessionIdUtils.js';
import {
  SessionStore,
  type SessionIdentity,
} from '@/mcp-server/transports/http/sessionStore.js';
import {
  type RequestContext,
  logger,
  logStartupBanner,
} from '@/utils/index.js';

const HONO_ALREADY_SENT_HEADER = 'x-hono-already-sent';

type IncomingMessageWithAuth = IncomingMessage & { auth?: AuthInfo };

export function createHttpApp(
  mcpServer: McpServer,
  parentContext: RequestContext,
): Hono<{ Bindings: HonoNodeBindings }> {
  const app = new Hono<{ Bindings: HonoNodeBindings }>();
  const transportContext = {
    ...parentContext,
    component: 'HttpTransportSetup',
  };

  const isStatefulMode = config.mcpSessionMode === 'stateful';
  const sessionStore = isStatefulMode
    ? new SessionStore(config.mcpStatefulSessionStaleTimeoutMs)
    : null;
  const sessionTransports = new Map<string, StreamableHTTPServerTransport>();

  const allowedOriginsList =
    Array.isArray(config.mcpAllowedOrigins) &&
    config.mcpAllowedOrigins.length > 0
      ? config.mcpAllowedOrigins
      : undefined;
  const corsOrigin = allowedOriginsList ?? '*';
  const dnsProtectionEnabled =
    Array.isArray(allowedOriginsList) && allowedOriginsList.length > 0;

  app.use(
    '*',
    cors({
      origin: corsOrigin,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'Mcp-Session-Id',
        'MCP-Protocol-Version',
      ],
      exposeHeaders: ['Mcp-Session-Id'],
      credentials: true,
    }),
  );

  // Centralized error handling
  app.onError(httpErrorHandler);

  // MCP Spec 2025-06-18: Origin header validation for DNS rebinding protection
  // https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#security-warning
  app.use(config.mcpHttpEndpointPath, async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && dnsProtectionEnabled) {
      const isAllowed =
        allowedOriginsList === undefined || allowedOriginsList.includes(origin);

      if (!isAllowed) {
        logger.warning('Rejected request with invalid Origin header', {
          ...transportContext,
          origin,
          allowedOrigins: allowedOriginsList,
        });
        return c.json(
          { error: 'Invalid origin. DNS rebinding protection.' },
          403,
        );
      }
    }
    // Origin is valid or not present, continue
    return await next();
  });

  // Health and GET /mcp status remain unprotected for convenience
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // RFC 9728 Protected Resource Metadata endpoint (MCP 2025-06-18)
  // Must be accessible without authentication for discovery
  // https://datatracker.ietf.org/doc/html/rfc9728
  app.get('/.well-known/oauth-protected-resource', (c) => {
    if (!config.oauthIssuerUrl) {
      logger.debug(
        'OAuth Protected Resource Metadata requested but OAuth not configured',
        transportContext,
      );
      return c.json(
        { error: 'OAuth not configured on this server' },
        { status: 404 },
      );
    }

    const origin = new URL(c.req.url).origin;
    const resourceIdentifier =
      config.mcpServerResourceIdentifier ??
      config.oauthAudience ??
      `${origin}/mcp`;

    // Per RFC 9728, this endpoint provides metadata about the protected resource
    const metadata = {
      resource: resourceIdentifier,
      authorization_servers: [config.oauthIssuerUrl],
      bearer_methods_supported: ['header'],
      resource_signing_alg_values_supported: ['RS256', 'ES256', 'PS256'],
      resource_documentation: `${origin}/docs`,
      ...(config.oauthJwksUri && { jwks_uri: config.oauthJwksUri }),
    };

    // RFC 9728 recommends caching this metadata
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Type', 'application/json');

    logger.debug('Serving OAuth Protected Resource Metadata', {
      ...transportContext,
      resourceIdentifier,
    });

    return c.json(metadata);
  });

  app.get(config.mcpHttpEndpointPath, async (c, next) => {
    const acceptHeader = c.req.header('accept') ?? '';
    if (acceptHeader.includes('text/event-stream')) {
      return await next();
    }

    return c.json({
      status: 'ok',
      server: {
        name: config.mcpServerName,
        version: config.mcpServerVersion,
        description: config.mcpServerDescription,
        environment: config.environment,
        transport: config.mcpTransportType,
        sessionMode: config.mcpSessionMode,
      },
    });
  });

  // Create auth strategy and middleware if auth is enabled
  const authStrategy = createAuthStrategy();
  if (authStrategy) {
    const authMiddleware = createAuthMiddleware(authStrategy);
    app.use(config.mcpHttpEndpointPath, authMiddleware);
    logger.info(
      'Authentication middleware enabled for MCP endpoint.',
      transportContext,
    );
  } else {
    logger.info(
      'Authentication is disabled; MCP endpoint is unprotected.',
      transportContext,
    );
  }

  const createStatelessTransport = () => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: dnsProtectionEnabled,
      ...(allowedOriginsList ? { allowedOrigins: allowedOriginsList } : {}),
    });
    transport.onerror = (error) => {
      logger.error('HTTP transport error (stateless).', {
        ...transportContext,
        error: error instanceof Error ? error.message : String(error),
      });
    };
    return transport;
  };

  const createStatefulTransport = (
    identity: SessionIdentity | undefined,
  ): StreamableHTTPServerTransport => {
    if (!sessionStore) {
      throw new Error(
        'Session store is not initialized but stateful transport was requested.',
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => generateSecureSessionId(),
      enableDnsRebindingProtection: dnsProtectionEnabled,
      ...(allowedOriginsList ? { allowedOrigins: allowedOriginsList } : {}),
      onsessioninitialized: async (sessionId: string) => {
        sessionTransports.set(sessionId, transport);
        sessionStore.getOrCreate(sessionId, identity);
        logger.info('Initialized stateful MCP session.', {
          ...transportContext,
          sessionId,
          ...(identity?.tenantId ? { tenantId: identity.tenantId } : {}),
        });
      },
      onsessionclosed: async (sessionId: string | undefined) => {
        if (sessionId) {
          sessionTransports.delete(sessionId);
          sessionStore.terminate(sessionId);
        }
        logger.info('Closed stateful MCP session.', {
          ...transportContext,
          sessionId,
        });
      },
    });

    transport.onerror = (error) => {
      logger.error('HTTP transport error (stateful).', {
        ...transportContext,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    return transport;
  };

  // JSON-RPC over HTTP (Streamable) using the official SDK transport
  app.all(config.mcpHttpEndpointPath, async (c) => {
    const method = c.req.method.toUpperCase();
    const providedSessionId = c.req.header('mcp-session-id');
    const nodeReq = c.env.incoming as IncomingMessageWithAuth | undefined;
    const nodeRes = c.env.outgoing;

    if (!nodeReq || !nodeRes) {
      throw new Error('HTTP bindings not available for MCP transport.');
    }

    logger.debug('Handling MCP request.', {
      ...transportContext,
      path: c.req.path,
      method,
      providedSessionId,
    });

    const authStore = authContext.getStore();
    const sessionIdentity = extractSessionIdentity(authStore?.authInfo);

    let parsedBody: unknown;
    if (method === 'POST') {
      try {
        parsedBody = await c.req.json();
      } catch (error) {
        logger.warning('Invalid JSON payload received for MCP request.', {
          ...transportContext,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json(
          { error: 'Invalid JSON payload. Ensure the body is valid JSON.' },
          400,
        );
      }
    }

    const resolveTransportForRequest = () => {
      type Resolution =
        | { response: Response }
        | { transport: StreamableHTTPServerTransport; created: boolean };

      if (!isStatefulMode) {
        if (method === 'DELETE') {
          return {
            response: c.json(
              { error: 'Session termination not supported in stateless mode' },
              405,
            ),
          } satisfies Resolution;
        }

        return {
          transport: createStatelessTransport(),
          created: true,
        } satisfies Resolution;
      }

      if (!sessionStore) {
        throw new Error('Stateful session mode requires a session store.');
      }

      if (providedSessionId) {
        const isValid = sessionStore.isValidForIdentity(
          providedSessionId,
          sessionIdentity,
        );

        if (!isValid) {
          logger.warning('Session validation failed.', {
            ...transportContext,
            sessionId: providedSessionId,
            ...(sessionIdentity?.tenantId
              ? { tenantId: sessionIdentity.tenantId }
              : {}),
          });
          return {
            response: c.json({ error: 'Session not found or expired' }, 404),
          } satisfies Resolution;
        }

        const existingTransport = sessionTransports.get(providedSessionId);
        if (!existingTransport) {
          return {
            response: c.json({ error: 'Session not found or expired' }, 404),
          } satisfies Resolution;
        }

        sessionStore.getOrCreate(providedSessionId, sessionIdentity);
        return { transport: existingTransport, created: false } satisfies Resolution;
      }

      if (method !== 'POST') {
        return {
          response: c.json(
            { error: 'Mcp-Session-Id header required for this request' },
            400,
          ),
        } satisfies Resolution;
      }

      if (!isInitializationPayload(parsedBody)) {
        return {
          response: c.json(
            {
              error:
                'Initialization request required to create a new MCP session.',
            },
            400,
          ),
        } satisfies Resolution;
      }

      return {
        transport: createStatefulTransport(sessionIdentity),
        created: true,
      } satisfies Resolution;
    };

    const handleRpc = async (): Promise<Response> => {
      const resolution = resolveTransportForRequest();
      if ('response' in resolution) {
        return resolution.response;
      }

      const { transport, created } = resolution;

      if (authStore?.authInfo) {
        nodeReq.auth = authStore.authInfo;
      } else {
        delete nodeReq.auth;
      }

      try {
        if (created) {
          await mcpServer.connect(transport);
        }

        await transport.handleRequest(nodeReq, nodeRes, parsedBody);
      } finally {
        if (!isStatefulMode) {
          await transport.close().catch((error) => {
            logger.debug('Failed to close stateless transport after request.', {
              ...transportContext,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }

      return c.newResponse(null, {
        status: 204,
        headers: { [HONO_ALREADY_SENT_HEADER]: 'true' },
      });
    };

    const store = authContext.getStore();
    if (store) {
      return await authContext.run(store, handleRpc);
    }
    return await handleRpc();
  });

  logger.info('Hono application setup complete.', transportContext);
  return app;
}

async function isPortInUse(
  port: number,
  host: string,
  parentContext: RequestContext,
): Promise<boolean> {
  const context = { ...parentContext, operation: 'isPortInUse', port, host };
  logger.debug(`Checking if port ${port} is in use...`, context);
  return new Promise((resolve) => {
    const tempServer = http.createServer();
    tempServer
      .once('error', (err: NodeJS.ErrnoException) =>
        resolve(err.code === 'EADDRINUSE'),
      )
      .once('listening', () => tempServer.close(() => resolve(false)))
      .listen(port, host);
  });
}

function startHttpServerWithRetry(
  app: Hono<{ Bindings: HonoNodeBindings }>,
  initialPort: number,
  host: string,
  maxRetries: number,
  parentContext: RequestContext,
): Promise<ServerType> {
  const startContext = {
    ...parentContext,
    operation: 'startHttpServerWithRetry',
  };
  logger.info(
    `Attempting to start HTTP server on port ${initialPort} with ${maxRetries} retries.`,
    startContext,
  );

  return new Promise((resolve, reject) => {
    const tryBind = (port: number, attempt: number) => {
      if (attempt > maxRetries + 1) {
        const error = new Error(
          `Failed to bind to any port after ${maxRetries} retries.`,
        );
        logger.fatal(error.message, { ...startContext, port, attempt });
        return reject(error);
      }

      isPortInUse(port, host, { ...startContext, port, attempt })
        .then((inUse) => {
          if (inUse) {
            logger.warning(`Port ${port} is in use, retrying...`, {
              ...startContext,
              port,
              attempt,
            });
            setTimeout(
              () => tryBind(port + 1, attempt + 1),
              config.mcpHttpPortRetryDelayMs,
            );
            return;
          }

          try {
            const serverInstance = serve(
              { fetch: app.fetch, port, hostname: host },
              (info) => {
                const serverAddress = `http://${info.address}:${info.port}${config.mcpHttpEndpointPath}`;
                logger.info(`HTTP transport listening at ${serverAddress}`, {
                  ...startContext,
                  port,
                  address: serverAddress,
                });
                logStartupBanner(
                  `\n🚀 MCP Server running at: ${serverAddress}`,
                );
              },
            );
            resolve(serverInstance);
          } catch (err: unknown) {
            logger.warning(
              `Binding attempt failed for port ${port}, retrying...`,
              { ...startContext, port, attempt, error: String(err) },
            );
            setTimeout(
              () => tryBind(port + 1, attempt + 1),
              config.mcpHttpPortRetryDelayMs,
            );
          }
        })
        .catch((err) =>
          reject(err instanceof Error ? err : new Error(String(err))),
        );
    };

    tryBind(initialPort, 1);
  });
}

export async function startHttpTransport(
  mcpServer: McpServer,
  parentContext: RequestContext,
): Promise<ServerType> {
  const transportContext = {
    ...parentContext,
    component: 'HttpTransportStart',
  };
  logger.info('Starting HTTP transport.', transportContext);

  const app = createHttpApp(mcpServer, transportContext);

  const server = await startHttpServerWithRetry(
    app,
    config.mcpHttpPort,
    config.mcpHttpHost,
    config.mcpHttpMaxPortRetries,
    transportContext,
  );

  logger.info('HTTP transport started successfully.', transportContext);
  return server;
}

export async function stopHttpTransport(
  server: ServerType,
  parentContext: RequestContext,
): Promise<void> {
  const operationContext = {
    ...parentContext,
    operation: 'stopHttpTransport',
    transportType: 'Http',
  };
  logger.info('Attempting to stop http transport...', operationContext);

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        logger.error('Error closing HTTP server.', err, operationContext);
        return reject(err);
      }
      logger.info('HTTP server closed successfully.', operationContext);
      resolve();
    });
  });
}

function isInitializationPayload(payload: unknown): boolean {
  if (!payload) {
    return false;
  }

  if (Array.isArray(payload)) {
    return payload.some((message) => isInitializeRequest(message as never));
  }

  return isInitializeRequest(payload as never);
}

function extractSessionIdentity(
  authInfo?: AuthInfo,
): SessionIdentity | undefined {
  if (!authInfo) {
    return undefined;
  }

  const identity: SessionIdentity = {};
  if (authInfo.tenantId) identity.tenantId = authInfo.tenantId;
  if (authInfo.clientId) identity.clientId = authInfo.clientId;
  if (authInfo.subject) identity.subject = authInfo.subject;

  return Object.keys(identity).length > 0 ? identity : undefined;
}
