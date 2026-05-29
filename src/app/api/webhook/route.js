export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripeKey) return new Response('Stripe not configured', { status: 500 });

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeKey);
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

    const body = await request.text();
    const sig = request.headers.get('stripe-signature');

    let event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch {
      return new Response('Webhook signature invalid', { status: 400 });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const { userId, plan } = session.metadata;
      await sb.from('profiles').update({
        plan: plan,
        plan_expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        chat_count: 0,
      }).eq('id', userId);
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      // Find user by customer and reset to free
      const { data: profiles } = await sb.from('profiles').select('id').eq('stripe_customer', sub.customer);
      if (profiles?.[0]) {
        await sb.from('profiles').update({ plan: 'free', plan_expires: null }).eq('id', profiles[0].id);
      }
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }
}
