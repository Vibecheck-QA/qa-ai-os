# First tests: money paths (Stripe)

Goal: tests that prove five promises, each **proven able to fail**:
nobody gets paid access for free, a forged webhook does nothing, one payment is
fulfilled exactly once, the price comes from the server, and money gone means
access gone. Ask before every write.

Economics (QUALITY.md §0): no new script and no AI at push time. The tests run
in-process in the repo's own runner, so the existing test gate runs them on
every push. No Stripe network, no Stripe CLI.

## 0. Safety: test mode, local only
- Tests never reach Stripe. Replace the outbound Stripe client in tests (the
  repo's usual mocking). If any Stripe key is present in the test environment it
  must start `sk_test_` or `rk_test_`; a `sk_live_` / `rk_live_` → **stop** and
  tell the user.
- The webhook secret in tests is a made-up value set in the test environment
  (`whsec_test_qa`), never the real one.
- The database is the local one only (`supabase start` or the repo's local dev
  database). Never a hosted project.

## 1. Map the money paths
Write this list down and show it to the user before writing any test:
- **Webhook handler**: the route Stripe calls, and the runtime it runs in (Node
  or edge; edge needs `constructEventAsync`). The tests must run in that same
  runtime, or a Node-only test passes while production fails.
- **Checkout**: the endpoint that creates the Checkout Session / PaymentIntent.
- **The grant**: the table and column that mean "this user paid" (`plan`,
  `is_pro`, `subscriptions.status`, credits).
- **Every writer of the grant.** Search for every write to that table/column
  (code, SQL functions, triggers) **and** every RLS UPDATE/INSERT policy that
  covers it. The webhook should be the only writer. The most common free-access
  bug is a "users update their own profile" policy that also lets them
  `update profiles set plan = 'pro'`.
- **The revoke path**: what removes the grant, and how it finds the user (by
  Stripe customer id stored at checkout? by metadata?).
- **The server gate**: where the server decides access (route, middleware, RLS
  policy, storage policy). A paywall that only hides buttons in React is not a
  gate.

## 2. Agree the policy
Ask the user, write the answers at the top of the test file, then test them.
A test of an unstated policy is a guess.
- Refund: revoke on any refund, or only a full one? (`charge.refunded` also
  fires on partial refunds.)
- Dispute (`charge.dispute.created`): revoke now?
- Failed renewal: revoke when the subscription leaves `active`/`trialing`
  (`past_due`, `unpaid`, `canceled`, `incomplete_expired`, `paused`), or after a
  grace period? Revoking on the first `invoice.payment_failed` fights Stripe's
  automatic retries.
- Trials and 100% coupons: Checkout reports `payment_status:
  'no_payment_required'`. Do they get access?

## 3. Fixtures shaped like Stripe, not like the handler
Build events from **real Stripe object shapes**: a payload recorded from test
mode (`stripe listen --print-json`, run by the user) or an object copied from
Stripe's API reference for the repo's API version. Trim fields; **never add
one** the real object wouldn't carry. Example of the trap: Checkout Session
`metadata` is not copied onto the subscription (unless the code sets
`subscription_data.metadata`), so a `customer.subscription.deleted` fixture with
`metadata.userId` certifies a revoke handler that can't find the user in
production.

A mocked Stripe client that the handler calls back (`subscriptions.retrieve`,
`checkout.sessions.retrieve`) must return the state the event implies. A mock
looser than Stripe certifies broken fixes.

Sign events with the SDK's own helper over the **exact raw string** you send:
`stripe.webhooks.generateTestHeaderString({ payload, secret })`, plus
`timestamp` (seconds) for the old-event case.

## 4. The tests
Drive the real handler with the raw body, against the local database.

1. **No grant without payment.**
   - A user who never paid is refused by the server gate.
   - User A, with the anon client signed in as A, cannot write their own grant,
     checked with the service-role client afterwards:
     - **update** of A's existing row → 0 rows changed;
     - **insert** of a paid grant for A, with no conflicting row in the way
       (remove A's grant row with the service-role client first, if signup made
       one) → refused **by RLS** (`42501`, "violates row-level security
       policy"), not by a unique key (`23505`) or a missing column. A refusal
       for any other reason proves nothing about the policy.
2. **Forged events are refused.** Each one gets a non-2xx response and writes
   no grant:
   - no `stripe-signature` header;
   - signed with the wrong secret;
   - correctly signed with a timestamp 10 minutes old (Stripe's default
     tolerance is 300 s; the handler must not raise it or pass `0`, which turns
     the check off);
   - the webhook secret unset in the environment (catches `if (secret)` and
     `secret ?? ''` fallbacks).
   - **Control:** a correctly signed event gets 2xx and the grant **is**
     written. This catches the raw-body bug: the body parsed as JSON before
     verifying, so every real payment fails to unlock.
3. **One payment, one fulfilment.** Against the real local database (an
   in-memory store has no unique constraint, so it can't show the race):
   - the same signed `checkout.session.completed` twice in a row, and twice
     at once (`Promise.all`) → one grant, one credit, one email; both get 2xx
     (Stripe retries anything else);
   - every event the handler subscribes to for one purchase
     (`checkout.session.completed`, `invoice.paid`, `payment_intent.succeeded`
     …) → one grant. Different event ids, same purchase: the dedupe must key
     on the session or payment-intent id, not only the event id;
   - fulfilment that fails (make the grant write throw, or return an error
     the handler only logs) → a non-2xx response, so Stripe retries. A 2xx
     after a failed write loses the payment: Stripe never sends it again;
   - fulfilment that fails once, then the same
     event again → exactly one grant. Marking an event "processed" before the
     grant commits loses the payment for good, because Stripe's retry is
     deduped;
   - if the handler writes subscription status from events: an older event
     delivered after a newer one does not restore access.
   Fix shape when these fail: the grant and the processed marker in one
   transaction, behind a unique key on the purchase; never "select, then
   insert".
4. **The price comes from the server.**
   - Call the checkout endpoint with a tampered body (another price id,
     `amount: 1`, `unit_amount: 1`, `quantity: 0`): the mocked Stripe call
     receives the server's price.
   - Fulfilment trusts only the verified event: the success URL, or any
     client "confirm" endpoint, grants nothing without a paid session.
   - `checkout.session.completed` with `payment_status: 'unpaid'` grants
     nothing until `checkout.session.async_payment_succeeded`;
     `checkout.session.async_payment_failed` never grants.
   - A paid session for a cheaper price does not grant the expensive product.
     Compare the line item's **price id** (re-fetched from Stripe), never
     `amount_total`: coupons change amounts legitimately.
   - A paid session for a price the server doesn't know (another product on
     the same Stripe account) grants nothing. Catches the fallback
     `PRICE_TO_TIER[id] || 'basic'`.
5. **Money gone, access gone**, per the policy from step 2: each revoking
   event (`customer.subscription.deleted`, `customer.subscription.updated` to a
   revoking status, `charge.refunded`, `charge.dispute.created`) → the
   **server gate** refuses afterwards, not only the column.
   - **Then replay the grant events late.** Stripe doesn't guarantee delivery
     order: after each revocation, deliver that purchase's older grant events
     (`checkout.session.completed`, `invoice.paid` …, with an earlier
     `created`) → access stays denied.

Name each test after the promise: "a forged webhook grants nothing".

## 5. Prove each test can fail
Same rules as `/qa-ai-os:mutate`: baseline green, byte copy, one break at a
time, prove the break applied, restore from the copy, rerun green. Break:

| Break | Test that must go red |
|---|---|
| owner UPDATE policy also allows the grant column | 1 (update) |
| owner INSERT policy also allows a paid grant | 1 (insert) |
| server gate removed (access decided client-side) | 1 |
| verification replaced with `JSON.parse(body)` | 2 |
| `tolerance` raised (or `0`) | 2 (old timestamp) |
| a fallback when the secret is unset | 2 (secret unset) |
| dedupe removed | 3 |
| dedupe keyed on the event id only | 3 (every event for one purchase) |
| processed marker written before the grant | 3 (fails once, then retried) |
| grant failure only logged, 2xx returned | 3 (fails → non-2xx) |
| client price passed through to Stripe | 4 |
| `payment_status` not checked | 4 |
| unknown price id falls back to a tier | 4 (unknown price) |
| revoke handler a no-op | 5 |
| grant handler ignores an earlier revocation | 5 (late grant event) |
| revoke looks the user up by metadata the real object lacks | 5 (realistic fixture) |

Any break that leaves its test green: not done. Write the missing test.

## 6. Gate
The tests run in the repo's existing test gate in `.qa-ai-os.json`; if the
test command isn't a gate yet, add it.

## 7. Report
Which promises are proven, the policy as agreed, and what isn't covered:
Stripe dashboard settings, the production webhook endpoint and its real
`whsec_` in the production environment, Connect, tax and coupons beyond the
price-id check, and any grant writer the search in step 1 couldn't see
(Studio edits, manual SQL).
