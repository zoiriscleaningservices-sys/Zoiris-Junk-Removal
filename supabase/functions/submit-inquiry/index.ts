/**
 * Supabase Edge Function: submit-inquiry
 * Public customer pickup request endpoint. Uses server-side validation,
 * idempotency keys, customer deduplication Lookup, and mints a short-lived
 * upload session token for Step 4/5 customer photo & video attachments.
 *
 * Service-role credentials remain strictly inside the Edge runtime.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('PUBLIC_SITE_URL') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function clean(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

    const body = await req.json();
    if (body._gotcha) {
      return new Response(JSON.stringify({ error: 'Invalid submission' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const firstName = clean(body.firstName, 80);
    const lastName = clean(body.lastName, 80);
    const phoneDigits = clean(body.phone, 30).replace(/\D/g, '');
    const pickupAddress = clean(body.pickupAddress, 240);
    const city = clean(body.city, 100);
    const state = clean(body.state || 'AL', 10) || 'AL';
    const zipCode = clean(body.zipCode, 15);
    const requestedService = clean(body.requestedService || 'Junk Removal', 120);

    if (!firstName || !lastName || phoneDigits.length < 10 || !pickupAddress || !city || !zipCode || !body.consentGiven) {
      return new Response(JSON.stringify({ error: 'Required customer and pickup location fields are incomplete.' }), {
        status: 422,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const phoneE164 = phoneDigits.length === 10 ? `+1${phoneDigits}` : `+${phoneDigits}`;
    const idempotencyKey = clean(req.headers.get('x-idempotency-key') || body.idempotencyKey, 120) || null;

    if (idempotencyKey) {
      const { data: existingLead } = await admin.from('leads').select('id, lead_number').eq('idempotency_key', idempotencyKey).maybeSingle();
      if (existingLead) {
        return new Response(JSON.stringify({ ok: true, deduplicated: true, leadId: existingLead.id, leadNumber: existingLead.lead_number }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Match existing non-merged customer by exact E.164 phone
    const { data: matchedCustomer } = await admin
      .from('customers')
      .select('id')
      .eq('phone_e164', phoneE164)
      .is('merged_into_id', null)
      .limit(1)
      .maybeSingle();

    let customerId = matchedCustomer?.id;
    const fullName = `${firstName} ${lastName}`.trim();
    if (!customerId) {
      const { data: createdCustomer, error: custErr } = await admin
        .from('customers')
        .insert({
          first_name: firstName,
          last_name: lastName,
          full_name: fullName,
          phone_e164: phoneE164,
          phone_display: clean(body.phone, 30),
          email: clean(body.email, 160) || null,
          street_address: pickupAddress,
          city,
          state,
          zip_code: zipCode,
          customer_type: body.customerType === 'commercial' ? 'commercial' : 'residential',
          preferred_contact: ['phone', 'sms', 'email'].includes(body.preferredContact) ? body.preferredContact : 'phone',
          last_contact_at: new Date().toISOString()
        })
        .select('id')
        .single();
      if (custErr) throw custErr;
      customerId = createdCustomer.id;
    }

    const items = Array.isArray(body.items) ? body.items.slice(0, 60) : [];
    const hasEwaste = Boolean(body.hasEwaste || items.some((i: { isEwaste?: boolean }) => i?.isEwaste));

    const { data: lead, error: leadErr } = await admin
      .from('leads')
      .insert({
        idempotency_key: idempotencyKey,
        customer_id: customerId,
        status: 'new',
        is_unread: true,
        customer_first_name: firstName,
        customer_last_name: lastName,
        customer_name: fullName,
        customer_phone: clean(body.phone, 30),
        customer_email: clean(body.email, 160) || null,
        preferred_contact: ['phone', 'sms', 'email'].includes(body.preferredContact) ? body.preferredContact : 'phone',
        customer_type: body.customerType === 'commercial' ? 'commercial' : 'residential',
        pickup_address: pickupAddress,
        city,
        state,
        zip_code: zipCode,
        requested_service: requestedService,
        has_ewaste: hasEwaste,
        item_categories: Array.isArray(body.categories) ? body.categories.slice(0, 20) : [],
        item_description: clean(body.itemDescription, 2000),
        estimated_quantity: clean(body.estimatedQuantity, 120) || null,
        estimated_dimensions: clean(body.estimatedDimensions, 160) || null,
        indoor_outdoor: clean(body.indoorOutdoor, 60) || null,
        floor_level: clean(body.floorLevel, 60) || null,
        stairs_info: clean(body.stairsInfo, 120) || null,
        elevator_available: clean(body.elevatorAvailable, 60) || null,
        is_disassembled: clean(body.isDisassembled, 60) || null,
        access_instructions: clean(body.accessInstructions, 1500) || null,
        preferred_date: clean(body.preferredDate, 30) || null,
        preferred_window: clean(body.preferredWindow, 80) || null,
        customer_notes: clean(body.customerNotes, 2000) || null,
        consent_given: true,
        source_url: clean(body.sourceUrl, 500) || null,
        referrer_url: clean(body.referrerUrl, 500) || null,
        utm_source: clean(body.utmSource, 120) || null,
        utm_medium: clean(body.utmMedium, 120) || null,
        utm_campaign: clean(body.utmCampaign, 160) || null,
        device_category: ['mobile', 'tablet', 'desktop'].includes(body.deviceCategory) ? body.deviceCategory : 'unknown'
      })
      .select('id, lead_number')
      .single();
    if (leadErr) throw leadErr;

    if (items.length) {
      await admin.from('lead_items').insert(
        items.map((it: { category?: string; label?: string; isEwaste?: boolean; requiresConfirmation?: boolean }) => ({
          lead_id: lead.id,
          category: clean(it.category || 'Other', 60),
          item_label: clean(it.label || 'Item', 120),
          is_ewaste: Boolean(it.isEwaste),
          requires_confirmation: Boolean(it.requiresConfirmation)
        }))
      );
    }

    await admin.from('lead_events').insert({
      lead_id: lead.id,
      event_type: 'inquiry_received',
      actor_name: 'Public Website',
      summary: `Pickup request ${lead.lead_number} submitted from ${city}, ${state}`
    });

    await admin.from('notifications').insert({
      lead_id: lead.id,
      channel: 'dashboard',
      kind: 'new_lead',
      title: `New pickup request ${lead.lead_number}`,
      body: `${fullName} (${city}, ${zipCode}) — ${requestedService}`
    });

    // Mint short-lived upload session token (30 min) for customer media uploads
    const rawToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

    await admin.from('file_upload_sessions').insert({
      lead_id: lead.id,
      session_token_hash: tokenHash,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    });

    return new Response(
      JSON.stringify({
        ok: true,
        leadId: lead.id,
        leadNumber: lead.lead_number,
        uploadToken: rawToken
      }),
      { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('submit-inquiry failed');
    return new Response(
      JSON.stringify({ error: 'We could not save your pickup request right now. Please call 251-930-8621.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
