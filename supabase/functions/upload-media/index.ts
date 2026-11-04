/**
 * Supabase Edge Function: upload-media
 * Validates upload session token, enforces photo/video count & byte limits,
 * verifies binary magic-byte signatures (OWASP File Upload Cheat Sheet),
 * writes to the private `customer-media` bucket under a random UUID path,
 * and links the attachment to the lead record.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('PUBLIC_SITE_URL') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-upload-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function detectMagicMime(bytes: Uint8Array): { mime: string; ext: string; kind: 'photo' | 'video' } | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg', kind: 'photo' };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mime: 'image/png', ext: 'png', kind: 'photo' };
  }
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (riff === 'RIFF' && webp === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp', kind: 'photo' };
  }
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp === 'ftyp') {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) {
      return { mime: 'image/heic', ext: 'heic', kind: 'photo' };
    }
    if (brand === 'qt  ') {
      return { mime: 'video/quicktime', ext: 'mov', kind: 'video' };
    }
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'mp4v'].includes(brand)) {
      return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
    }
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });

  try {
    const rawToken = req.headers.get('x-upload-token') || '';
    if (!rawToken) return new Response(JSON.stringify({ error: 'Upload authorization required.' }), { status: 401, headers: corsHeaders });

    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: session } = await admin.from('file_upload_sessions').select('*').eq('session_token_hash', tokenHash).eq('status', 'active').maybeSingle();
    if (!session || new Date(session.expires_at).getTime() < Date.now()) {
      return new Response(JSON.stringify({ error: 'Upload session expired or invalid.' }), { status: 401, headers: corsHeaders });
    }

    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return new Response(JSON.stringify({ error: 'No file attached.' }), { status: 400, headers: corsHeaders });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = detectMagicMime(bytes);
    if (!detected) {
      return new Response(JSON.stringify({ error: 'Unsupported or unverified file format.' }), { status: 415, headers: corsHeaders });
    }

    if (detected.kind === 'photo') {
      if (session.uploaded_photos >= session.max_photos) return new Response(JSON.stringify({ error: `Maximum ${session.max_photos} photos reached.` }), { status: 422, headers: corsHeaders });
      if (bytes.byteLength > session.max_photo_bytes) return new Response(JSON.stringify({ error: 'Photo exceeds maximum allowed file size.' }), { status: 413, headers: corsHeaders });
    } else {
      if (session.uploaded_videos >= session.max_videos) return new Response(JSON.stringify({ error: `Maximum ${session.max_videos} videos reached.` }), { status: 422, headers: corsHeaders });
      if (bytes.byteLength > session.max_video_bytes) return new Response(JSON.stringify({ error: 'Video exceeds maximum allowed file size.' }), { status: 413, headers: corsHeaders });
    }

    const shaBuf = await crypto.subtle.digest('SHA-256', bytes);
    const sha256Hex = Array.from(new Uint8Array(shaBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = new Date();
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${session.lead_id}/${crypto.randomUUID()}.${detected.ext}`;
    const safeName = (file.name || `upload.${detected.ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

    const { error: upErr } = await admin.storage.from('customer-media').upload(storageKey, bytes, {
      contentType: detected.mime,
      upsert: false
    });
    if (upErr) throw upErr;

    const { data: att, error: attErr } = await admin
      .from('lead_attachments')
      .insert({
        lead_id: session.lead_id,
        upload_session_id: session.id,
        media_kind: detected.kind,
        storage_provider: 'supabase',
        storage_bucket: 'customer-media',
        storage_key: storageKey,
        original_filename: (file.name || safeName).slice(0, 180),
        safe_filename: safeName,
        validated_mime: detected.mime,
        byte_size: bytes.byteLength,
        sha256_hex: sha256Hex
      })
      .select('id, media_kind, byte_size')
      .single();
    if (attErr) throw attErr;

    await admin
      .from('file_upload_sessions')
      .update(detected.kind === 'photo' ? { uploaded_photos: session.uploaded_photos + 1 } : { uploaded_videos: session.uploaded_videos + 1 })
      .eq('id', session.id);

    return new Response(JSON.stringify({ ok: true, attachment: att }), { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Media upload failed. Your pickup request is still saved — you can retry this file.' }), { status: 500, headers: corsHeaders });
  }
});
