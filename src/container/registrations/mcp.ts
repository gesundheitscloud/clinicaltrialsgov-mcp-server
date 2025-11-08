/**
 * @fileoverview Registers MCP (Model Context Protocol) services with the DI container.
 * With mcp-framework handling tool/resource discovery, no explicit DI registrations are required.
 * @module src/container/registrations/mcp
 */
import { logger } from '@/utils/index.js';

export const registerMcpServices = (): void => {
  logger.debug(
    'MCP services managed by mcp-framework. No manual DI registrations necessary.',
  );
};
