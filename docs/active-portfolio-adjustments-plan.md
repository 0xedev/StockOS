# Active Portfolio Adjustments Plan

## Goal
Make the active portfolio the source of truth after execution, support real on-demand monitoring refreshes, and let users adjust a running portfolio through AI-assisted strategy amendments that are executed as deterministic portfolio deltas.

## Scope
1. Frontend lifecycle cleanup after successful execution.
2. On-demand portfolio snapshot refresh endpoint.
3. Active-strategy amendment/versioning instead of creating unrelated strategies.
4. Delta-based rebalance planning for active portfolios.
5. User-approved execution only; no autonomous trading.

## UX flow
1. User executes a strategy.
2. Once StockOS reports the strategy active, the stale strategy preview/prompt/execution-plan state is cleared.
3. The active portfolio card becomes the primary UI.
4. `Refresh monitoring` requests a fresh on-chain snapshot and then reloads portfolio state.
5. `Adjust portfolio` opens an amendment prompt pre-scoped to the active strategy.
6. AI compiles a proposed target allocation using the current active portfolio as context.
7. StockOS persists the proposal as the next version of the same strategy.
8. The execution planner computes current-vs-target deltas and prepares deterministic sell/buy calls.
9. User reviews and explicitly approves the rebalance.
10. After confirmation, the new strategy version becomes current and monitoring continues from the new targets.

## Backend design
- `POST /v1/portfolio/refresh`: captures a fresh snapshot immediately and returns the updated portfolio state.
- `POST /v1/strategy/adjust`: accepts a natural-language adjustment for the active strategy and persists a new pending strategy version.
- Existing execution preparation is extended to use live holdings for active-strategy amendments and create delta trades rather than treating the target as a brand-new portfolio.
- Activation updates `current_version` to the confirmed execution's strategy version.

## Safety boundaries
- AI only proposes target allocations.
- Deterministic code computes trade deltas and transaction calldata.
- Existing policy checks, exact approvals, B20 receiver checks, quote expiry, and user approval remain enforced.
- Autonomous trading remains disabled.

## Frontend state rules
- Draft/preview state is ephemeral.
- `activeStrategy != null` and confirmed execution clear stale preview/execution UI.
- Refresh controls show their own loading/error state.
- Adjustment mode can be cancelled without affecting the active strategy.

## Acceptance criteria
- Strategy preview disappears automatically after successful activation.
- Refresh monitoring causes a new snapshot with a newer `capturedAt` and block number.
- Adjusting an active strategy creates version N+1 on the same strategy id.
- Execution plans contain sells for overweight positions and buys for underweight positions where required.
- Strategy `current_version` advances only after transaction confirmation.
- No autonomous execution occurs without explicit user approval.
