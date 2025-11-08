/**
 * Cloudflare Worker stub while the MCP server runs exclusively via mcp-framework.
 * The previous bespoke HTTP transport is no longer available, so serverless
 * deployments should be disabled until a new worker-compatible transport exists.
 */
import { requestContextService } from '@/utils/index.js';
import { logger } from '@/utils/internal/logger.js';

export interface CloudflareBindings {
  [key: string]: unknown;
}

export default {
  fetch(request: Request): Response {
    const context = requestContextService.createRequestContext({
      operation: 'WorkerFetchUnsupported',
      url: request.url,
      method: request.method,
    });

    logger.warning(
      'Cloudflare Worker fetch invoked, but mcp-framework currently supports only Node transports.',
      context,
    );

    return new Response(
      JSON.stringify({
        error: 'Cloudflare deployment temporarily unavailable',
        message:
          'This MCP server now relies on mcp-framework transports that require a Node runtime.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },

  scheduled(event: ScheduledEvent): void {
    const context = requestContextService.createRequestContext({
      operation: 'WorkerScheduledUnsupported',
      cron: event.cron,
    });

    logger.warning(
      'Cloudflare scheduled event ignored because serverless mode is disabled.',
      context,
    );
  },
};

interface ScheduledEvent {
  cron: string;
}
