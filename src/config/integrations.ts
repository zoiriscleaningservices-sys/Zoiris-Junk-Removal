/**
 * Public-facing integration endpoints and telemetry config.
 * Everything here uses PUBLIC_* build-time environment variables (see .env.example).
 * Never place private keys or service-role credentials in this file.
 *
 * By default, the public static site talks to `/api/public/*` on `PUBLIC_API_BASE`
 * (empty string = same origin when hosted behind the Zoiris Command Center server
 * or reverse proxy, or a dedicated API origin such as `https://crm.zoirisjunkremoval.com`).
 *
 * On https://www.zoirisjunkremoval.com (and static GitHub Pages), `QuoteForm.astro`
 * submits directly to the encrypted 24/7 Cloud Bridge (with E2E RSA-OAEP-2048 fallback)
 * and dispatches instant real-time browser sync + installed-app Web Push notifications.
 */
export type FormProvider = 'zoiris-crm' | 'formspree' | 'gohighlevel' | 'custom' | 'none';

const env = import.meta.env;

const apiBase = (env.PUBLIC_API_BASE ?? '').trim().replace(/\/+$/, '');
const staticCloudOnly = env.PUBLIC_STATIC_CLOUD_MODE === '1' && !apiBase;
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
  cloudRelay: {
    enabledByBuild: env.PUBLIC_STATIC_CLOUD_MODE === '1',
    cloudBridgeUrl: (env.PUBLIC_CLOUD_BRIDGE_URL ?? 'https://zoiris-cloud-bridge.vercel.app').trim().replace(/\/+$/, ''),
    relayUrl: (env.PUBLIC_RELAY_URL ?? 'https://ntfy.sh').trim().replace(/\/+$/, ''),
    topic: (env.PUBLIC_RELAY_TOPIC ?? 'zoiris_pickup_eeaf07c6f04d03eee2').trim(),
    // One-way RSA-OAEP-2048 SPKI Public Key (can ONLY encrypt customer submissions; private key never leaves .zoiris-private)
    publicKeySpkiB64: (
      env.PUBLIC_RELAY_PUBKEY ??
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw1Ag5ROEE2hWFrLfIqhIljK2LsuqatCQPuE/XnT17uv9YMsO7HJ98HzzXH/Ol8tw/5gSmuIT7Chzt/B8ZyXk9eZVxtJMk81B919LOQbwORfz8o/yyauplw8BXLvBUAReEchbhboN6l8iqSCmj4zaglObNEAxnxZPijJBnPR5ujDa1xKA+/vY42metVDXAgLmytlgK9gwKrJ+8cJVt/nFMdiLpI+4nu7Dqyw9I45S4KlXzkLLIpvB3DG3axxFN7dGhH8f1JM3VP0uAw29xASMQ/S/G/x4zGOgplqz3Zs4ZLdI6hpIriN3WBfrMQ6ClwbD3WUT+smnDzAaithEclr+hQIDAQAB'
    ).trim(),
    ownerClickUrl: (
      env.PUBLIC_OWNER_APP_URL ?? 'https://www.zoirisjunkremoval.com/owner/command-center/?sync=1'
    ).trim()
  },
  analytics: {
    eventsEndpoint: staticCloudOnly ? '' : `${apiBase}/api/public/events`,
    ga4Id: (env.PUBLIC_GA4_ID ?? '').trim() || null
  },
  searchConsole: {
    verification: (env.PUBLIC_GSC_VERIFICATION ?? '').trim() || null
  }
} as const;
