# StockOS

StockOS is an AI operating system for programmable onchain portfolios on Base. Users describe an investment goal in natural language, StockOS converts it into structured intent, compiles a deterministic strategy, validates it against hard policy, then prepares user-approved execution into Coinbase B20 tokenized equities and USDC.

## Core safety invariant

The LLM never chooses arbitrary contract addresses or submits transactions. It produces structured intent only. Asset selection, allocation, eligibility, quote checks, slippage, and execution are deterministic.

## Stack

- Base + Coinbase B20 tokenized stocks
- CDP Smart Accounts / Paymaster / Spend Permissions
- 0x Swap API v2 (AllowanceHolder)
- OpenRouter managed AI + encrypted BYOK
- Next.js / TypeScript
- Supabase Postgres
- Railway API + worker
- Vercel frontend
- Foundry contracts

## MVP flow

`prompt -> structured intent -> strategy compiler -> policy engine -> preview -> user approval -> 0x/CDP execution -> portfolio`

## Status

Initial vertical slice scaffolded. External credentials are injected through environment variables and are never committed.
