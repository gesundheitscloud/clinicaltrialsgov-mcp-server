import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';
import { container } from 'tsyringe';
import { z } from 'zod';

import { ClinicalTrialsProvider } from '@/container/tokens.js';
import { ClinicalTrialsTool } from '@/framework/clinical-trials-tool.base.js';
import type { IClinicalTrialsProvider } from '@/services/clinical-trials-gov/core/IClinicalTrialsProvider.js';
import type { Study } from '@/services/clinical-trials-gov/types.js';
import { logger, type RequestContext } from '@/utils/index.js';
import { checkAgeEligibility } from '@/mcp-server/tools/utils/ageParser.js';
import {
  checkHealthyVolunteerEligibility,
  checkSexEligibility,
} from '@/mcp-server/tools/utils/eligibilityCheckers.js';
import {
  extractContactInfo,
  extractRelevantLocations,
  extractStudyDetails,
} from '@/mcp-server/tools/utils/studyExtractors.js';
import {
  calculateMatchScore,
  rankStudies,
} from '@/mcp-server/tools/utils/studyRanking.js';

const PatientLocationSchema = z
  .object({
    country: z.string().describe('Country (e.g., "United States")'),
    state: z.string().optional().describe('State or province'),
    city: z.string().optional().describe('City'),
    postalCode: z.string().optional().describe('Postal code'),
  })
  .describe('Patient location for geographic filtering.');

const InputSchema = z
  .object({
    age: z.number().int().min(0).max(120).describe('Patient age in years.'),
    sex: z
      .enum(['All', 'Female', 'Male'])
      .describe('Biological sex of the patient.'),
    conditions: z
      .array(z.string())
      .min(1)
      .describe(
        'List of medical conditions or diagnoses (e.g., ["Type 2 Diabetes", "Hypertension"]).',
      ),
    location: PatientLocationSchema,
    healthyVolunteer: z
      .boolean()
      .default(false)
      .describe('Whether the patient is a healthy volunteer.'),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of matching studies to return.'),
    recruitingOnly: z
      .boolean()
      .default(true)
      .describe('Only include actively recruiting studies.'),
  })
  .describe('Input parameters for finding eligible clinical trial studies.');

const EligibilityHighlightsSchema = z
  .object({
    ageRange: z.string().optional().describe('Age range for the study'),
    sex: z.string().optional().describe('Sex requirement'),
    healthyVolunteers: z
      .boolean()
      .optional()
      .describe('Whether healthy volunteers are accepted'),
    criteriaSnippet: z
      .string()
      .optional()
      .describe('Excerpt from eligibility criteria'),
  })
  .describe('Eligibility highlights for the study.');

