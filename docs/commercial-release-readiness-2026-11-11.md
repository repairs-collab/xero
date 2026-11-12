# AccountPulse commercial release readiness

- Assessment date: 11 November 2026
- Market: Australia initially; New Zealand is deferred
- Current Xero tier: Starter, maximum five connected Xero organisations

## Decision

AccountPulse can proceed to a **free, invitation-only beta of up to five Xero
organisations** after the current safety release is merged and deployed and an
owner-approved Australian numeric reply number has passed a real send/reply
test for each invited customer. It is **not ready to charge beta customers or
open public self-service signup** yet.

The live `ap.motts.com.au` TLS and readiness endpoint were verified after the
older deployment notes were written, so TLS is not treated as a current launch
blocker.

## Safety update — 12 November 2026

The commercial safety release selects a hard cap for Solo SMS usage. Every send
whose complete part count would exceed the configured included allowance is
blocked before provider submission, with no paid overage or automatic replay.
Legacy overage database columns remain only for compatibility and do not grant
runtime authority. Local unit, rendered-copy and PostgreSQL regressions cover
this rule. The verified release candidate passed 706 unit tests across 118
files and 496 integration tests across 62 files on the isolated local
PostgreSQL 18 test database on 12 November 2026.

The payment-operations foundation now records signed payment failures,
recoveries, refunds and disputes as tenant-safe billing cases; holds customer
sending for unresolved financial risk; prevents owner reactivation while a
blocking case remains unresolved; and exposes a private read-only owner queue.
Associated customer notices remain **held and not delivered**. This foundation
does not close SMTP/template delivery, processor receipts, cancellation proof,
dunning timing or the complete real-customer journey.

The five-customer beta will use one dedicated Australian numeric two-way reply
number per paid customer. Phone-number-only messaging does not depend on a
branded alphanumeric Sender ID or EMSP registration. The beta will not maintain
a spare number pool: each number requires one explicit owner-approved
just-in-time order. Automatic purchase remains disabled until Sinch confirms
the exact per-number price, required documentation and API process and the
owner approves a spend ceiling. No number has been purchased by this release.

## Release stages

| Stage | Current position | Required next work |
| --- | --- | --- |
| Free invite beta (maximum five Xero organisations) | Achievable after the current safety release | Use owner-assisted onboarding; obtain explicit approval before each Australian numeric number order; verify the number and run one real invite/MFA/legal/Xero/send/reply journey; document beta support and incident contacts. |
| Paid controlled beta | Not ready | Close every P0 item below and upgrade Xero before connection six. |
| Public self-service | Not ready | Close P0 and P1, then verify the complete unassisted signup and cancellation journeys. |
| Xero App Store | Later milestone | Reach a stable beta cohort, certify the app, move to Plus and complete Sign Up with Xero and listing review. |

## Xero path from the five-connection limit

- Starter permits five unique connected Xero tenants. Multiple users connected
  to the same tenant count as one connection. The Mott organisation counts if it
  is connected, so confirm the remaining capacity in the Developer Portal.
- Add a payment method and move to Core **before connection six**. Core permits
  50 connections and is currently AUD 35 per month, tax exclusive.
- Starter and Core cannot be listed in the Xero App Store. Plus permits 1,000
  connections, currently costs AUD 245 per month tax exclusive, requires app
  certification and makes an App Store listing optional.
- Xero recommends applying for an App Store listing after onboarding about ten
  beta customers. In practice: **Starter (up to 5) → Core (6–50 and beta proof)
  → certification/Plus → App Store**.
- Keep the commercial product on standard customer OAuth with offline access
  and the minimum granular scopes. A Custom Connection supports only one Xero
  organisation, is not Marketplace eligible, and Xero stops new Custom
  Connection apps and subscriptions from 1 December 2026.
- Xero's newer pricing page says the platform is moving away from revenue share,
  while an App Store referral guide still describes a 15% ARPU referral fee.
  Obtain written confirmation from Xero about the model that will apply to this
  app before finalising retail prices.

## P0 — complete before charging any customer

1. **Stripe access rules — verified.** Provider payment risk now wins over a
   scheduled cancellation, ambiguous historical rows fail closed, and the
   migration plus boundary regressions pass against PostgreSQL. This item is
   closed for the current release.
2. **One trial per customer — verified.** Checkout can preserve or shorten the
   original local trial but cannot create a fresh trial. Cancelled subscription
   identifiers are retired, cross-tenant ownership is rejected, and both
   webhook orderings pass against PostgreSQL. This item is closed for the
   current release.
3. **Finish the legal/commercial identity.** Swan Hill Appliance Repairs Pty
   Ltd (ABN 86 633 952 333; ACN 633 952 333) is the GST-registered seller and
   owner of AccountPulse. The initial market and currency are Australia and AUD.
   The owner has selected `ap@motts.com.au` for support, billing, privacy and
   legal notices. The commercial product has no free trial; payment is due on
   signup; monthly and annual terms are offered with a 5% annual discount;
   cancellation takes effect at period end; unused SMS expires monthly; incurred
   number fees are non-refundable subject to law; failed payment starts a 30-day
   recovery period; and account records are retained for five years after
   cancellation. Confirm the business address, GST price presentation,
   subprocessors, security contact and incident-notification terms with
   Australian legal and accounting review. Track decisions in
   `docs/commercial-legal-inputs.md`.
