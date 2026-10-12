# 📊 Research Analyst — $65/ac Budget Reassessment

@[Soil Scientist] your soil framing holds — but the arithmetic just changed materially. Let me lay out what $65/ac does to the recommendation, then we rebuild the deliverables.

---

## What Changed With the Budget Cut

### Cost-per-lb-N math (fictional quotes only — NOT current market prices)

*\*Fictional quote from attached CSV — not a current market price.*

### Key Finding: **The budget gap is real and cannot be closed without either a higher cap or accepting below-MRTN rates.**

- At $65/ac with **urea**: you can afford **109 lb N/ac** — that's **31 lb N (22%) short** of the ~140 lb MRTN for corn-after-soybean in Iowa (Sawyer et al., PM 2015, 2006).
- At $65/ac with **UAN-32**: you can afford **99 lb N/ac** — that's **41 lb N (29%) short**.
- **Urea is the clear winner** on cost-efficiency: $0.598/lb N vs. UAN's $0.656/lb N — a **9% savings per unit N**.

---

## 💰 What I Would Prioritize or Defer

**Priority order:**

1. **🏆 Buy urea, not UAN** — cheapest source per lb N at these fictional quotes
2. **📅 Split application** — pre-plant + sidedress to reduce loss risk on silt loam and allow in-season adjustment if rains come (Soil Scientist's leaching concern is well-placed)
3. **⚡ Accept the gap knowingly** — 109 lb N/ac vs. 140 lb MRTN is a ~22% shortfall; at 180 bu/ac goal, each missing 1 lb N/ac risks roughly 0.5–1 bu/ac yield depending on conditions (ISU PM 1688), so **potential yield risk ≈ 15–30 bu/ac if mineralization is also below normal**

**What to defer/flag:**

- ⚠️ **Do not chase the gap with unquoted anhydrous** — I cannot price it, and the charter forbids inventing a quote
- ⚠️ **Do not reduce sidedress flexibility** — the pre-plant application must stay moderate (≤60 lb N/ac) so you retain the option to correct in-season
- 📋 **Ask your retailer for a current anhydrous quote** — if anhydrous lands below ~$570/ton, it could price-competitive with urea (break-even: $570 × 0.82 = $0.695/lb N... actually let me recalculate)

### Break-Even Price Needed for Anhydrous

To match urea's $0.598/lb N at 82% N concentration:

> **Break-even anhydrous price = $0.598 × 0.82 × 2000 = $980.7/ton**

Wait — that's the price *per ton* of anhydrous needed to equal urea's per-lb-N cost. Actually:

$$\text{Break-even} = \$0.598/\text{lb N} \times 0.82 \times 2000 = \$980.7/\text{ton}$$

**Any anhydrous quote below ~$981/ton would beat urea on cost per lb N.** Anhydrous is typically $700–$900/ton in normal markets — so **it would likely be the cheapest source** — but without a quote in the CSV, I cannot use it in the plan. @[File Creator] please flag this as an open question for the farmer.

**@User** What is your retail anhydrous ammonia quote per ton for spring 2027?

*Assuming no anhydrous quote is available, the plan proceeds with urea only.*

---

## 📋 Recommended Split Program (Urea Only, $65 Cap)

**120 acres × $64.87 = $7,785 total nitrogen spend**

---

## 📊 Updated Comparison Chart

**Insight:** Urea crosses the $65 line at **~109 lb N/ac**. UAN crosses at **~99 lb N/ac**. Neither reaches the 140 lb MRTN target within budget.

---

## 📅 Week-by-Week Plan (Anchored 2027-04-05)

All fieldwork dates are **planning windows** — trigger only when field and soil conditions allow. **No weather forecast is available**; each task is conditional.

---

## 📅 ICS Calendar Events

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Prairie Bend Farm//N Plan 2027//EN
BEGIN:VEVENT
UID:pbfn-w1-order-2027@prairiebend
DTSTART;VALUE=DATE:20270405
DTEND;VALUE=DATE:20270411
SUMMARY:Order Urea — 14.2 tons for 120 ac @ $65/ac cap
DESCRIPTION:Buy 236 lb urea/ac x 120 ac. Fictional quote $550/ton. Verify current pricing.
END:VEVENT
BEGIN:VEVENT
UID:pbfn-w2-preplant-2027@prairiebend
DTSTART;VALUE=DATE:20270412
DTEND;VALUE=DATE:20270418
SUMMARY:Pre-Plant Urea Application (60 lb N/ac) — CONDITIONAL
DESCRIPTION:Apply 130 lb urea/ac. TRIGGER: field trafficable, no standing water, soil not saturated. Planning window only — no forecast available.
END:VEVENT
BEGIN:VEVENT
UID:pbfn-w3-plant-2027@prairiebend
DTSTART;VALUE=DATE:20270419
DTEND;VALUE=DATE:20270425
SUMMARY:Planting Window — Corn After Soybeans (120 ac) — CONDITIONAL
DESCRIPTION:TRIGGER: soil temp >=50F at 2 in, field trafficable. Planning window — check conditions day-of.
END:VEVENT
BEGIN:VEVENT
UID:pbfn-w7-sidedress-2027@prairiebend
DTSTART;VALUE=DATE:20270517
DTEND;VALUE=DATE:20270523
SUMMARY:Sidedress Urea Application (49 lb N/ac) — CONDITIONAL
DESCRIPTION:Apply 106 lb urea/ac at V6-V8. TRIGGER: corn at V6-V8, soil not saturated, equipment trafficable. Planning window.
END:VEVENT
END:VCALENDAR
```

---

## 📄 Field SOP (Downloadable)

```markdown
# SOP: Nitrogen Management — Prairie Bend Farm
## $65/ac Budget Cap | Corn After Soybeans | 120 ac | Ames, Iowa

**Version:** 2027-04-05
**Budget:** $65/acre nitrogen spend (farmer-supplied, revised from $85)
**Source:** Urea only (fictional quote: $550/ton — NOT current market price)
**Rate:** 109 lb N/ac total (60 pre-plant + 49 sidedress)
**Product:** 236 lb urea/ac × 120 ac = 14.2 tons total
**Cost:** $64.87/ac × 120 = $7,785

## SEPARATION OF EVIDENCE
- **Farmer-supplied (CSV):** yield goal 180 bu/ac, budget $65/ac, pH 6.3, OM 3.4%, corn after soybean, silt loam, rain-fed, 120 ac, Ames IA
- **Sourced facts (ISU):** MRTN for corn-after-soybean ≈ 130–150 lb N/ac (Sawyer et al., PM 2015); pH 6.0–6.9 adequate (PM 1688); mineralization ~20–40 lb N/ac typical for 3.4% OM
- **Assumptions:** fictional quotes as-is; no anhydrous quote provided; no weather forecast available; split program justified by leaching risk on silt loam
- **Open question:** current anhydrous quote (break-even ≈ $981/ton to match urea)

## APPLICATION STEPS
1. **W1 (Apr 5–11):** Order urea. Confirm delivery before planting.
2. **W2 (Apr 12–18):** Pre-plant urea — 130 lb/ac. CONDITIONAL on field trafficable and no standing water.
3. **W3 (Apr 19–25):** Plant. CONDITIONAL on soil temp ≥50°F at 2".
4. **W7 (May 17–23):** Sidedress — 106 lb/ac at V6–V8. CONDITIONAL on crop stage and soil conditions.

## RISK NOTE
109 lb N/ac is 22% below MRTN (~140). Potential yield risk: 15–30 bu/ac if mineralization underperforms. Consider negotiating budget increase or securing anhydrous quote.

## SOURCES
- Sawyer, J.E., et al. "Making Sensible Nitrogen Rate Decisions." ISU PM 2015, 2006. https://www.extension.iastate.edu/agdm/wholefarm/pdf/c1-46.pdf
- ISU Corn Nitrogen Rate Calculator. https://cnrc.agron.iastate.edu/
- Sawyer, J.E. "Corn Nitrogen Rate Calculations." ISU PM 1688, rev. 2013. https://www.extension.iastate.edu/agdm/wholefarm/pdf/c1-60.pdf
- ISU PM 1688 also covers soil pH adequacy ranges.
```

---

## 🎯 Verdict, Dissent, Open Questions

**Verdict:** At $65/ac, **urea split 60+49 lb N/ac** is the only evidence-based program that fits budget with maximum cost-efficiency. It delivers 109 lb N/ac against a 140 lb MRTN target — a known 22% shortfall that must be accepted knowingly or the budget must move.

**Dissent:** @Crop Specialist may argue the shortfall is too aggressive for a 180 bu/ac goal on rain-fed silt loam — I'd welcome that pushback if it comes with a rate/timing alternative that fits $65.

**Open Questions:**
1. @User What is your current anhydrous ammonia quote per ton?
2. Will the $65 cap hold through sidedress, or is there flexibility if crop conditions demand more N?
3. @File Creator Can you package the SOP + ICS as downloadable files?

---

**Sources cited above:** ISU PM 2015 (Sawyer et al., 2006); ISU PM 1688 (Sawyer, rev. 2013); ISU Corn Nitrogen Rate Calculator (cnrc.agron.iastate.edu). Product quotes are fictional values from attached CSV — not current market prices. No weather forecast was available or invented.
