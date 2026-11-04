/**
 * Public-facing integration endpoints and telemetry config.
 * Everything here uses PUBLIC_* build-time environment variables (see .env.example).
 * Never place private keys or service-role credentials in this file.
 *
 * By default, the public static site talks to `/api/public/*` on `PUBLIC_API_BASE`
 * (empty string = same origin when hosted behind the Zoiris Command Center server
 * or reverse proxy, or a dedicated API origin such as `https://crm.zoirisjunkremoval.com`).
 * Optional third-party webhook fallback (`PUBLIC_FORM_ENDPOINT`) remains supported.
 */
export type FormProvider = 'zoiris-crm' | 'formspree' | 'gohighlevel' | 'custom' | 'none';

const env = import.meta.env;

const apiBase = (env.PUBLIC_API_BASE ?? '').trim().replace(/\/+$/, '');
const externalEndpoint = (env.PUBLIC_FORM_ENDPOINT ?? '').trim();
const explicitProvider = (env.PUBLIC_FORM_PROVIDER ?? '').trim() as FormProvider | '';

const resolvedProvider: FormProvider = explicitProvider
  ? explicitProvider
  : externalEndpoint
    ? 'custom'
    : 'zoiris-crm';

export const integrations = {
  apiBase,
  form: {
    provider: resolvedProvider,
    endpoint: externalEndpoint || `${apiBase}/api/public/inquiries`,
    uploadConfigEndpoint: `${apiBase}/api/public/upload-config`,
    uploadEndpoint: `${apiBase}/api/public/uploads`,
    uploadCompleteEndpoint: `${apiBase}/api/public/uploads/complete`,
    addressSuggestEndpoint: `${apiBase}/api/public/address/suggest`,
    addressVerifyEndpoint: `${apiBase}/api/public/address/verify`,
    addressReverseEndpoint: `${apiBase}/api/public/address/reverse`,
    allowUploads: resolvedProvider === 'zoiris-crm' || env.PUBLIC_FORM_ALLOW_UPLOADS === 'true'
  },
  analytics: {
    eventsEndpoint: `${apiBase}/api/public/events`,
    ga4Id: (env.PUBLIC_GA4_ID ?? '').trim() || null
  },
  searchConsole: {
    verification: (env.PUBLIC_GSC_VERIFICATION ?? '').trim() || null
  }
} as const;
