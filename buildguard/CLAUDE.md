# CLAUDE.md — MedBill Analyzer

> Source of truth for how MedBill Analyzer is built, run, and deployed. Keep this current
> as the code changes. Last updated: Phase 0 recon (2026-06-30).

## What it is

MedBill Analyzer is an **anonymous** medical/dental bill analyzer. A user uploads a bill
image or PDF; the app OCRs it, extracts CPT/HCPCS billing codes and dollar amounts,
compares each code to CMS Medicare reference rates, flags overcharges, and can
generate a formal dispute letter.

- **No login / no accounts** (locked decision). The app is fully anonymous.
- **Privacy-first:** uploads are meant to be processed **in memory only**. No bill
  image, OCR text, or PHI should be persisted to disk or DB. `fee_schedule` and
  `clfs_fee_schedule` are read-only reference data only.
- Code is structured so accounts + saved history *could* be added later (a
  request/session-id concept and a schema that could attach `user_id`) without a
  rewrite — but none of that exists yet.

## Repository layout

The application lives in the **`buildguard/`** subfolder of the repo (repo is
`github.com/Kyuruki/BuildGuard`).

```
buildguard/
  index.html            Vite entry HTML (SPA mount point)
  vite.config.js        Vite config (React plugin)
  eslint.config.js      ESLint flat config
  package.json          Frontend + proxy deps (react 19, formidable)
  src/
    main.jsx            React root + BrowserRouter + self-hosted font imports
    App.jsx             Layout (Header/Footer/skip link) + Routes; route-change focus/title/announce
    index.css           Tailwind v4 @theme tokens (clinical blue palette), base, focus, reduced-motion
    content.js          Copy/data source of truth (nav, FAQ, steps, disclaimer, route titles)
    components/         ui.jsx (Container/Button/Eyebrow/Callout), Header, Footer, BrandMark,
                        LedgerDemo (hero signature), analyzer/{UploadPanel,ResultsTable,LetterPanel}
    pages/              Home, HowItWorks, Faq, Privacy, About, Analyzer, NotFound (lazy-loaded)
    assets/             hero.png
  api/                  Vercel Serverless Functions (the "proxy")
    analyze.js          POST: buffers upload in memory, forwards to Modal /analyze
    generate-letter.js  POST: validates + whitelists JSON, forwards to Modal /generate_letter
  lib/
    proxy.js            Shared proxy helpers (Origin allowlist, shared-secret header, Modal URLs)
    ratelimit.js        Best-effort in-memory per-IP rate limiter (429 + Retry-After)
  vercel.json           Security headers (CSP/HSTS/etc.) + function maxDuration config
  backend.py            Modal app "billguard": analyze, generate_letter, health
  load_fees.py          ONE-TIME loader for fee_schedule (already ran — DO NOT re-run)
  load_clfs.py          ONE-TIME loader for clfs_fee_schedule (already ran — DO NOT re-run)
  public/               Static, served at root: favicon.svg + favicon-32/apple-touch/
                        icon-192/icon-512 PNGs, site.webmanifest, og.png (1200×630),
                        robots.txt, sitemap.xml, llms.txt
```

## Architecture / data flow

```
Browser (React SPA on Vercel)
    │  multipart POST /api/analyze  (field name: "file")
    ▼
Vercel Serverless Function  buildguard/api/analyze.js
    │  forwards the raw file bytes as the request body (application/octet-stream)
    ▼
Modal FastAPI endpoint  https://kyuruki--billguard-analyze.modal.run
    │  Stage 1 (OCR + regex) -> Stage 2 (DB fee lookup)
    ▼
Neon PostgreSQL  (fee_schedule, clfs_fee_schedule)
```

Letter flow is analogous: `Upload.jsx` → `POST /api/generate-letter` (JSON) →
`buildguard/api/generate-letter.js` → Modal `generate_letter` → Anthropic Claude.

