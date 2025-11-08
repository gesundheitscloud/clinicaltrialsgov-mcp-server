import { container } from 'tsyringe';
import { z } from 'zod';

import { ClinicalTrialsProvider } from '@/container/tokens.js';
import { ClinicalTrialsTool } from '@/framework/clinical-trials-tool.base.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import {
  StudySchema,
  type Study,
} from '@/services/clinical-trials-gov/types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger, type RequestContext } from '@/utils/index.js';

const StudySummarySchema = z
  .object({
    nctId: z.string().optional().describe('The NCT identifier of the study.'),
    title: z.string().optional().describe('The official title of the study.'),
    briefSummary: z
      .string()
      .optional()
      .describe('A brief summary of the study purpose.'),
    overallStatus: z
      .string()
      .optional()
      .describe('The current recruitment status of the study.'),
    conditions: z
      .array(z.string())
      .optional()
      .describe('List of medical conditions being studied.'),
    interventions: z
      .array(
        z.object({
          name: z.string().optional().describe('Name of the intervention.'),
          type: z.string().optional().describe('Type of intervention.'),
        }),
      )
      .optional()
      .describe('List of interventions being tested.'),
    leadSponsor: z
      .string()
      .optional()
      .describe('The lead sponsor organization.'),
  })
  .passthrough()
  .describe('Concise summary of a clinical trial study.');

const InputSchema = z
  .object({
    nctIds: z
      .union([
        z
          .string()
          .regex(/^[Nn][Cc][Tt]\d{8}$/, 'NCT ID must be 8 digits')
          .describe('A single NCT ID (e.g., "NCT12345678").'),
        z
          .array(
            z.string().regex(/^[Nn][Cc][Tt]\d{8}$/, 'NCT ID must be 8 digits'),
          )
          .min(1, 'At least one NCT ID is required.')
          .max(5, 'Maximum 5 NCT IDs allowed per request.')
          .describe('An array of up to 5 NCT IDs.'),
      ])
      .describe(
        'A single NCT ID or an array of up to 5 NCT IDs to fetch.',
      ),
    summaryOnly: z
      .boolean()
      .default(false)
      .describe(
        'If true, returns concise summaries. If false, returns full study data.',
      ),
  })
  .describe('Input parameters for fetching clinical trial studies.');

const _OutputSchema = z
  .object({
    studies: z
      .array(z.union([StudySchema, StudySummarySchema]))
      .describe('Array of full study data or summaries.'),
    errors: z
      .array(
        z.object({
          nctId: z.string().describe('The NCT ID that failed.'),
          error: z.string().describe('Error message for this NCT ID.'),
        }),
      )
      .optional()
      .describe('Any errors encountered while fetching studies.'),
  })
  .describe('Response containing study data and any errors.');

type GetStudyInput = z.infer<typeof InputSchema>;
type StudySummary = z.infer<typeof StudySummarySchema>;
type GetStudyOutput = z.infer<typeof _OutputSchema>;

function createStudySummary(study: Study): StudySummary {
  return {
    nctId: study.protocolSection?.identificationModule?.nctId,
    title: study.protocolSection?.identificationModule?.officialTitle,
    briefSummary: study.protocolSection?.descriptionModule?.briefSummary,
    overallStatus: study.protocolSection?.statusModule?.overallStatus,
    conditions: study.protocolSection?.conditionsModule?.conditions,
    interventions:
      study.protocolSection?.armsInterventionsModule?.interventions?.map(
        (i) => ({
          name: i.name,
          type: i.type,
        }),
      ),
    leadSponsor:
      study.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name,
  } satisfies StudySummary;
}

export default class ClinicalTrialsGetStudyTool extends ClinicalTrialsTool<
  typeof InputSchema,
  GetStudyOutput
> {
  name = 'clinicaltrials_get_study';
  description =
    'Fetches one or more clinical trial studies from ClinicalTrials.gov by their NCT IDs, optionally returning concise summaries.';
  protected schema = InputSchema;

  protected async runTool(
    input: GetStudyInput,
    context: RequestContext,
  ): Promise<GetStudyOutput> {
    const nctIds = Array.isArray(input.nctIds) ? input.nctIds : [input.nctIds];

    logger.debug(`Executing getStudyLogic for NCT IDs: ${nctIds.join(', ')}`, {
      ...context,
      toolInput: input,
    });

    const provider = container.resolve<IClinicalTrialsProvider>(
      ClinicalTrialsProvider,
    );

    const studies: (Study | StudySummary)[] = [];
    const errors: { nctId: string; error: string }[] = [];

    await Promise.all(
      nctIds.map(async (nctId) => {
        try {
          const study = await provider.fetchStudy(nctId, context);

          logger.info(`Successfully fetched study ${nctId}`, { ...context });

          if (input.summaryOnly) {
            studies.push(createStudySummary(study));
          } else {
            studies.push(study);
          }
        } catch (error) {
          const errorMessage =
            error instanceof McpError
              ? error.message
              : 'An unexpected error occurred';
          logger.warning(`Failed to fetch study ${nctId}: ${errorMessage}`, {
            ...context,
            nctId,
            error,
          });
          errors.push({ nctId, error: errorMessage });
        }
      }),
    );

    if (studies.length === 0 && errors.length > 0) {
      throw new McpError(
        JsonRpcErrorCode.ServiceUnavailable,
        `Failed to fetch any studies. Errors: ${errors
          .map((e) => `${e.nctId}: ${e.error}`)
          .join('; ')}`,
        { errors },
      );
    }

    const result: GetStudyOutput = { studies };
    if (errors.length > 0) {
      result.errors = errors;
    }

    return result;
  }
}
