# DineFlow — Technical Design, Part 6: Commercial Licensing Framework (Draft)

| | |
|---|---|
| **Version** | 0.1 (Stage 2 draft for discussion) |
| **⚠ Not legal advice** | This is a business framework to structure your thinking and brief a lawyer. Items marked **⚖** must be reviewed and drafted by a qualified lawyer in your jurisdiction before you sign with any restaurant. Tax and consumer-law treatment of one-time software fees also needs an accountant. |

---

> **Provisional defaults now in force** (hosting term, support, retention, backup expiry and the points the technical design forces into the contract) are in **[Part 7 §7](07-stage2-conditions.md)**. Read that section together with this one.

## 1. The central tension to resolve first

You plan to sell **one time**, but the product is **hosted by you** and has running costs and security duties. "Perpetual" therefore needs a precise meaning. The realistic options:

| Model | What the restaurant gets | Implication for you |
|---|---|---|
| **A. Perpetual right to use, hosting included for a fixed term, then renewable hosting (recommended)** | A perpetual, non-exclusive right to use DineFlow **as a hosted service** while hosting is active. Hosting and support are included for N months (e.g., 24), afterwards a low annual hosting/support fee applies; if they decline, they receive their data export and the service ends. | Keeps your costs funded, keeps your code private, and is honest about what "perpetual" means. Matches assumption Q-14. |
| B. Perpetual licence including source code / self-hosting | Copy of the software; they host it. | Loses control of security patching and support burden; source-code delivery changes pricing (much higher) and needs escrow/IP terms. Not compatible with the single shared deployment. |
| C. Time-limited licence (hosting term only, no renewal right) | Use during the term. | Contradicts "one-time payment" marketing; simplest for you. |

The rest of this document assumes **Model A**. **⚖ The word "perpetual" in your sales materials must match the contract.**

## 2. Terms to define (with recommended positions)

