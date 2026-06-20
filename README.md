# BillGuard

Upload a medical bill and instantly check whether your charges are above CMS Medicare reference rates. If they are, generate a formal dispute letter in one click.

## What it does

1. **Upload** a medical bill as an image or PDF
2. **OCR** extracts the raw text (Tesseract)
3. **Regex** pulls out CPT/HCPCS billing codes and dollar amounts
4. **Fee schedule lookup** checks each code against the CMS Physician Fee Schedule and CMS Clinical Laboratory Fee Schedule
5. **Results** show every line item — what you were charged, the Medicare reference rate, and the dollar overcharge
6. **Dispute letter** — if overcharges are found, Claude drafts a professional billing dispute letter you can copy or download

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite, deployed on Vercel |
| API layer | Vercel serverless functions |
| Backend | Python FastAPI on Modal |
| OCR | Tesseract (`pytesseract` + `pdf2image`) |
| Fee schedule DB | PostgreSQL (Neon) — CMS PFS + CLFS data |
| Letter generation | Claude Haiku (Anthropic) |

## How it works

The frontend sends the bill to a Vercel serverless function, which forwards it to the Modal backend. Modal runs OCR, extracts line items with regex, queries the fee schedule database, and returns enriched results. If the user requests a dispute letter, a second endpoint calls Claude with the overcharged line items and returns a ready-to-send letter.

Codes not found in either fee schedule are flagged as **Unverified** — the app never asserts an overcharge for a code it can't confirm.

## Limitations

- OCR quality depends on how clearly the bill was scanned/photographed
- Medicare rates are a reference benchmark, not a legal entitlement — actual negotiated rates vary by insurer
- Only CPT/HCPCS codes in the CMS fee schedules are covered; facility fees and other charges may not be recognized
