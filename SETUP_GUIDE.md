# AGRYX v2 — Complete Setup Guide

## Owner: Agyat Nepal | agyatnepal01@gmail.com
## Admin login: bikalkarna@gmail.com / Nepal@12345

---

## Step 1: Supabase Database
1. Go to: https://supabase.com/dashboard/project/xuycmlqggrtupmpqmexx/sql
2. Paste entire SUPABASE_SETUP.sql and click Run
3. After you log in to the app once, run this to make yourself admin:
   ```sql
   UPDATE public.profiles SET plan = 'admin' 
   WHERE id = (SELECT id FROM auth.users WHERE email = 'bikalkarna@gmail.com');
   ```

---

## Step 2: Get Your Stripe Keys (to receive payments)

1. Go to https://stripe.com and create a free account
2. Add your bank account: Dashboard → Settings → Payouts → Add bank account
3. Get your keys: Dashboard → Developers → API Keys
   - Copy "Publishable key" (starts with pk_live_ or pk_test_)
   - Copy "Secret key" (starts with sk_live_ or sk_test_)
4. Set up webhook: Dashboard → Developers → Webhooks → Add endpoint
   - URL: https://yourdomain.com/api/webhook
   - Events: checkout.session.completed, customer.subscription.deleted
   - Copy the "Signing secret"

---

## Step 3: Vercel Environment Variables

Add these in Vercel → Project → Settings → Environment Variables:

| Key | Value |
|-----|-------|
| ANTHROPIC_API_KEY | sk-ant-api03-... |
| NEXT_PUBLIC_SUPABASE_URL | https://xuycmlqggrtupmpqmexx.supabase.co |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | sb_publishable_ryOS6UwSq6BWB6ObDBmu8Q_bTBN4n37 |
| STRIPE_SECRET_KEY | sk_live_... |
| NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | pk_live_... |
| STRIPE_WEBHOOK_SECRET | whsec_... |
| NEXT_PUBLIC_SITE_URL | https://yourdomain.com |

---

## Step 4: Deploy
Upload this zip to Vercel as a new project (don't connect GitHub).

---

## How Payments Work
- User hits 1000 chat limit → Upgrade modal appears
- They click Pro ($4.99) or Premium ($14.99)
- Stripe handles secure payment
- On success: their plan updates in Supabase automatically
- Money goes directly to YOUR Stripe account → your bank

---

## Admin Access (bikalkarna@gmail.com)
- Unlimited chats
- Full access to all features
- No payment required
- Shown as "👑 ADMIN" in sidebar

---

## PDF Syllabus Upload
Users can now upload PDF files directly. The server extracts text 
using pdf-parse and AI processes it normally.
