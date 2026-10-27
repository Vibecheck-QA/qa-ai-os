---
name: first-tests
description: Write the first tests that matter most for an AI-built app — user A can never read or change user B's data, and nobody gets paid features without paying. For Supabase apps, installs a push gate that reads the database's own catalog and fails on tables with RLS off, policies that let everyone through, views and functions that bypass RLS, then writes two-user tests. For Stripe apps, writes tests that forged webhooks are refused, a payment is fulfilled exactly once, the price comes from the server, and refunds and cancellations remove access. Every test is proven able to fail. Use when the user says "first tests", "test my app", "is my data safe", "check RLS", "can users see each other's data", "test my payments", "check my Stripe webhook", "can someone get it free", or a repo on Supabase or Stripe has no tests.
---

# QA AI OS — first tests

The two promises an AI-built app breaks most often, and that cost the most when
broken: **data isolation** (user B never sees user A's data) and **money paths**
(nobody gets what they didn't pay for, and nobody pays twice). Each pack writes
behaviour tests in the repo's own runner and proves every test can fail. Ask
before every write.

## 1. Read what exists
- **Supabase?** `supabase/config.toml`, `supabase/migrations/`, `@supabase/supabase-js`
  (or `supabase-py`, `supabase-flutter`).
- **Payments?** `stripe` in the dependencies, `STRIPE_` environment variables, a
  webhook route (`constructEvent`, `/api/webhooks/stripe`). Another provider
  (Lemon Squeezy, Paddle, Polar …): the money pack's promises still hold; say
  it is written for Stripe and adapt the signing.
- The test runner the repo already uses (`vitest`, `jest`, `pytest`, …). None →
  offer the smallest one for the stack; don't add a second runner.

Neither applies → say so and stop; these packs don't fit yet.

## 2. Run the packs that apply
Data isolation first when both apply: the money tests reuse its two-user setup.

- **Data isolation (Supabase):** follow `${CLAUDE_PLUGIN_ROOT}/skills/first-tests/data-isolation.md`.
- **Money paths (Stripe):** follow `${CLAUDE_PLUGIN_ROOT}/skills/first-tests/money-paths.md`.

## 3. Report
Plain English first: which promises are proven, what was allowed or agreed and
why, what isn't covered. Then the files written and the gates added.
