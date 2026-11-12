# MSRP Sheet Studio — Bennington

Turn a Bennington **Customer Quote PDF** (exported from the boat builder) into a finished, print-ready **11 × 17 in MSRP window sheet**.

Drag the quote onto the page → review the build and reconciled pricing → download the PDF.

## What it does

| Sheet section | Source in the quote |
|---|---|
| **Title** | Boat name from the quote header (e.g. `2027 22SSB`) |
| **Images** | Side-profile rendering pulled from page 1 (the "NOTE" text is removed automatically). Overhead layout = placeholder, or upload your own image. |
| **Pricing Details** | Base Boat · Engine & Performance Package · Styling & Options → **Total MSRP** |
| **Specifications & Capacity** | Boat Information + Performance Package Specs |
| **Styling** | Exterior main color, exterior accent color, trim package, base vinyl, furniture accent, anodizing (whatever is present) |
| **Performance** | Engine manufacturer + model code, pre-rig, single/twin engine rigging, performance package and its features |
| **Options** | Every other priced selection, plus the audio stage (even at $0) |
| **Standard Features** | Copied from the quote |

### Pricing is verified to the penny
All arithmetic is done in integer cents. Every line item lands in exactly one pricing section, and the app checks that

* the three sections add up to the sum of every line item, and
* that sum equals the quote's **Total Boat MSRP**.

The review screen shows a green **Reconciled** badge (or exactly what doesn't match). Lines can be moved between sections with **Edit sections**; the total never changes.

### Always one page
The layout measures itself and shrinks type until both columns fit on a single 11 × 17 page, so long option lists still work.

## Privacy
Everything runs in the browser. The quote PDF is never uploaded anywhere.



## Project layout
```
index.html          App shell
css/styles.css      UI styles
js/parser.js        Reads the quote PDF (pdf.js): header, summary, specs, line items, standards, profile image
js/categorize.js    Sorts line items into sections and reconciles pricing
js/sheet.js         Draws the 11×17 PDF (jsPDF) with auto-fit
js/app.js           Upload / review / preview / download flow
assets/             Logo and Montserrat fonts (SIL Open Font License)
```

Libraries (loaded from cdnjs): pdf.js 3.11.174, jsPDF 2.5.1.
