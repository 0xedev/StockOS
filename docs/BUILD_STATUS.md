# StockOS build status

## Live
- Supabase project: `stockos`
- Supabase ref: `ogvutthiduyajmzrwbsa`
- Region: `eu-central-1`
- Supabase is backend-only persistence; CDP is authoritative end-user auth
- RLS is explicit deny-all for browser roles on private financial tables
- B20/corporate-action reference tables remain public read-only
- Supabase security advisor: zero findings

## Implemented
- CDP React provider configured to create Smart Accounts on login
- Spend Permissions enabled at Smart Account creation
- CDP access-token retrieval in frontend and validation in backend
- CDP user -> StockOS profile/wallet sync
- Managed OpenRouter boundary
- OpenRouter strict structured-output schema + deterministic runtime validation
- OpenRouter BYOK encrypted with AES-256-GCM (MVP; production KEK should move to KMS)
- Natural-language strategy UI
- Deterministic strategy compiler
- Policy/risk engine; eligibility comes from server-side profile, never from client input
- B20 multiplier helpers and verified-asset registry boundary
- 0x Swap API v2 AllowanceHolder client
- CDP execution adapter boundary
- Worker boundary with autonomous execution disabled
- StockOSExecutor contract draft

## Manual platform wiring still required
1. CDP Portal: allow the local development origin for a development CDP project; add the eventual production Vercel domain to the production project. Do not allow localhost on the production CDP project.
2. Vercel: import `0xedev/StockOS`, set Root Directory to `apps/web`, then configure `NEXT_PUBLIC_CDP_PROJECT_ID` and `NEXT_PUBLIC_API_URL`.
3. Railway: import the same repo for API and worker services; configure server secrets there.
4. 0x: ensure the API key has tokenized-equity/BStocks routing access.

## Still gated before real money execution
- complete primary-source verification for every enabled B20 token address
- jurisdiction/eligibility provider integration
- 0x quote/reference-price sanity checks and transaction simulation
- user-approved CDP UserOperation builder
- tiny eligible-user Base mainnet E2E trade
