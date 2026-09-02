# StockOS build status

## Live
- Supabase project: `stockos`
- Supabase ref: `ogvutthiduyajmzrwbsa`
- Region: `eu-central-1`
- Initial schema applied with RLS
- Supabase security advisor: zero findings after hardening

## Implemented in this scaffold
- AI intent contract and demo parser
- Managed OpenRouter boundary
- BYOK AES-256-GCM encryption utility (MVP; move KEK to KMS in production)
- Deterministic strategy compiler
- Policy/risk engine
- B20 multiplier helpers
- Verified registry boundary (unverified assets disabled)
- 0x Swap API v2 AllowanceHolder client
- CDP wallet adapter boundary
- Next.js strategy preview shell
- Fastify strategy API
- Worker boundary with autonomous execution disabled
- StockOSExecutor contract draft
- Vercel/Railway config
- Core smoke tests

## Still requires secrets / external enablement
- OpenRouter managed key
- 0x API key + tokenized-equity access
- CDP project credentials
- Railway Redis
- full primary-source verification for every enabled B20 token address
- jurisdiction/eligibility provider integration
- tiny eligible-user Base mainnet E2E trade