const StudyLocationSchema = z
  .object({
    facility: z.string().optional().describe('Facility name'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State or province'),
    country: z.string().optional().describe('Country'),
    distance: z.number().optional().describe('Distance in miles'),
  })
  .describe('Study location information.');

const StudyContactSchema = z
  .object({
    name: z.string().optional().describe('Contact name'),
    phone: z.string().optional().describe('Contact phone number'),
    email: z.string().optional().describe('Contact email address'),
  })
  .describe('Study contact information.');

const StudyDetailsSchema = z
  .object({
    phase: z.array(z.string()).optional().describe('Trial phases'),
    status: z.string().describe('Overall study status'),
    enrollmentCount: z.number().optional().describe('Planned enrollment count'),
    sponsor: z.string().optional().describe('Lead sponsor name'),
  })
  .describe('Study details for ranking and display.');

const EligibleStudySchema = z
  .object({
    nctId: z.string().describe('The NCT identifier'),
    title: z.string().describe('Study title'),
    briefSummary: z.string().optional().describe('Brief study summary'),
    matchScore: z
      .number()
      .min(0)
      .max(100)
      .describe('Confidence score (0-100) for eligibility match'),
    matchReasons: z
      .array(z.string())
      .describe(
        'Reasons why this study matches (e.g., "Age within range", "Accepts females")',
      ),
    eligibilityHighlights: EligibilityHighlightsSchema,
    locations: z
      .array(StudyLocationSchema)
      .describe('Relevant study locations'),
    contact: StudyContactSchema.optional().describe('Study contact information'),
    studyDetails: StudyDetailsSchema,
  })
  .describe('An eligible clinical trial study with match details.');

const _OutputSchema = z
  .object({
    eligibleStudies: z
      .array(EligibleStudySchema)
      .describe('Array of eligible studies, ranked by relevance'),
    totalMatches: z.number().describe('Total number of eligible studies found'),
    searchCriteria: z
      .object({
        conditions: z.array(z.string()).describe('Searched conditions'),
        location: z.string().describe('Patient location summary'),
        ageRange: z.string().describe('Patient demographic summary'),
      })
      .describe('Summary of search criteria used'),
  })
  .describe('Response containing eligible clinical trial studies.');

type FindEligibleStudiesInput = z.infer<typeof InputSchema>;
type EligibleStudy = z.infer<typeof EligibleStudySchema>;
type FindEligibleStudiesOutput = z.infer<typeof _OutputSchema>;

function filterByEligibility(
  studies: Study[],
  input: FindEligibleStudiesInput,
  context: RequestContext,
): EligibleStudy[] {
  const eligible: EligibleStudy[] = [];

  for (const study of studies) {
    const eligibility = study.protocolSection?.eligibilityModule;
    if (!eligibility) {
      logger.debug('Skipping study without eligibility module', {
        ...context,
        nctId: study.protocolSection?.identificationModule?.nctId,
      });
      continue;
    }

    const matchReasons: string[] = [];
    const eligibilityChecks: Array<{ eligible: boolean; reason: string }> = [];

    const ageCheck = checkAgeEligibility(
      eligibility.minimumAge,
      (eligibility as { maximumAge?: string }).maximumAge,
      input.age,
    );
    eligibilityChecks.push(ageCheck);
    if (!ageCheck.eligible) continue;
    matchReasons.push(ageCheck.reason);

    const sexCheck = checkSexEligibility(eligibility.sex, input.sex);
    eligibilityChecks.push(sexCheck);
    if (!sexCheck.eligible) continue;
    matchReasons.push(sexCheck.reason);

    const hvCheck = checkHealthyVolunteerEligibility(
      eligibility.healthyVolunteers,
      input.healthyVolunteer,
    );
    eligibilityChecks.push(hvCheck);
    if (!hvCheck.eligible) continue;
    matchReasons.push(hvCheck.reason);

    const matchScore = calculateMatchScore(eligibilityChecks);

    const nctId =
      study.protocolSection?.identificationModule?.nctId ?? 'Unknown';
    const title =
      study.protocolSection?.identificationModule?.briefTitle ?? 'No title';
    const briefSummary = study.protocolSection?.descriptionModule?.briefSummary;

    const locations = extractRelevantLocations(study, input.location);
    if (locations.length === 0) {
      continue;
    }

    const contact = extractContactInfo(study);
    const studyDetails = extractStudyDetails(study);

    eligible.push({
      nctId,
      title,
      briefSummary,
      matchScore,
      matchReasons,
      eligibilityHighlights: {
        ageRange: `${eligibility.minimumAge ?? 'N/A'} - ${(eligibility as { maximumAge?: string }).maximumAge ?? 'N/A'}`,
        sex: eligibility.sex ?? 'All',
        healthyVolunteers: eligibility.healthyVolunteers,
        criteriaSnippet: eligibility.eligibilityCriteria?.substring(0, 300),
      },
      locations,
      contact,
      studyDetails,
    });
  }

  return eligible;
}

export default class ClinicalTrialsFindEligibleStudiesTool extends ClinicalTrialsTool<
  typeof InputSchema,
  FindEligibleStudiesOutput
> {
  name = 'clinicaltrials_find_eligible_studies';
  description =
    'Matches patient demographics and medical profiles to eligible clinical trials and returns a ranked list.';
  protected schema = InputSchema;

  protected async runTool(
    input: FindEligibleStudiesInput,
    context: RequestContext,
  ): Promise<FindEligibleStudiesOutput> {
    logger.debug('Executing findEligibleStudiesLogic', {
      ...context,
      toolInput: input,
    });

    const provider = container.resolve<IClinicalTrialsProvider>(
      ClinicalTrialsProvider,
    );

    const conditionQuery = input.conditions.join(' OR ');
    const filter = input.recruitingOnly
      ? 'STATUS:Recruiting OR STATUS:"Not yet recruiting"'
      : undefined;

    const searchParams = {
      query: conditionQuery,
      ...(filter ? { filter } : {}),
      pageSize: 100,
    } as const;

    logger.info('Searching for studies with criteria', {
      ...context,
      searchParams,
    });

    const pagedStudies = await provider.listStudies(searchParams, context);

    logger.info(`Found ${pagedStudies.studies?.length ?? 0} studies to filter`, {
      ...context,
      totalCount: pagedStudies.totalCount,
    });

    const eligibleStudies = filterByEligibility(
      pagedStudies.studies ?? [],
      input,
      context,
    );

    logger.info(`${eligibleStudies.length} studies passed eligibility checks`, {
      ...context,
    });

    const rankedStudies = rankStudies(eligibleStudies);
    const finalStudies = rankedStudies.slice(0, input.maxResults);

    logger.info(
      `Returning ${finalStudies.length} eligible studies (top ${input.maxResults})`,
      {
        ...context,
        totalEligible: eligibleStudies.length,
      },
    );

    return {
      eligibleStudies: finalStudies,
      totalMatches: eligibleStudies.length,
      searchCriteria: {
        conditions: input.conditions,
        location:
          input.location.city ?? input.location.state ?? input.location.country,
        ageRange: `${input.age} years old, ${input.sex}`,
      },
    } satisfies FindEligibleStudiesOutput;
  }

  protected override buildResponseBlocks(
    result: FindEligibleStudiesOutput,
  ): ContentBlock[] {
    return this.respondWithSummary(result, this.createSummaryBlock(result));
  }

  private createSummaryBlock(
    result: FindEligibleStudiesOutput,
  ): ContentBlock[] {
    const { eligibleStudies, totalMatches, searchCriteria } = result;

    const summary = [
      `# Eligible Clinical Trials`,
      '',
      `Found **${totalMatches}** matching studies for:`,
      `- **Conditions:** ${searchCriteria.conditions.join(', ')}`,
      `- **Location:** ${searchCriteria.location}`,
      `- **Patient:** ${searchCriteria.ageRange}`,
      '',
      `Showing top ${eligibleStudies.length} ${eligibleStudies.length === 1 ? 'result' : 'results'}:`,
      '',
      `---`,
      '',
    ];

    const studyDetails = eligibleStudies.map((study, idx) => {
      const locationList = study.locations
        .slice(0, 3)
        .map((loc) => {
          const facility = loc.facility ?? 'Unknown facility';
          const place = `${loc.city ?? 'N/A'}, ${loc.state ?? 'N/A'}`;
          const distance = loc.distance ? ` (${loc.distance} mi)` : '';
          return `- ${facility} - ${place}${distance}`;
        })
        .join('\n');

      const moreLocations =
        study.locations.length > 3
          ? `- ...and ${study.locations.length - 3} more locations`
          : '';

      return [
        `## ${idx + 1}. ${study.title}`,
        `**NCT ID:** ${study.nctId}`,
        '',
        `**Match Score:** ${study.matchScore}/100`,
        '',
        `**Why You Match:**`,
        ...study.matchReasons.map((reason) => `- ${reason}`),
        '',
        `**Eligibility Summary:**`,
        `- Age Range: ${study.eligibilityHighlights.ageRange}`,
        `- Sex: ${study.eligibilityHighlights.sex}`,
        `- Healthy Volunteers: ${study.eligibilityHighlights.healthyVolunteers ? 'Yes' : 'No'}`,
        '',
        study.briefSummary ? `**Study Summary:**\n${study.briefSummary}\n` : '',
        `**Study Details:**`,
        `- Phase: ${study.studyDetails.phase?.join(', ') ?? 'N/A'}`,
        `- Status: ${study.studyDetails.status}`,
        `- Sponsor: ${study.studyDetails.sponsor ?? 'N/A'}`,
        study.studyDetails.enrollmentCount
          ? `- Target Enrollment: ${study.studyDetails.enrollmentCount}`
          : '',
        '',
        `**Nearby Locations (${study.locations.length}):**`,
        locationList,
        moreLocations,
        '',
        study.contact
          ? `**Contact:** ${study.contact.name ?? 'N/A'}${study.contact.phone ? ` | ${study.contact.phone}` : ''}${study.contact.email ? ` | ${study.contact.email}` : ''}`
          : '',
        '',
        `---`,
        '',
      ]
        .filter(Boolean)
        .join('\n');
    });

    return [
      {
        type: 'text',
        text: summary.join('\n') + studyDetails.join(''),
      },
    ];
  }
}
