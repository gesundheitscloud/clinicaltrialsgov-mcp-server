import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from 'tsyringe';
import { z } from 'zod';

import { ClinicalTrialsProvider } from '@/container/tokens.js';
import { ClinicalTrialsTool } from '@/framework/clinical-trials-tool.base.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import { PagedStudiesSchema } from '@/services/clinical-trials-gov/types.js';
import { logger, type RequestContext } from '@/utils/index.js';

const InputSchema = z
  .object({
    query: z
      .string()
      .optional()
      .describe(
        'General search query for conditions, interventions, sponsors, or other terms.',
      ),
    filter: z
      .string()
      .optional()
      .describe(
        'Advanced filter expression using the ClinicalTrials.gov filter syntax.',
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(10)
      .describe(
        'Number of studies to return per page (1-200). Defaults to 10.',
      ),
    pageToken: z
      .string()
      .optional()
      .describe('Token for retrieving the next page of results.'),
    sort: z
      .string()
      .optional()
      .describe(
        'Sort order specification (e.g., "LastUpdateDate:desc", "EnrollmentCount").',
      ),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Specific fields to return (reduces payload size). Example: ["NCTId", "BriefTitle", "OverallStatus"].',
      ),
    country: z
      .string()
      .optional()
      .describe('Filter studies by country (e.g., "United States", "Canada").'),
    state: z
      .string()
      .optional()
      .describe(
        'Filter studies by state or province (e.g., "California", "Ontario").',
      ),
    city: z
      .string()
      .optional()
      .describe('Filter studies by city (e.g., "New York", "Toronto").'),
  })
  .describe('Input parameters for searching clinical trial studies.');

const _OutputSchema = z.object({
  pagedStudies: PagedStudiesSchema,
});

type SearchStudiesInput = z.infer<typeof InputSchema>;
type SearchStudiesOutput = z.infer<typeof _OutputSchema>;

export default class ClinicalTrialsSearchStudiesTool extends ClinicalTrialsTool<
  typeof InputSchema,
  SearchStudiesOutput
> {
  name = 'clinicaltrials_search_studies';
  description =
    'Searches for clinical trial studies from ClinicalTrials.gov using queries, filters, pagination, and sorting options.';
  protected schema = InputSchema;

  protected async runTool(
    input: SearchStudiesInput,
    context: RequestContext,
  ): Promise<SearchStudiesOutput> {
    logger.debug('Executing searchStudiesLogic', {
      ...context,
      toolInput: input,
    });

    const provider = container.resolve<IClinicalTrialsProvider>(
      ClinicalTrialsProvider,
    );

    const pagedStudies = await provider.listStudies(
      {
        ...(input.query && { query: input.query }),
        ...(input.filter && { filter: input.filter }),
        pageSize: input.pageSize,
        ...(input.pageToken && { pageToken: input.pageToken }),
        ...(input.sort && { sort: input.sort }),
        ...(input.fields && { fields: input.fields }),
        ...(input.country && { country: input.country }),
        ...(input.state && { state: input.state }),
        ...(input.city && { city: input.city }),
      },
      context,
    );

    logger.info(
      `Successfully searched studies: ${pagedStudies.studies?.length ?? 0} results`,
      {
        ...context,
        totalCount: pagedStudies.totalCount,
      },
    );

    return { pagedStudies } satisfies SearchStudiesOutput;
  }

  protected override buildResponseBlocks(
    result: SearchStudiesOutput,
    _context: RequestContext,
  ): ContentBlock[] {
    return this.respondWithSummary(result, this.createSummaryBlocks(result));
  }

  private createSummaryBlocks(result: SearchStudiesOutput): ContentBlock[] {
    const { pagedStudies } = result;
    const studyCount = pagedStudies.studies?.length ?? 0;
    const totalCount = pagedStudies.totalCount;
    const hasMore = !!pagedStudies.nextPageToken;

    const summary = [
      `Found ${studyCount} ${studyCount === 1 ? 'study' : 'studies'}`,
      totalCount ? `of ${totalCount} total` : null,
      hasMore ? '(more pages available)' : null,
    ]
      .filter(Boolean)
      .join(' ');

    const studyList = (pagedStudies.studies ?? [])
      .slice(0, 5)
      .map((s) => {
        const nctId = s.protocolSection?.identificationModule?.nctId ?? 'Unknown';
        const title =
          s.protocolSection?.identificationModule?.briefTitle ?? 'No title';
        const status =
          s.protocolSection?.statusModule?.overallStatus ?? 'Unknown status';
        return `• ${nctId}: ${title}\n  Status: ${status}`;
      })
      .join('\n');

    const moreStudies = studyCount > 5 ? `\n...and ${studyCount - 5} more` : '';

    const pagination = hasMore
      ? `\n\nNext page token: ${pagedStudies.nextPageToken}`
      : '';

    return [
      {
        type: 'text',
        text: `${summary}\n\n${studyList}${moreStudies}${pagination}`,
      },
    ];
  }
}