**The Vercel `/api` proxy exists to keep the Modal URL off the client.** All Modal
calls must go through it. Modal endpoints are still public `*.modal.run` URLs, but
every POST endpoint now requires the `X-Proxy-Secret` shared-secret header (see
"Endpoints" below and SECURITY_FINDINGS.md H2, fixed in Phase 1).

## The two-stage pipeline (KEEP this design)

**Stage 1 — extraction, no AI** (`extract_line_items`, `backend.py`)
- Tesseract OCR via `pytesseract` (PDFs rasterized in-memory with **PyMuPDF** — no
  poppler subprocess or temp files).
- Regex: codes `\b(\d{5})\b`; money `\$?\s?(\d{1,3}(?:,\d{3})*\.\d{2})`.
- A line becomes a line item only if it has **both** a 5-digit code **and** a dollar
  amount on the same line (rejects zip/phone/account numbers).
- First money on the line = `charged`, second = `allowed_on_bill`, third = `balance_on_bill`.
- Caps: **20 MB** upload, **30** PDF pages.

**Stage 2 — enrichment, no AI** (`enrich_with_fee_schedule`, `backend.py`)
- Batch query `fee_schedule` with `WHERE hcpcs_code = ANY(%s)` (avoids N+1).
- Codes not found fall back to a batch query of `clfs_fee_schedule`.
- Per item computes `medicare_rate`, `overcharge_amount`, `overcharge_multiple`,
  `found_in_fee_schedule`, `rate_source` (`physician_fee_schedule` |
  `clinical_lab_fee_schedule` | `null`).
- Codes in neither table are returned `found_in_fee_schedule: false` (Unverified) —
  the app never asserts an overcharge for a code it cannot confirm.

**Letter generation** (`generate_letter`, `backend.py`)
- Separate endpoint. Uses Anthropic **`claude-haiku-4-5-20251001`**.
- Only argues items with `found_in_fee_schedule && overcharge_amount > 0`.
- Prompt is tuned: first person (the patient, not a representative); no
  "fraud"/"illegal" wording; no "authorized representative" framing; requests a
  written response within 30 days.
- Returns `{status:"ok", letter:null, message:...}` when there are no verified
  overcharges (no model call).

## Endpoints

