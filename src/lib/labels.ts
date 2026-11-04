import type { CoverageStatus, GeoClassification, ItemAcceptance, PageStatus } from './types.ts';

export const ACCEPTANCE_LABELS: Record<ItemAcceptance, string> = {
  accepted: 'Accepted',
  'accepted-after-confirmation': 'Call to confirm',
  'quantity-limited': 'Limited quantities',
  'special-handling': 'Special handling — call first',
  'not-accepted': 'Not accepted',
  unknown: 'Ask us first'
};

export const ACCEPTANCE_HELP: Record<ItemAcceptance, string> = {
  accepted: 'We regularly pick this up. Mention it when you book.',
  'accepted-after-confirmation': 'Usually possible, but we confirm details (size, type, condition) before scheduling.',
  'quantity-limited': 'Small amounts are usually fine; larger amounts need confirmation.',
  'special-handling': 'Needs separate handling. Call first so we can confirm or point you to a better option.',
  'not-accepted': 'We do not pick this up. We can suggest where to take it.',
  unknown: 'Not confirmed yet. Call us before including it in a pickup.'
};

export const STATUS_LABELS: Record<PageStatus, string> = {
  idea: 'Idea',
  research: 'Research',
  draft: 'Draft',
  'needs-review': 'Needs review',
  approved: 'Approved',
  published: 'Published',
  noindex: 'Noindex',
  archived: 'Archived'
};

export const COVERAGE_LABELS: Record<CoverageStatus, string> = {
  active: 'Active service area',
  'available-on-confirmation': 'Available upon confirmation',
  limited: 'Limited availability',
  'temporarily-unavailable': 'Temporarily unavailable',
  'not-serviced': 'Not currently serviced',
  'research-only': 'Research only'
};

export const COVERAGE_PUBLIC_NOTE: Record<CoverageStatus, string> = {
  active: 'Active service area — regular residential, commercial, and electronics pickups available.',
  'available-on-confirmation': 'Available upon confirmation — call 251-930-8621 with your street address and load details to confirm availability.',
  limited: 'Limited availability — coverage applies only to approved portions or project types; call 251-930-8621 to check your address.',
  'temporarily-unavailable': 'Temporarily unavailable — pickups are currently paused in this area.',
  'not-serviced': 'Not currently serviced.',
  'research-only': 'Research inventory record only — not an active or advertised service area.'
};

export const CLASSIFICATION_LABELS: Record<GeoClassification, string> = {
  'incorporated-municipality': 'Incorporated Municipality',
  'official-neighborhood': 'Official Neighborhood / Historic District',
  'recognized-community': 'Recognized Community',
  'local-area-name': 'Common Local Area Name',
  'unincorporated-area': 'Unincorporated Geographic Area'
};

export function isActiveCoverage(status: CoverageStatus | string | undefined): boolean {
  return status === 'active';
}