4. **Complete numeric SMS supply.** Branded Sender ID and EMSP participation are
   deferred because the beta uses Australian phone numbers as the visible
   sender. Obtain Sinch's written per-number price, ordering/API requirements,
   supporting-document requirements and reply/billing terms. Approve a spend
   ceiling before enabling purchase. For the five-customer beta, make one
   idempotent owner-approved just-in-time order per paid customer, keep the
   customer visibly pending until provider confirmation, and prove outbound
   delivery plus inbound reply routing. Do not pre-purchase a spare pool or
   enable automatic purchase yet.
5. **Selected SMS hard cap — verified.** Launch UI, Terms and support guidance
   no longer promise paid overage, and runtime authorization blocks sends above
   the configured included allowance even when legacy overage fields are set.
   The PostgreSQL hard-cap regressions and full integration project pass. This
   item is closed; genuine metered overage remains a future product feature.
6. **Finish payment operations.** The tenant-safe cases, financial hold,
   reactivation guard, duplicate/out-of-order handling and private read-only
   owner queue are implemented in the release candidate. This P0 remains open
   until payment-failure/dunning delivery, refund and chargeback procedures,
   Stripe receipt configuration, scheduled/effective cancellation and the
   complete provider-webhook journey have production-grade evidence. Follow
   `docs/runbooks/billing-operations.md`; held notices are not delivered.
7. **Add essential lifecycle email.** Welcome, onboarding, usage warning, trial
   expiry, payment failure, cancellation, export and deletion notices need a
   monitored transactional mail service.
8. **Make operations recoverable.** Add general uptime/worker/queue/database/
   disk/provider alerts with human delivery; maintain an off-host encrypted
   backup; replace the obsolete AWS restore instructions; complete and record a
   restore drill.
9. **Implement the approved data lifecycle.** K Heaton is the Privacy Officer;
   invoice, customer, message, call and audit records use a five-year
   post-cancellation policy target; and verified export/deletion requests have a
   14-day service target. Implement and test category-based retention, legal
   holds, customer notifications and backup ageing without promising deletion
   of records that must legally be retained.
10. **Prove the real customer journey.** Run a staging journey using actual
    Cognito invitation, MFA, legal acceptance, Xero OAuth, Stripe, one
    owner-approved Australian numeric number, outbound SMS and inbound reply.
    Existing browser tests seed sessions and provider data, so they do not
    prove this journey.

## P1 — complete before public self-service

- Enable and secure public account creation and fully automated workspace,
  subscription and Xero onboarding.
- Add general rate limits, request-size limits and webhook abuse controls.
- Provide customer-facing export/deletion request status, a public status page,
  support targets and an incident communications process.
- Test Safari/WebKit, Firefox, mobile layouts, accessibility and real provider
  callbacks.
- Publish maintained customer help, privacy/data-flow, troubleshooting and
  support documentation.
- Complete Sign Up with Xero and all certification checkpoints before App Store
  submission.

## P2 — after beta

- Enterprise/multi-organisation plans and organisation switching.
- Native iOS and Android applications.
- Pre-funded number pools, automatic purchasing and provisioning beyond the
  five-customer just-in-time beta process.
- Database row-level security as defence in depth.
- Advanced reporting and fully metered overage automation.

## Completed in the current safety release

- Dedicated-number storage requires a provider ID and explicit, audited owner
  verification before a number can become ready. It can support the approved
  just-in-time beta flow without maintaining spare inventory.
- The owner console records number ownership, assignment, verification and
  cooling evidence. Customer workspaces do not need provider credentials or
  number-ordering controls.
- A same-customer subscription reactivation can reclaim its still-bound number
  during cooling. Owner release and every return to the shared pool clear
  verification before the number can be reused for a different customer.
- Public Terms, Privacy and Acceptable Use pages no longer require login.
- Solo SMS authorization, Billing, Terms and support guidance now use the same
  hard-cap rule; legacy overage fields are retained only for database
  compatibility.
- Signed billing events create tenant-safe cases and held notice evidence;
  unresolved blocking cases prevent owner reactivation, and the private billing
  queue has no send, release or resolve controls.
- Verification passed on a fresh database: 180 test files / 1,202 tests, plus
  lint, type-check and production build.

## Official Xero references

- Pricing and tier eligibility: https://developer.xero.com/pricing
- Connection counting and recommended beta cohort: https://developer.xero.com/documentation/guides/oauth2/tenants/
- OAuth application types and Marketplace eligibility: https://developer.xero.com/documentation/guides/oauth2/overview
- Certification checkpoints: https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints/
- Current Xero FAQ, including Custom Connection dates and Sign Up with Xero: https://developer.xero.com/faq
- Commercial terms: https://developer.xero.com/xero-developer-platform-commercial-terms

## Official Australian SMS and provider references

- ACMA SMS Sender ID frequently asked questions: https://www.acma.gov.au/frequently-asked-questions
- ACMA Sender ID Register industry rules: https://www.acma.gov.au/industry-rules-sms-sender-id-register
- Sinch Engage Australian pricing: https://sinch.com/engage/pricing/?country=au
- Sinch dedicated-number guidance: https://support.app.sinch.com/hc/en-us/articles/10526389880207-Dedicated-numbers
- Sinch number ordering guidance: https://support.sinch.com/hc/en-us/articles/54556480387603-Buying-a-number-from-Sinch
