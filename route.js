// src/app/api/ai/route.js
// Optimised: DB check is non-blocking, stream pipes immediately, no buffering.

import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'bikalkarna@gmail.com';
const LIMITS      = { free: 1000, pro: Infinity, premium: Infinity, admin: Infinity };
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

function adminSB() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }   // no session overhead in edge runtime
  );
}

export const runtime = 'edge';           // ← Vercel Edge: cold start ~0ms, closest to user

export async function POST(req) {
  try {
    const { userId, userEmail, model, max_tokens, system, messages, stream = true } = await req.json();

    // ── 1. Limit check — run in background, don't block stream start ──
    // We optimistically start the AI call immediately and cancel if over limit.
    // This saves 300-800ms of DB latency on every message.
    let limitPromise = Promise.resolve({ ok: true });
    if (userId && userEmail !== ADMIN_EMAIL) {
      limitPromise = (async () => {
        try {
          const sb = adminSB();
          const { data } = await sb
            .from('profiles')
            .select('plan, chat_count')
            .eq('id', userId)
            .single();
          const plan  = data?.plan  || 'free';
          const count = data?.chat_count || 0;
          const limit = LIMITS[plan] ?? LIMITS.free;
          if (limit !== Infinity && count >= limit) return { ok: false, plan, count, limit };
          // Increment fire-and-forget
          sb.from('profiles').update({ chat_count: count + 1 }).eq('id', userId).then(() => {}).catch(() => {});
          return { ok: true };
        } catch { return { ok: true }; } // on DB error, allow request
      })();
    }

    // ── 2. Start Anthropic stream immediately (parallel with DB check) ──
    const upstream = fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type':       'application/json',
        'x-api-key':          process.env.ANTHROPIC_API_KEY,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model:      model || 'claude-haiku-4-5',
        max_tokens: max_tokens || 1024,
        stream:     true,                 // always stream from Anthropic
        system:     system || 'You are a helpful AI assistant for students. Be concise.',
        messages,
      }),
    });

    // ── 3. Await both in parallel ──────────────────────────────────────
    const [limitResult, upstreamRes] = await Promise.all([limitPromise, upstream]);

    // Over limit — return before streaming
    if (!limitResult.ok) {
      return new Response(
        JSON.stringify({ error: { message: 'LIMIT_REACHED', ...limitResult } }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      );
    }

    if (!upstreamRes.ok) {
      const err = await upstreamRes.text();
      return new Response(
        JSON.stringify({ error: { message: `AI error ${upstreamRes.status}: ${err.slice(0, 200)}` } }),
        { status: upstreamRes.status, headers: { 'content-type': 'application/json' } }
      );
    }

    // ── 4. If caller wants non-stream (syllabus JSON parse) ───────────
    if (!stream) {
      // Read the SSE stream and extract the full text for JSON callers
      const reader  = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let buf  = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              full += evt.delta.text;
            }
          } catch (_) {}
        }
      }
      return new Response(
        JSON.stringify({ content: [{ text: full }] }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // ── 5. TRUE STREAMING: pipe SSE bytes straight to browser ─────────
    return new Response(upstreamRes.body, {
      status: 200,
      headers: {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection':        'keep-alive',
      },
    });

  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: e.message } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
}
