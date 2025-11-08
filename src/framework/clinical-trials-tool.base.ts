import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { MCPTool } from 'mcp-framework';
import { z, type ZodRawShape } from 'zod';

import { withRequiredScopes } from '@/mcp-server/transports/auth/lib/authUtils.js';
import {
  measureToolExecution,
  requestContextService,
  type RequestContext,
} from '@/utils/index.js';

/**
 * Shared base class for all ClinicalTrials.gov MCP tools.
 * Handles context creation, telemetry, authorization, and response formatting.
 */
export abstract class ClinicalTrialsTool<
  TSchema extends z.ZodObject<ZodRawShape>,
  TResult = unknown,
> extends MCPTool<z.infer<TSchema>, TSchema> {
  protected useStringify = false;

  /** Override to supply extra scopes when needed. */
  protected getRequiredScopes(): string[] {
    return ['tool:clinicaltrials:read'];
  }

  protected abstract runTool(
    input: z.infer<TSchema>,
    context: RequestContext,
  ): Promise<TResult>;

  protected buildResponseBlocks(
    result: TResult,
    _context: RequestContext,
  ): ContentBlock[] {
    return [this.toJsonBlock('Result', result)];
  }

  protected toJsonBlock(title: string, payload: unknown): ContentBlock {
    return {
      type: 'text',
      text: `${title}\n\n${JSON.stringify(payload, null, 2)}`,
    };
  }

  protected respondWithSummary(
    result: TResult,
    summaryBlocks: ContentBlock[] = [],
  ): ContentBlock[] {
    return [this.toJsonBlock('Structured result', result), ...summaryBlocks];
  }

  protected createExecutionContext(
    input: z.infer<TSchema>,
  ): RequestContext & { toolName: string } {
    const context = requestContextService.createRequestContext({
      operation: `tool:${this.name}`,
      toolName: this.name,
      input,
    });

    return { ...context, toolName: this.name };
  }

  protected override async execute(
    input: z.infer<TSchema>,
  ): Promise<ContentBlock[]> {
    const context = this.createExecutionContext(input);
    const scopes = this.getRequiredScopes();

    if (scopes.length > 0) {
      withRequiredScopes(scopes);
    }

    const result = await measureToolExecution(
      () => this.runTool(input, context),
      context,
      input,
    );

    return this.buildResponseBlocks(result, context);
  }
}
