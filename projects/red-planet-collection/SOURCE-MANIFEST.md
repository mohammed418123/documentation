# Source Manifest — Red Planet Collection

Snapshot date: 2026-08-16

## GitHub location

- Repository: `mohammed418123/documentation`
- Branch: `red-planet-collection`
- Path: `projects/red-planet-collection/`
- Existing repository branch `18.0` was not modified by this migration.

## Production reference

- Vercel project: `red-planet-collection`
- Vercel project id: `prj_DHjN96yE52MJ0xybYbKPGKx7ySzb`
- Production URL: `https://red-planet-collection.vercel.app/`

## Supabase source

Project: `ekezixsgyihoivhaudbm`

Current functions inspected:

- `collection-portal-api-v2` — version 19 — ACTIVE — SHA256 `55944d1130ff879289cee3d86c76bbf6b85c642774d4a6511241de94450850fc`
- `collection-portal-api-v2-staging` — version 9 — ACTIVE — same SHA256 as production API at snapshot time
- `collection-portal-staging-site` — version 3 — ACTIVE — SHA256 `6176912ee6828f728fad54bc2a5c177de5a17cb0752c54174a1935e09424b2d6`
- `collection-portal-site` — version 1 — ACTIVE — SHA256 `2ba8e80b8fe9941966dbd7959a827e693ef1b023b5f6f449c76ec1b520fc25d0`

### API files copied exactly from the current function bundle

- `index.ts`
- `core.ts`
- `auth.ts`
- `admin.ts`
- `odoo.ts`
- `reports.ts`
- `payment-reference.ts`
- `daily-outflow.ts`
- `deposits.ts`
- `expenses.ts`
- `expense-state.ts`
- `salary-advances.ts`
- `salary-advance-state.ts`
- `salary-advance-config.ts`

### Pending exact source extraction

`receipts.ts` is part of the current `collection-portal-api-v2` Supabase function, but the connected Supabase tool exposes the function as one large bundle and does not expose a per-file download operation. The bundle response is too large to safely extract that file independently through the current connector. It has deliberately NOT been replaced by guessed or reconstructed code.

Because `index.ts` imports `./receipts.ts`, the GitHub backend snapshot should be considered incomplete until the exact `receipts.ts` file is recovered.

## Vercel frontend snapshot

The connected Vercel tooling exposes deployed files, not the original authored frontend repository. The following production deployment artifacts are archived under `vercel-deployment-snapshot/` as a deployment reference:

- `index.html`
- `assets/entry-ux.css`
- `assets/daily-session.css`

These are deployment artifacts and must not be confused with the original authored frontend source. The original frontend project source is not exposed by the current Vercel connector.

## Security

No Odoo API keys, Supabase service-role keys, session tokens, or `.env` files are committed here. Runtime secrets remain in environment/secret storage. `.gitignore` protects common local secret and build paths.

## Development rule

New changes should be developed on a non-production branch/environment and validated against Preview/Staging before any explicit production promotion.
