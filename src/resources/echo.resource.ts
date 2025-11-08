import { MCPResource, type ResourceContent } from 'mcp-framework';

import { logger, requestContextService } from '@/utils/index.js';

export default class EchoResource extends MCPResource {
  uri = 'echo://hello';
  name = 'echo-resource';
  description = 'A simple echo resource that returns a message.';
  mimeType = 'application/json';

  read(): Promise<ResourceContent[]> {
    const context = requestContextService.createRequestContext({
      operation: 'resource:echo',
      resourceUri: this.uri,
    });

    const payload = {
      message: 'Hello from ClinicalTrials.gov MCP server!',
      timestamp: new Date().toISOString(),
      requestUri: this.uri,
    };

    logger.debug('Echo resource processed successfully.', {
      ...context,
      responsePayloadSummary: {
        messageLength: payload.message.length,
      },
    });

    return Promise.resolve([
      {
        uri: this.uri,
        mimeType: this.mimeType,
        text: JSON.stringify(payload, null, 2),
      },
    ]);
  }
}
