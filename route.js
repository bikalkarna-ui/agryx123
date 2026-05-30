// src/app/api/ai/route.js
// FIXED: Real SSE streaming — no more waiting for full response

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'bikalkarna@gmail.com';
const LIMITS = { free: 1000, pro: Infinity, premium: Infinity, admin: Infinity };

function adminSB() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export async function POST(req) {
  try {
    const body = await req.json();
    const {
      userId,
      userEmail,
      model,
      max_tokens,
      system,
      messages,
      stream = true,   // DEFAULT to streaming now
    } = body;

    // ── Chat-limit check (non-blocking for stream start) ────────────
    if (userId && userEmail !== ADMIN_EMAIL) {
      const sb = adminSB();
      const { data: profile } = await sb
        .from('profiles')
        .select('plan, chat_count')
        .eq('id', userId)
        .single();

      const plan  = profile?.plan  || 'free';
      const count = profile?.chat_count || 0;
      const limit = LIMITS[plan] ?? LIMITS.free;

      if (limit !== Infinity && count >= limit) {
        // Return a plain JSON error — client handles it
        return NextResponse.json(
          { error: { message: 'LIMIT_REACHED', plan, count, limit } },
          { status: 403 }
        );
      }

      // Increment count fire-and-forget — doesn't block the stream
      sb.from('profiles')
        .update({ chat_count: count + 1 })
        .eq('id', userId)
        .then(() => {})
        .catch(() => {});
    }

    // ── Call Anthropic with streaming ON ────────────────────────────
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model || 'claude-haiku-4-5',   // Haiku is 3-5x faster than Sonnet for short tasks
        max_tokens: max_tokens || 1024,
        stream:     true,                           // Always stream to Anthropic
        system:     system || 'You are a helpful AI assistant for students. Be concise.',
        messages,
      }),
    });

    if (!upstream.ok) {
      const err = await upstream.text();
      return NextResponse.json(
        { error: { message: `Anthropic error ${upstream.status}: ${err.slice(0, 200)}` } },
        { status: upstream.status }
      );
    }

    if (stream) {
      // ── TRUE STREAMING: pipe Anthropic SSE straight to client ─────
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection':    'keep-alive',
          'X-Accel-Buffering': 'no',   // disable Nginx buffering on Vercel
        },
      });
    }

    // ── Non-stream fallback (for syllabus JSON parse) ────────────────
    const data = await upstream.json();
    return NextResponse.json(data);

  } catch (e) {
    console.error('/api/ai error:', e);
    return NextResponse.json(
      { error: { message: e.message } },
      { status: 500 }
    );
  }
}
