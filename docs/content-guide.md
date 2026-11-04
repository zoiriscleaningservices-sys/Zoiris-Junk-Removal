# Zoiris Content & Editorial Guide

This guide governs every page record in `src/data/pages/*.json`. It is used by human editors, by the
SEO Operations Dashboard, and by the automated quality gate (`src/lib/page-quality.ts`).

## 1. Non-negotiable honesty rules

The business is **Zoiris Junk Removal**, phone **251-930-8621** (`tel:+12519308621`), primary market
**Mobile, Alabama**. It is configured as a **service-area business with no public street address**.

Never write, imply, or invent:

- Prices, discounts, price guarantees, or "free estimates" (unless the owner confirms).
- Same-day, next-day, 24/7, emergency, or guaranteed response/arrival times. Say "we confirm a pickup window with you".
- Licensed / insured / bonded / certified / "eco-certified" / "zero landfill" / R2 / e-Stewards claims.
- Certified data destruction, secure wiping, hard-drive shredding, or chain-of-custody services.
- Donation partnerships or named recyclers, landfills, or charities.
- Reviews, ratings, testimonials, customer names, job counts, years in business, team size, truck count.
- Street names, specific job addresses, neighborhood "characteristics" you have not sourced.
- Service in any location other than the City of Mobile (other cities are unverified candidates).
- That Zoiris is a government program or recycling facility. Zoiris is a private **pickup** service.
- Hazardous waste handling, refrigerant recovery by our crew, appliance dismantling, demolition, dumpster rental.

Allowed, careful phrasing patterns:

- "Where practical options exist, usable and recyclable items are separated from items going to disposal."
- "Tell us about X when you call so we can confirm before scheduling."
- "We confirm an estimate and a pickup window with you before anything is scheduled."
- "Our crew does the lifting and carrying."
- Items whose acceptance is `accepted-after-confirmation` or `unknown` in `src/data/items.json` must be
  described as "call to confirm", never as a flat "yes".

Phone number: mention it at most once in body copy (the template already renders call buttons).

## 2. Voice

Plain, confident, helpful, local. Short sentences. Answer the visitor's main question in the first
paragraph (`lead`). No filler, no hype words ("best", "top-rated", "#1", "unbeatable"). Write for
customers, not search engines. Don't repeat the keyword unnaturally; vary phrasing.

Every page must be **substantively different** from every other page — different examples, different
preparation tips, different FAQs that are specific to that subject. Never reuse paragraphs across pages.

## 3. Inline formatting in strings

Text fields support two inline forms only: `[link text](/path/)` for internal links (paths must exist in
the manifest below and end with `/`) and `**bold**`. External links must use full `https://` URLs and
should be official sources (EPA, City of Mobile, ADEM, etc.).

## 4. Record schema (see `src/lib/types.ts`)

Use `svc-furniture-removal.json` as the reference example. Required for published templated pages:
`seo.title` (≤ 65 chars, unique), `seo.description` (110–160 chars, unique), `seo.h1`,
`seo.primaryKeyword` (unique across the site), `seo.secondaryKeywords`, `seo.intent`, `purpose`,
`content.lead`, at least 3 FAQs specific to the page, and at least 3 `related` page ids.

Article records (`type: "article"`) use `content.lead`, `content.sections[]`, `content.faqs`, and
`content.article = { lastReviewed, sources[] }`.

## 5. Page manifest (published = indexable once the gate passes)

