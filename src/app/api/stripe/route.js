export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLANS = {
  pro: {
    name: 'AGRYX Pro',
    price: 499, // $4.99 in cents
    chats: 999999,
  },
  premium: {
    name: 'AGRYX Premium',
    price: 1499, // $14.99 in cents
    chats: 999999,
  },
};

export async function POST(request) {
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }

    const { plan, userId, userEmail, siteUrl } = await request.json();
    const planData = PLANS[plan];
    if (!planData) return new Response(JSON.stringify({ error: 'Invalid plan' }), { status: 400, headers: { 'content-type': 'application/json' } });

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(stripeKey);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: planData.name,
            description: plan === 'pro' ? 'Unlimited AI chats + all features' : 'Unlimited everything + priority support',
          },
          unit_amount: planData.price,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${siteUrl}?payment=success&plan=${plan}`,
      cancel_url: `${siteUrl}?payment=cancelled`,
      customer_email: userEmail,
      metadata: { userId, plan },
    });

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
}
