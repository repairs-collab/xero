# AccountPulse commercial release readiness

- Assessment date: 11 November 2026
- Market: Australia and New Zealand
- Current Xero tier: Starter, maximum five connected Xero organisations

## Decision

AccountPulse can proceed to a **free, invitation-only beta of up to five Xero
organisations** after the verified Sinch number-pool change is merged and
deployed. It is **not ready to charge beta customers or open public
self-service signup** yet.

The live `ap.motts.com.au` TLS and readiness endpoint were verified after the
older deployment notes were written, so TLS is not treated as a current launch
blocker.

## Release stages

| Stage | Current position | Required next work |
| --- | --- | --- |
| Free invite beta (maximum five Xero organisations) | Achievable after the current safety release | Use owner-assisted onboarding; manually verify each Sinch number; run one real invite/MFA/legal/Xero/send/reply journey; document beta support and incident contacts. |
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

1. **Correct Stripe access rules.** A subscription marked for cancellation can
   currently override trialing, past-due, unpaid or incomplete provider states
   and receive active sending entitlements. Provider payment state must win.
2. **Prevent repeat trials.** The local trial and Stripe Checkout can create two
   consecutive trials, and a cancelled customer can start another. Record trial
   consumption and convert the existing trial rather than resetting it.
3. **Finish the legal/commercial identity.** Confirm legal entity, ABN, GST
   registration, business address, tax treatment, refund policy, subprocessors,
   security contact and incident-notification terms with Australian legal and
   accounting review.
4. **Complete compliant SMS supply.** Finish the EMSP arrangement and prove
   number ownership, sender compliance, outbound delivery and inbound reply
   routing. Until automated provider provisioning exists, only owner-verified
   numbers may enter the allocation pool.
5. **Resolve SMS overage claims.** Either remove overage pricing from the launch
   UI/terms and enforce a hard allowance, or implement metered billing, caps,
   invoices and reconciliation end to end.
6. **Build payment operations.** Verify payment-failure/dunning emails, refunds,
   disputes, chargebacks, receipts, cancellation and provider webhook handling.
7. **Add essential lifecycle email.** Welcome, onboarding, usage warning, trial
   expiry, payment failure, cancellation, export and deletion notices need a
   monitored transactional mail service.
8. **Make operations recoverable.** Add general uptime/worker/queue/database/
   disk/provider alerts with human delivery; maintain an off-host encrypted
   backup; replace the obsolete AWS restore instructions; complete and record a
   restore drill.
9. **Approve data lifecycle procedures.** Define retention periods and provide a
   verified export/deletion request and fulfilment process, including legal hold
   and customer notification.
10. **Prove the real customer journey.** Run a staging journey using actual
    Cognito invitation, MFA, legal acceptance, Xero OAuth, Stripe, Sinch outbound
    SMS and inbound reply. Existing browser tests seed sessions and provider
    data, so they do not prove this journey.

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
- Automated compliant number purchasing and provisioning.
- Database row-level security as defence in depth.
- Advanced reporting and fully metered overage automation.

## Completed in the current safety release

- Automatic SMS allocation now requires a Sinch provider ID and an explicit,
  audited owner verification timestamp.
- The owner console provides a confirmation checklist for verifying an
  unassigned pool number.
- Assigned numbers verified manually record the same provider evidence.
- A same-customer subscription reactivation can reclaim its still-bound number
  during cooling. Owner release and every return to the shared pool clear
  verification before the number can be reused for a different customer.
- Public Terms, Privacy and Acceptable Use pages no longer require login.
- Verification passed on a fresh database: 171 test files / 1,120 tests, plus
  lint, type-check and production build.

## Official Xero references

- Pricing and tier eligibility: https://developer.xero.com/pricing
- Connection counting and recommended beta cohort: https://developer.xero.com/documentation/guides/oauth2/tenants/
- OAuth application types and Marketplace eligibility: https://developer.xero.com/documentation/guides/oauth2/overview
- Certification checkpoints: https://developer.xero.com/documentation/xero-app-store/app-partner-guides/certification-checkpoints/
- Current Xero FAQ, including Custom Connection dates and Sign Up with Xero: https://developer.xero.com/faq
- Commercial terms: https://developer.xero.com/xero-developer-platform-commercial-terms