All Modal POST endpoints require the shared-secret header **`X-Proxy-Secret`**
(value = `PROXY_SHARED_SECRET`) — the proxy sends it; direct callers with a wrong or
missing secret are rejected 403. This check **fails closed**: if `PROXY_SHARED_SECRET`
is not configured, the endpoint returns 503 rather than accepting everyone. Local dev
without the secret must opt in explicitly via `DANGEROUSLY_ALLOW_UNAUTHENTICATED_PROXY=1`
(logs a `critical` line every time it's used).

Modal (workspace `kyuruki`, app `billguard`):
- `POST https://kyuruki--billguard-analyze.modal.run` — **raw file bytes as the request
  body** (read with `request.body()`, sniffed by magic bytes);
  returns `{status, request_id, line_items[], line_items_found}`. **No raw OCR `text`
  or `raw_line` is returned** (PHI minimization). Secrets: `neon-db`, `proxy-auth`.
- `POST https://kyuruki--billguard-generate-letter.modal.run` — JSON body
  (`GenerateLetterRequest`); returns `{status, request_id, letter}` or
  `{status, letter:null, message}`. **Re-verifies overcharges against the CMS tables
  server-side** (ignores client-supplied rates). Secrets: `anthropic-secret`,
  `neon-db`, `proxy-auth`.
- `GET  https://kyuruki--billguard-health.modal.run` — `{status:"ok", message:...}`
  (public, no secret).

Vercel proxy (relative paths the SPA calls):
- `POST /api/analyze` — multipart field **`file`** (formidable) → forwarded to Modal as
  raw bytes (application/octet-stream), not multipart.
- `POST /api/generate-letter` — JSON passthrough.

`line_items` object shape (analyze output / letter input):
`code, charged, allowed_on_bill, balance_on_bill, raw_line, found_in_fee_schedule,
rate_source, medicare_rate, overcharge_amount, overcharge_multiple`.

## Environment variables / secrets

**Modal secrets** (provisioned in the `kyuruki` workspace; referenced in `backend.py`):
- `neon-db` → `DATABASE_URL` (Neon Postgres). Used by `analyze` **and** `generate_letter`.
- `anthropic-secret` → `ANTHROPIC_API_KEY`. Used by `generate_letter`.
- `proxy-auth` → `PROXY_SHARED_SECRET`. **NEW in Phase 1 — must be created before the
  next `modal deploy` or the deploy fails** (it is referenced in the decorators):
  ```
  modal secret create proxy-auth PROXY_SHARED_SECRET=<same-random-value-as-vercel>
  ```

**Vercel env vars** (Project → Settings → Environment Variables):
- `PROXY_SHARED_SECRET` → same value as the Modal `proxy-auth` secret (the proxy sends
  it to Modal as `X-Proxy-Secret`). If unset, Modal fails open with a warning.
- `ALLOWED_ORIGINS` *(optional)* → comma-separated Origin allowlist override. Defaults
  (in `lib/proxy.js`) already include `billguard.kyuruki.cc` + the `.vercel.app` aliases,
  plus any `*.kyuruki.cc` and this project's `buildguard-*.vercel.app` preview URLs.
- `MODAL_ANALYZE_URL`, `MODAL_LETTER_URL` *(optional)* → override the Modal endpoint URLs.

**Loaders** read `DATABASE_URL` from a local `.env` via `python-dotenv`. `.env` is gitignored.

**Frontend:** no secrets in the client bundle. Only `VITE_`-prefixed vars reach the
browser; there are none. `PROXY_SHARED_SECRET` lives only in the serverless proxy.

## Security model (Phase 1)

- **Trust boundary:** the `/api` proxy is the only intended caller of Modal. It attaches
  `X-Proxy-Secret`; Modal verifies it (constant-time) and 403s otherwise. The proxy also
  rejects browser cross-origin requests via an Origin allowlist (`lib/proxy.js`).
- **Rate limiting (Phase 2):** per-IP limits at the proxy (`lib/ratelimit.js`) — analyze
  **10/min + 50/day**, generate-letter **5/hour** — returning **429 + `Retry-After`** with
  a UI-friendly message. Best-effort/in-memory (per serverless instance): counters aren't
  shared across instances and reset on cold starts, so a client spread over N warm
  instances can get up to N× the limit. Modal adds a coarser per-container cap
  (`coarse_rate_limit`, keyed on the proxy-forwarded `X-Client-IP`) as defense-in-depth.
  Upgrade path: swap `lib/ratelimit.js` for Upstash/Redis for durable cross-instance limits.
- **Upload safety:** validated by **magic bytes** (PNG/JPEG/PDF), 20 MB cap, and
  decompression-bomb guards — PDF page count is checked (`pdfinfo`) *before* rasterizing;
  images are rejected by pixel/dimension caps before decoding (`Image.MAX_IMAGE_PIXELS`).
- **In-memory only:** the proxy buffers the upload in memory (no temp file); the backend
  reads the raw body in memory and rasterizes PDFs in-memory with PyMuPDF (no disk at
  all). `analyze` no longer echoes OCR text to the client.
- **Prompt-injection defense:** letter instructions live in the Claude `system` prompt;
  untrusted values go inside a `<bill_data>` fence, sanitized (control chars + `<>`
  stripped, length-capped); the model is told to treat the fence as data only.
- **Integrity:** `generate_letter` re-derives rates/overcharges from the CMS tables — it
  never trusts client-supplied `medicare_rate`/`overcharge_amount`.
- **Errors:** endpoints return structured JSON (`{detail: ...}` / `{error: ...}`) with
  clean 4xx/5xx; no stack traces, paths, or secrets leak; proxies propagate Modal's status.
- **Headers (`vercel.json`):** CSP, HSTS (preload), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy`.
- **Dependencies:** Python deps pinned in the Modal image; all checked against OSV with no
  known advisories (as of 2026-06-30).

## Database (Neon Postgres) — ALREADY POPULATED, DO NOT WIPE OR RELOAD

| Table                | Columns                                              | Rows  | Source |
|----------------------|------------------------------------------------------|-------|--------|
| `fee_schedule`       | `hcpcs_code`, `non_facility_rate`, `facility_rate`   | 7,835 | CMS Physician Fee Schedule (PFALL26AR.txt) |
| `clfs_fee_schedule`  | `hcpcs_code` (PK), `payment_rate`                     | 2,055 | CMS Clinical Lab Fee Schedule (PUF_CLFS_CY2026_Q2V1.csv) |

- `analyze` reads `fee_schedule.non_facility_rate` and `clfs_fee_schedule.payment_rate`.
- **Never** `DROP`/`TRUNCATE`/`DELETE` these or re-run the loaders. Additive
  migrations only (`CREATE TABLE`/`ADD COLUMN`/`CREATE INDEX`), and stop-and-ask
  before anything destructive.

## Run locally

Frontend (from `buildguard/`):
```
npm install
npm run dev        # Vite dev server
npm run build      # production build -> dist/
npm run lint
npm test           # vitest unit tests (lib/ + api/ handlers, in tests/)
```

Backend unit tests (pure logic in `backend.py`; no DB/Tesseract needed; `modal` is
stubbed in `tests/conftest.py`):
```
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/test_backend.py
```
> Local `/api/*` calls only resolve when running through the Vercel dev runtime
> (`vercel dev`) or once deployed — plain `vite dev` does not execute the
> serverless functions.

Backend (Modal):
```
modal serve backend.py     # hot-reload dev endpoints
modal run   backend.py     # one-off run
modal deploy backend.py    # publish the *.modal.run endpoints
```

Loaders — **already ran; do not re-run** (they `TRUNCATE`). Kept for provenance only.

## Deploy

- **Modal:** `modal deploy backend.py` (workspace `kyuruki`, app `billguard`).
  Secrets `neon-db`, `anthropic-secret`, **and `proxy-auth`** must exist first
  (see "Environment variables / secrets" — `proxy-auth` is new in Phase 1).
- **Vercel:** project `buildguard` (root dir `buildguard/`). Auto-detects Vite (build
  `npm run build`, output `dist/`) and deploys `api/*.js` as Serverless Functions;
  `vercel.json` applies security headers + function limits. Set `PROXY_SHARED_SECRET`
  (and optionally `ALLOWED_ORIGINS`) in the project's env vars.

## Known gotchas

- **Windows Modal CLI path:** `modal` (v1.4.2) is installed into **Python 3.14
  (64-bit)** under the Python install-manager layout, which is NOT on PATH — hence
  the full path is required on the Windows dev box. Working invocations:
  ```
  C:\Users\karol\AppData\Local\Python\pythoncore-3.14-64\Scripts\modal.exe deploy backend.py
  ```
  or (module form, equally stable):
  ```
  C:\Users\karol\AppData\Local\Python\pythoncore-3.14-64\python.exe -m modal deploy backend.py
  ```
  (`%LOCALAPPDATA%` == `C:\Users\karol\AppData\Local`.) Swap `deploy` for `serve`/`run`
  as needed.
- **Deploying from WSL (charmap crash):** invoking the Windows `modal.exe` from a WSL
  shell works (`/mnt/c/Users/karol/AppData/Local/Python/pythoncore-3.14-64/Scripts/modal.exe`),
  but Python 3.14 defaults to **cp1252** for piped stdout and modal's ✓/box output then
  crashes with `'charmap' codec can't encode ...`. Force UTF-8 **and** forward it through
  WSL's interop with `WSLENV`:
  ```bash
  cd buildguard
  MODAL=/mnt/c/Users/karol/AppData/Local/Python/pythoncore-3.14-64/Scripts/modal.exe
  WSLENV=PYTHONIOENCODING/w:PYTHONUTF8/w PYTHONIOENCODING=utf-8 PYTHONUTF8=1 "$MODAL" deploy backend.py
  ```
  (Plain `PYTHONUTF8=1 modal.exe …` does **not** work — WSL doesn't forward env vars to
  Windows processes without the `WSLENV=…/w` flag.) Also: from WSL the git remote is SSH
  with no key, so push via HTTPS using gh's creds (`gh auth setup-git`).
- **Upload contract:** browser → proxy is multipart field **`file`** (formidable); proxy
  → Modal is the **raw file bytes** in the request body (Modal reads `request.body()`,
  no multipart). Changing either side breaks upload. (Historically the proxy re-wrapped
  as multipart `bill` — see commits "fixed form field name"; Phase 1 switched to raw
  bytes to avoid Starlette's UploadFile disk-spool.)
- **`proxy-auth` Modal secret must exist before deploy** (Phase 1) — the decorators
  reference it, so `modal deploy` fails if it's missing. Create it once (see secrets).
- **`analyze.js` sets `bodyParser: false`** so formidable can read the raw stream and
  buffer it in memory. `generate-letter.js` relies on Vercel's default JSON body parse.
- **Frontend stack (Phase 3):** React Router v7 (client routing; **Home is eager**, the
  rest are lazy route chunks — lazy-loading Home caused a footer CLS of 0.27), Tailwind v4
  via `@tailwindcss/vite` (tokens in `src/index.css` `@theme`, no `tailwind.config.js`).
  SPA deep links work via the `rewrites` rule in `vercel.json` (excludes `/api/`).
- **Fonts (Phase 5):** IBM Plex Sans/Mono are self-hosted in `public/fonts/` with
  `@font-face` in `src/fonts.css`; the above-the-fold weights (Sans 400/600, Mono 500) are
  `<link rel=preload>`'d in `index.html`. This + eager Home gets CLS to ~0. (Earlier the
  fonts came from `@fontsource` CSS imports — those packages are still installed but no
  longer imported.)
- **Tailwind v4 gotcha:** `transition-colors` includes `outline-color`, which made the
  upload dropzone's keyboard focus ring *fade in* (read as mid-transition). The ring is
  an unlayered rule in `index.css` (`input[type=file]:focus-visible + label`), and the
  label scopes its transition to `color,background-color,border-color` so the ring is
  instant. Keep both if touching UploadPanel.

  *(Resolved in Phase 1: PDF page cap now checked before rasterization; upload no
  longer written to disk — buffered in memory. Phase 3: clinical blue theme shipped.)*

## SEO / AI-crawler (Phase 4)

- **Per-route metadata** is React 19 native: `src/components/Seo.jsx` renders
  `<title>`, `<meta name=description>`, `<link rel=canonical>`, and OG/Twitter tags from
  `PAGE_META` (in `content.js`), driven by the current route. One `<Seo/>` lives in the
  layout. index.html deliberately carries NO description/OG (only a fallback `<title>`)
  so React owns them without duplicate tags.
- **JSON-LD:** Organization + WebApplication are static in `index.html` (crawler-safe,
  no JS needed); FAQPage is rendered on `/faq` from the FAQ data.
- **Static files** in `public/`: `robots.txt` (+ sitemap ref), `sitemap.xml` (update
  `lastmod` on content changes), `llms.txt`, `og.png`, icons, `site.webmanifest`.
- **Regenerating icons/OG:** they were rendered from inline SVG/HTML via headless
  Chromium (see session scratchpad `pwtest/assets.mjs` + `og.mjs`) — re-render if the
  mark or tagline changes. The canonical domain is `https://billguard.kyuruki.cc`.

## Working docs

- `PLAN.md` — the phased checklist for the current hardening/rebuild effort.
- `SECURITY_FINDINGS.md` — audited vulnerabilities/bad practices (pre-fix baseline).
- `SECURITY.md` — (Phase 5) the security model, endpoint contract, rate limits,
  data-handling policy.
