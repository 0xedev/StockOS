# StockOS build status

## Live
- Supabase project: `stockos`
- Supabase ref: `ogvutthiduyajmzrwbsa`
- Region: `eu-central-1`
- Supabase is backend-only persistence; CDP is authoritative end-user auth
- RLS is explicit deny-all for browser roles on private financial tables
- B20/corporate-action reference tables remain public read-only
- StockOS has no app-level eligibility gate; execution relies on wallet ownership, B20 onchain policy/authorization, and execution safety checks

## Implemented
- CDP React provider configured to create Smart Accounts on login
- Spend Permissions enabled at Smart Account creation
- CDP access-token retrieval in frontend and validation in backend
- CDP user -> StockOS profile/wallet sync
- Managed OpenRouter boundary
- OpenRouter strict structured-output schema + deterministic runtime validation
- Managed-AI timeout/blank-output fallback to deterministic parsing
- OpenRouter BYOK encrypted with AES-256-GCM (MVP; production KEK should move to KMS)
- Natural-language strategy UI
- Deterministic strategy compiler
- Policy/risk engine for slippage, quote freshness, asset registry and strategy constraints
- B20 multiplier helpers and official Base asset registry
- B20 pause/policy authorization checks before execution
- Official Base Chainlink total-return reference feeds
- 0x Swap API v2 AllowanceHolder client
- Exact-amount USDC approval flow; no unlimited approval
- User-approved CDP Smart Account execution boundary
- Worker boundary with autonomous execution disabled
- StockOSExecutor contract draft

## Current production wiring
- Web: Vercel
- API + worker + Redis: Railway
- Database: Supabase
- Auth/wallets: Coinbase CDP
- AI: OpenRouter managed/BYOK
- Swap routing: 0x on Base

## Still gated before a real-money production release
- verify the full B20/0x flow with a funded test Smart Account using a deliberately small amount
- complete transaction confirmation/reconciliation and failure-state handling
- verify reference-price behavior during market-close/corporate-action periods
- complete monitoring, alerts and incident controls
- audit the user-approved execution path end to end