| id | path | status |
|---|---|---|
| core-home | / | published |
| core-services | /services/ | published |
| core-areas | /areas/ | published |
| core-guides | /guides/ | published |
| core-about | /about/ | published |
| core-contact | /contact/ | published |
| core-request-pickup | /request-pickup/ | published |
| core-how-it-works | /how-it-works/ | published |
| core-pricing | /pricing/ | published |
| core-faq | /faq/ | published |
| core-accepted-items | /accepted-items/ | published |
| core-restricted-items | /restricted-items/ | published |
| core-responsible-disposal | /responsible-disposal/ | published |
| core-privacy-policy | /privacy-policy/ | published |
| core-terms | /terms/ | published |
| svc-junk-removal-mobile-al | /junk-removal-mobile-al/ | published |
| svc-residential-junk-removal | /services/residential-junk-removal/ | published |
| svc-commercial-junk-removal | /services/commercial-junk-removal/ | published |
| svc-furniture-removal | /services/furniture-removal/ | published |
| svc-mattress-removal | /services/mattress-removal/ | published |
| svc-appliance-removal | /services/appliance-removal/ | published |
| svc-bulk-item-pickup | /services/bulk-item-pickup/ | published |
| svc-garage-cleanouts | /services/garage-cleanouts/ | published |
| svc-estate-cleanouts | /services/estate-cleanouts/ | published |
| svc-house-cleanouts | /services/house-cleanouts/ | published |
| svc-apartment-cleanouts | /services/apartment-cleanouts/ | published |
| svc-storage-unit-cleanouts | /services/storage-unit-cleanouts/ | published |
| svc-office-cleanouts | /services/office-cleanouts/ | published |
| svc-property-cleanouts | /services/property-cleanouts/ | published |
| svc-moving-cleanouts | /services/moving-cleanouts/ | published |
| svc-construction-debris-removal | /services/construction-debris-removal/ | published |
| svc-retail-store-cleanouts | /services/retail-store-cleanouts/ | draft |
| svc-warehouse-cleanouts | /services/warehouse-cleanouts/ | draft |
| svc-yard-debris-removal | /services/yard-debris-removal/ | research |
| svc-shed-removal | /services/shed-removal/ | idea |
| svc-hot-tub-removal | /services/hot-tub-removal/ | idea |
| ew-electronics-pickup | /e-waste/ | published |
| ew-computer-recycling | /e-waste/computer-recycling/ | published |
| ew-tv-monitor-pickup | /e-waste/tv-monitor-pickup/ | published |
| ew-printer-copier-removal | /e-waste/printer-copier-removal/ | published |
| ew-phone-tablet-pickup | /e-waste/phone-tablet-pickup/ | published |
| ew-office-electronics-pickup | /e-waste/office-electronics-pickup/ | published |
| item-refrigerator-removal | /items/refrigerator-removal/ | published |
| item-washer-dryer-removal | /items/washer-dryer-removal/ | published |
| loc-mobile-al | /areas/mobile-al/ | published |
| guide-prepare-computer-for-recycling | /guides/prepare-computer-for-recycling/ | published |
| guide-get-rid-of-old-tv-mobile | /guides/get-rid-of-old-tv-mobile-al/ | published |
| guide-electronics-drop-off-mobile | /guides/electronics-drop-off-mobile-al/ | published |
| guide-old-batteries-safety | /guides/old-batteries-safety/ | published |
| guide-junk-removal-vs-dumpster | /guides/junk-removal-vs-dumpster-rental/ | published |
| guide-garage-cleanout-prep | /guides/garage-cleanout-checklist/ | published |
| guide-estate-cleanout-what-happens | /guides/what-happens-during-estate-cleanout/ | published |
| guide-old-furniture-mobile | /guides/get-rid-of-old-furniture-mobile-al/ | published |
| guide-appliance-pickup-prep | /guides/prepare-for-appliance-pickup/ | published |
| guide-what-can-junk-removal-include | /guides/what-can-junk-removal-include/ | draft |
| guide-what-happens-to-old-electronics | /guides/what-happens-to-old-electronics/ | draft |

Candidate city, neighborhood, and service + location combination records exist in `research` /
`idea` status and are **not** linked from published content.

## 6. Keyword ownership (one primary keyword per page)

| page | primary keyword |
|---|---|
| svc-junk-removal-mobile-al | junk removal Mobile AL |
| svc-residential-junk-removal | residential junk removal Mobile |
| svc-commercial-junk-removal | commercial junk removal Mobile |
| svc-furniture-removal | furniture removal Mobile AL |
| svc-mattress-removal | mattress removal Mobile AL |
| svc-appliance-removal | appliance removal Mobile AL |
| svc-bulk-item-pickup | bulk item pickup Mobile AL |
| svc-garage-cleanouts | garage cleanout Mobile AL |
| svc-estate-cleanouts | estate cleanout Mobile AL |
| svc-house-cleanouts | house cleanout Mobile AL |
| svc-apartment-cleanouts | apartment cleanout Mobile AL |
| svc-storage-unit-cleanouts | storage unit cleanout Mobile AL |
| svc-office-cleanouts | office cleanout Mobile AL |
| svc-property-cleanouts | property cleanout Mobile AL |
| svc-moving-cleanouts | moving junk removal Mobile AL |
| svc-construction-debris-removal | construction debris removal Mobile AL |
| ew-electronics-pickup | electronics pickup Mobile AL |
| ew-computer-recycling | computer recycling Mobile AL |
| ew-tv-monitor-pickup | TV removal Mobile AL |
| ew-printer-copier-removal | printer and copier removal Mobile |
| ew-phone-tablet-pickup | cell phone recycling Mobile AL |
| ew-office-electronics-pickup | commercial e-waste pickup Mobile |
| item-refrigerator-removal | refrigerator removal Mobile AL |
| item-washer-dryer-removal | washer and dryer removal Mobile AL |
| loc-mobile-al | junk removal service area Mobile Alabama |
| guides | question-style informational keywords (see each record) |