| Topic | Recommended position | Notes |
|---|---|---|
| **Grant of rights** | Non-exclusive, non-transferable, non-sublicensable right for the named restaurant (single outlet) to use the hosted DineFlow service for its own business. | ⚖ Define "outlet"; multi-outlet requires a separate licence. |
| **Ownership of the code and platform** | You retain all IP in the software, designs, documentation and improvements, including improvements built for a customer, unless a paid customisation agreement states otherwise. | ⚖ IP assignment terms if you use contractors; ensure any contributors sign IP assignments. |
| **Customer branding** | Restaurant retains ownership of its name, logo, menu content and images, and grants you a licence to host and display them for the service. | ⚖ Restaurant warrants they have the rights to what they upload (images, names). |
| **Hosting duration** | Included for **24 months from go-live** (or your chosen 12/24). Renewal price stated up front (e.g., fixed annual fee with a cap on increases). | Cost model in Part 0 §5; renew price must exceed cost with margin. |
| **Support duration and scope** | Included for the same term: bug fixes, security patches, guidance by email/WhatsApp during stated hours, target response times (e.g., next business day) — **best-effort, no uptime guarantee** unless you choose to offer one (target 99.5 % is an internal goal, not a promise). | ⚖ Avoid guaranteed SLAs and service credits unless you can meet them; disclaim consequential losses. |
| **Software updates** | Minor updates and security patches included during the term. Major new versions/feature sets are optional paid upgrades. | Define "major" (e.g., new module or workflow, not fixes). |
| **Security patches** | You apply patches to the shared platform for all customers; customers cannot delay them. Emergency downtime for a critical patch may occur with best-effort notice. | |
| **Paid customisations** | Quoted separately (hourly or fixed), with written scope; delivered into the shared codebase behind a feature flag so it does not fork the product. | Beware per-customer forks: they multiply your maintenance. |
| **Data ownership** | Restaurant owns its business data (menu, orders, bills, staff records). You are a **processor/service provider**; you may use anonymised aggregate technical metrics only. | ⚖ Data-protection roles and required clauses (DPDP Act, GDPR if applicable): a Data Processing Agreement and privacy notice for the restaurant's customers. |
| **Sub-processors** | List them: database/auth (Supabase), API host (Render), CDN/DNS/bot protection (Cloudflare), email provider, error tracking, backup storage. Changes notified. | ⚖ Cross-border transfer disclosures (data stored outside India/your customer's country). |
| **Data export** | Restaurant may request/perform a full export (CSV/JSON + bill PDFs) at any time, free once per year; extra exports may be charged. | Built in FR-130. |
| **Financial record retention** | Restaurant is responsible for meeting its legal record-keeping duties; recommend they keep their own exports. You retain data for a defined period after termination (e.g., 60–90 days) then delete/anonymise, subject to law. | ⚖ Statutory retention periods (tax records) vary; the platform is not the restaurant's system of record for compliance. |
| **Tax and invoice compliance** | Restaurant configures tax rates and invoice content and is responsible for their correctness and legality; DineFlow provides tools, not tax advice; no compliance certification is claimed. | ⚖ Disclaimer wording; consider having an accountant review the default invoice layout for your first market. |
| **Termination and offboarding** | Either party may terminate for uncured material breach; restaurant may leave any time (no refund of the one-time fee except as agreed); on termination: service suspended, export provided within a set window (e.g., 30 days), data deleted/anonymised after the retention period, QR codes stop working (advise printed QR codes will become invalid). | ⚖ Refund policy; what happens to prepaid hosting. |
| **Suspension** | You may suspend for non-payment of renewals, illegal use, security risk or abuse; data preserved for the export window. | |
| **Third-party charges** | Included: hosting and email at normal volumes. Excluded and passed through if introduced: SMS/WhatsApp, payment-gateway fees, custom domains, unusually high storage/traffic beyond a fair-use limit. | Define fair use (e.g., orders/day, image storage per restaurant). |
| **Acceptable use** | No unlawful content, no attempts to access other tenants, no abusive automation; you may suspend for breaches. | |
| **Warranties and liability** | Software provided "as is" with a limited warranty to fix reproducible defects during support; liability capped at fees paid (or annual fees); no liability for lost profits, tax penalties, or outages beyond your control. | ⚖ Enforceability of caps varies by jurisdiction. |
| **Business continuity / key-person risk** | Optional: source-code escrow, or a documented hand-over/migration package (containers, schema, runbooks) available for a fee if you stop operating the service. | Consider offering as a selling point to nervous customers; ⚖ escrow agreements. |
| **Confidentiality, governing law, dispute resolution** | Standard mutual confidentiality; governing law and venue in your jurisdiction. | ⚖ |
| **Pilot terms** | Written pilot agreement: free/discounted use for N weeks, feedback rights, permission to use the restaurant's name as a reference (or not), clear conversion to a paid licence. | ⚖ |

## 3. Pricing inputs (for your decision, not a recommendation of a number)

- **Cost floor per restaurant:** ≈ $4.50/month at 10 restaurants (Part 0 §5) → ≈ $110 for 24 months, plus your support time and a risk buffer (currency, price rises).
- **Renewal fee:** must at least cover marginal hosting plus support; consider an annual fee with clear inclusion list.
- **Customisation:** hourly or per-feature quote.
- **Extras to price separately:** additional outlets, extra QR reprint services, training visits, migration/export assistance, WhatsApp/SMS notifications (pass-through), online payments integration (future).

## 4. Documents you will need (lawyer to draft or review ⚖)

1. Software licence and services agreement (order form + terms).
2. Data Processing Agreement (restaurant = controller, you = processor) and sub-processor list.
3. Privacy notice template restaurants can display to their customers (linked from the QR menu).
4. Acceptable-use and suspension policy.
5. Support and hosting policy (hours, response targets, maintenance windows, renewal terms).
6. Offboarding and data-retention schedule.
7. Pilot agreement.
8. Website terms/privacy policy for the landing page.

## 5. Decisions needed from you (feed into the licence)

Hosting term (12 or 24 months?), renewal fee model, support hours and response targets, whether to offer any uptime commitment, source-code escrow (yes/no), refund policy, data-retention period after termination, and whether customisations may be re-used for other customers.
