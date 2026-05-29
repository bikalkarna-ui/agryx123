export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FREE_LIMIT = 1000;
const ADMIN_EMAIL = 'bikalkarna@gmail.com';

export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY;
  return new Response(
    JSON.stringify({ status: 'API route working', hasKey: !!key, keyPrefix: key ? key.slice(0, 10) + '...' : 'NOT SET' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

export async function POST(request) {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return new Response(
        JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY is not set' } }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }

    const body = await request.json();
    const { userId, userEmail, userPlan, chatCount } = body;

    // Admin always gets unlimited
    const isAdmin = userEmail === ADMIN_EMAIL;

    // Enforce free limit
    if (!isAdmin && (!userPlan || userPlan === 'free')) {
      if ((chatCount || 0) >= FREE_LIMIT) {
        return new Response(
          JSON.stringify({ error: { message: 'LIMIT_REACHED' } }),
          { status: 403, headers: { 'content-type': 'application/json' } }
        );
      }
    }

    // Build messages - handle both text strings and content arrays (with images)
    const messages = (body.messages || []).map(msg => {
      // If content is already an array (image + text), pass through directly
      if (Array.isArray(msg.content)) {
        return { role: msg.role, content: msg.content };
      }
      return { role: msg.role, content: msg.content };
    });

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-5',
        max_tokens: body.max_tokens || 1500,
        stream: false,
        system: body.system || 'You are a helpful assistant.',
        messages,
      }),
    });

    const data = await upstream.json();
    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err.message } }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }
}
