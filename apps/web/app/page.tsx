"use client";

import { AuthButton, ExportWalletModal, FundModal, type FetchBuyOptions, type FetchBuyQuote } from "@coinbase/cdp-react";
import { useCurrentUser, useGetAccessToken, useIsSignedIn, useSendUserOperation } from "@coinbase/cdp-hooks";
import { useCallback, useEffect, useState } from "react";

const examples = [
  "Invest $1,000: 50% Apple, 30% Nvidia and 20% cash.",
  "Put $750 equally across Apple, Google and Meta. No Nvidia.",
  "Build an aggressive $2,000 portfolio. Keep Nvidia under 40%, hold at least 10% cash, and rebalance monthly.",
];

type ByokProvider = "openai" | "anthropic" | "gemini" | "openrouter";
const providerLabels: Record<ByokProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  openrouter: "OpenRouter",
};
const providerModels: Record<ByokProvider, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-sonnet-5",
  gemini: "gemini-3.8-flash",
  openrouter: "openrouter/free",
};

type ExecutionPlan = {
  planId: string;
  phase: "allowance_required" | "ready" | "blocked";
  executable: boolean;
  expiresAt?: string;
  calls: Array<{ kind: "approval" | "swap"; label: string; to: string; data: string; value: string }>;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
};

type WalletSummary = {
  address: string;
  network: "base";
  chainId: 8453;
  balances: {
    ETH: { raw: string; formatted: string };
    USDC: { raw: string; formatted: string };
  };
};

type PortfolioPosition = {
  asset: string;
  tokenUnits?: number;
  priceUsd?: number | null;
  valueUsd?: number | null;
  targetWeight?: number;
  currentWeight?: number;
  drift?: number;
  absoluteDrift?: number;
};

type PortfolioState = {
  activeStrategy: null | {
    id: string;
    name: string;
    status: "active";
    version: number;
    activatedAt: string;
    nextRebalanceAt?: string | null;
    rebalance?: { frequency?: string; mode?: string } | null;
  };
  portfolio: null | {
    totalValueUsd: number;
    cashValueUsd: number;
    positions: PortfolioPosition[];
    largestDrift: number;
    blockNumber?: string;
    capturedAt: string;
  };
  execution: null | {
    planId: string;
    strategyId: string;
    planStatus: string;
    phase?: string | null;
    status: string;
    transactionHash?: string | null;
    submittedAt?: string | null;
    confirmedAt?: string | null;
    failureCode?: string | null;
    failureMessage?: string | null;
    updatedAt?: string | null;
  };
};

function formatUsd(value: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export default function Home() {
  const { isSignedIn } = useIsSignedIn();
  const { currentUser } = useCurrentUser();
  const { getAccessToken } = useGetAccessToken();
  const { sendUserOperation, status: sendStatus } = useSendUserOperation();
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<any>(null);
  const [executionPlan, setExecutionPlan] = useState<ExecutionPlan | null>(null);
  const [portfolioState, setPortfolioState] = useState<PortfolioState | null>(null);
  const [session, setSession] = useState<any>(null);
  const [walletSummary, setWalletSummary] = useState<WalletSummary | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [sendAsset, setSendAsset] = useState<"USDC" | "ETH">("USDC");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [aiSettings, setAiSettings] = useState<any>(null);
  const [byokProvider, setByokProvider] = useState<ByokProvider>("openai");
  const [byokKey, setByokKey] = useState("");
  const [byokModel, setByokModel] = useState(providerModels.openai);
  const [fundCountry, setFundCountry] = useState("");
  const [fundSubdivision, setFundSubdivision] = useState("");
  const [loading, setLoading] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [message, setMessage] = useState("");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const smartAddress = currentUser?.evmSmartAccountObjects?.[0]?.address ?? currentUser?.evmSmartAccounts?.[0] ?? null;
  const cdpSmartAccount = currentUser?.evmSmartAccounts?.[0] ?? null;
  const ownerAddress = session?.wallet?.ownerAddress ?? null;

  const authenticatedFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Sign in is required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${apiUrl}${path}`, { ...init, headers });
  }, [apiUrl, getAccessToken]);

  const refreshWallet = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/wallet/summary");
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not load wallet balances");
    setWalletSummary(body);
  }, [authenticatedFetch, isSignedIn]);

  const refreshPortfolio = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/portfolio/active");
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not load portfolio state");
    setPortfolioState(body);
  }, [authenticatedFetch, isSignedIn]);

  const syncSession = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/session", { method: "POST" });
    if (!response.ok) throw new Error("Could not establish StockOS session");
    setSession(await response.json());

    const [aiResponse, walletResponse, portfolioResponse] = await Promise.all([
      authenticatedFetch("/v1/ai/settings"),
      authenticatedFetch("/v1/wallet/summary"),
      authenticatedFetch("/v1/portfolio/active"),
    ]);
    if (aiResponse.ok) {
      const settings = await aiResponse.json();
      setAiSettings(settings);
      const provider = settings?.byok?.provider as ByokProvider | undefined;
      if (provider && providerLabels[provider]) {
        setByokProvider(provider);
        setByokModel(settings?.byok?.model ?? providerModels[provider]);
      }
    }
    if (walletResponse.ok) setWalletSummary(await walletResponse.json());
    if (portfolioResponse.ok) setPortfolioState(await portfolioResponse.json());
  }, [authenticatedFetch, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) {
      setWalletOpen(false);
      setSession(null);
      setWalletSummary(null);
      setAiSettings(null);
      setPortfolioState(null);
      setResult(null);
      setExecutionPlan(null);
      return;
    }
    syncSession().catch(error => setMessage(error.message));
  }, [isSignedIn, currentUser?.userId, syncSession]);

  useEffect(() => {
    if (!isSignedIn) return;
    const timer = window.setInterval(() => {
      refreshPortfolio().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [isSignedIn, refreshPortfolio]);

  useEffect(() => {
    if (!walletOpen) return;
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWalletOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [walletOpen]);

  useEffect(() => {
    if (fundCountry || typeof navigator === "undefined") return;
    const region = navigator.language.match(/[-_]([A-Za-z]{2})$/)?.[1];
    if (region) setFundCountry(region.toUpperCase());
  }, [fundCountry]);

  const fetchBuyOptions: FetchBuyOptions = useCallback(async params => {
    const query = new URLSearchParams({ country: params.country });
    if (params.subdivision) query.set("subdivision", params.subdivision);
    const response = await authenticatedFetch(`/v1/onramp/buy-options?${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not load funding options");
    return body;
  }, [authenticatedFetch]);

  const fetchBuyQuote: FetchBuyQuote = useCallback(async params => {
    const response = await authenticatedFetch("/v1/onramp/buy-quote", { method: "POST", body: JSON.stringify(params) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not create funding quote");
    return body;
  }, [authenticatedFetch]);

  async function copyReceiveAddress() {
    if (!smartAddress) return;
    await navigator.clipboard.writeText(smartAddress);
    setMessage("Smart Account address copied. Send Base USDC, ETH, or other supported Base assets to this address.");
  }

  async function sendWalletAsset() {
    if (!cdpSmartAccount) return setMessage("Smart Account is not ready yet.");
    if (!sendTo.trim() || !sendAmount.trim()) return setMessage("Enter a recipient and amount.");
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/wallet/send/prepare", {
        method: "POST",
        body: JSON.stringify({ asset: sendAsset, to: sendTo.trim(), amount: sendAmount.trim() }),
      });
      const prepared = await response.json();
      if (!response.ok) throw new Error(prepared.message ?? prepared.error ?? "Could not prepare wallet send");
      const sent = await sendUserOperation({
        evmSmartAccount: cdpSmartAccount,
        network: "base",
        calls: [{ to: prepared.call.to as `0x${string}`, data: prepared.call.data as `0x${string}`, value: BigInt(prepared.call.value) }],
        useCdpPaymaster: true,
      });
      const reference = (sent as any)?.transactionHash ?? (sent as any)?.userOperationHash ?? (sent as any)?.hash;
      if (!reference) throw new Error("CDP did not return a transaction or user-operation reference");
      setMessage(`${prepared.amount} ${prepared.asset} send submitted: ${reference}`);
      setSendAmount("");
      await refreshWallet().catch(() => undefined);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Wallet send failed"); }
    finally { setLoading(false); }
  }

  async function compile() {
    if (!prompt.trim()) return setMessage("Describe the portfolio you want first.");
    setCompiling(true); setMessage(""); setExecutionPlan(null);
    try {
      const response = await authenticatedFetch("/v1/strategy/compile", { method: "POST", body: JSON.stringify({ prompt }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Strategy compilation failed");
      setResult(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Strategy compilation failed"); }
    finally { setCompiling(false); }
  }

  async function prepare() {
    if (!result?.draft?.strategyVersionId) return;
    setLoading(true); setMessage(""); setExecutionPlan(null);
    try {
      const response = await authenticatedFetch("/v1/execution/prepare", { method: "POST", body: JSON.stringify({ strategyVersionId: result.draft.strategyVersionId }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "insufficient_usdc") {
          setWalletOpen(true);
          await refreshWallet().catch(() => undefined);
        }
        throw new Error(body.message ?? body.error ?? "Could not prepare execution");
      }
      setExecutionPlan(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not prepare execution"); }
    finally { setLoading(false); }
  }

  async function executePlan() {
    if (!executionPlan?.executable || !cdpSmartAccount) return;
    if (executionPlan.expiresAt && Date.now() > Date.parse(executionPlan.expiresAt)) {
      setMessage("The quote expired. Prepare a fresh execution plan."); setExecutionPlan(null); return;
    }
    setLoading(true); setMessage("");
    try {
      const sent = await sendUserOperation({
        evmSmartAccount: cdpSmartAccount,
        network: "base",
        calls: executionPlan.calls.map(call => ({ to: call.to as `0x${string}`, data: call.data as `0x${string}`, value: BigInt(call.value) })),
        useCdpPaymaster: true,
      });
      const transactionHash = (sent as any)?.transactionHash;
      if (!transactionHash) throw new Error("CDP completed the user operation without returning a transaction hash. Refresh and retry before continuing.");
      const submittedResponse = await authenticatedFetch(`/v1/execution/${executionPlan.planId}/submitted`, { method: "POST", body: JSON.stringify({ transactionHash }) });
      const submittedBody = await submittedResponse.json();
      if (!submittedResponse.ok) throw new Error(submittedBody.message ?? submittedBody.error ?? "Could not record submitted transaction");

      if (executionPlan.phase === "allowance_required") {
        setMessage("Exact USDC allowance confirmed. StockOS is rebuilding fresh quotes before the trade.");
        setExecutionPlan(null);
        await prepare();
      } else {
        setMessage("Portfolio transaction submitted. StockOS is monitoring Base until it confirms.");
        setExecutionPlan(null);
        await Promise.all([refreshPortfolio().catch(() => undefined), refreshWallet().catch(() => undefined)]);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "User operation failed"); }
    finally { setLoading(false); }
  }

  async function saveByok() {
    if (!byokKey.trim()) return setMessage(`Enter your ${providerLabels[byokProvider]} API key first.`);
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok", {
        method: "POST",
        body: JSON.stringify({ provider: byokProvider, apiKey: byokKey, model: byokModel }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not save AI key");
      setAiSettings(body); setByokKey("");
      setMessage(`${providerLabels[byokProvider]} is now your AI provider. StockOS stores the key encrypted and never returns the raw value.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save AI key"); }
    finally { setLoading(false); }
  }

  async function useManagedAi() {
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? "Could not switch AI provider");
      setAiSettings(body); setMessage("StockOS Managed AI is active.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not switch AI provider"); }
    finally { setLoading(false); }
  }

  const operationPending = loading || compiling || sendStatus === "pending";
  const countryReady = /^[A-Z]{2}$/.test(fundCountry) && (fundCountry !== "US" || !!fundSubdivision.trim());
  const availableUsdc = Number(walletSummary?.balances.USDC.formatted ?? 0);
  const usdcBalance = availableUsdc.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const ethBalance = Number(walletSummary?.balances.ETH.formatted ?? 0).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const requiredUsdc = Number(result?.strategy?.allocations?.filter((allocation: any) => allocation.asset !== "USDC").reduce((sum: number, allocation: any) => sum + Number(allocation.amountUsd ?? 0), 0) ?? 0);
  const fundingShortfall = Math.max(0, requiredUsdc - availableUsdc);
  const executionStatus = portfolioState?.execution?.status;
  const executionPending = executionStatus === "submitted" || executionStatus === "confirming";
  const executionFailed = executionStatus === "failed";
  const positions = portfolioState?.portfolio?.positions?.filter(position => (position.valueUsd ?? 0) > 0.005 || (position.targetWeight ?? 0) > 0) ?? [];

  return <main>
    <nav>
      <strong>StockOS</strong>
      <div className="nav-right">
        <span>Base · AI portfolio OS</span>
        {isSignedIn ? <button type="button" className="wallet-trigger" onClick={() => setWalletOpen(true)}>Wallet</button> : <AuthButton />}
      </div>
    </nav>

    <section className="hero">
      <div><p className="eyebrow">PROGRAMMABLE INVESTING</p><h1>Tell your portfolio<br/>what you want.</h1><p className="lede">Type the allocation, constraints, risk profile or plain-English goal. StockOS turns it into a validated portfolio using tokenized stocks on Base.</p>{isSignedIn && <div className="identity"><span>Smart account</span><code>{smartAddress ?? "Creating…"}</code></div>}</div>
      <div className="composer"><label>Describe your strategy</label><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="e.g. Invest $1,000: 50% Apple, 30% Nvidia and 20% cash."/><div className="examples">{examples.map(example => <button type="button" key={example} onClick={() => setPrompt(example)}>{example}</button>)}</div><button className="primary" onClick={compile} disabled={operationPending || !isSignedIn || !prompt.trim()}>{!isSignedIn ? "Sign in to build" : compiling ? "Compiling your strategy…" : "Build my strategy"}</button><small>Managed AI proposes weights. StockOS validates the result deterministically. You approve every execution.</small></div>
    </section>

    {message && <p className="message">{message}</p>}

    {result && <section className="result"><header><div><span>Strategy preview</span><h2>${result.strategy?.totalUsd?.toLocaleString()}</h2><small>{result.ai?.source === "managed" ? "Managed AI" : result.ai?.source === "byok" ? "Your AI provider" : result.ai?.source === "deterministic_fallback" ? "Deterministic fallback" : "StockOS parser"}</small></div><span className={result.policy?.allowed ? "pill ok" : "pill"}>{result.policy?.allowed ? "Policy passed" : "Review required"}</span></header><div className="grid">{result.strategy?.allocations?.map((allocation: any) => <article key={allocation.asset}><strong>{allocation.asset}</strong><b>{(allocation.weight * 100).toFixed((allocation.weight * 100) % 1 ? 1 : 0)}%</b><span>${allocation.amountUsd}</span></article>)}</div>{result.strategy?.warnings?.length > 0 && <div className="warnings">{result.strategy.warnings.map((warning: string) => <p key={warning}>{warning}</p>)}</div>}<div className="checks">{result.policy?.checks?.map((check: any) => <span key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.name}</span>)}</div><div className="next-step"><div><strong>{requiredUsdc <= 0 ? "No stock trade is required" : fundingShortfall > 0 ? `${formatUsd(fundingShortfall)} more USDC needed` : "Ready for execution review"}</strong><span>{requiredUsdc <= 0 ? "This strategy is entirely cash." : fundingShortfall > 0 ? `Your Smart Account has ${formatUsd(availableUsdc)}. Fund it, then StockOS will build live 0x quotes.` : "StockOS will now check live balances, B20 policy, liquidity, allowance and reference pricing."}</span></div><button className="execution-cta" onClick={() => fundingShortfall > 0 ? setWalletOpen(true) : void prepare()} disabled={operationPending || !result.policy?.allowed || requiredUsdc <= 0}>{requiredUsdc <= 0 ? "No trade required" : fundingShortfall > 0 ? "Fund wallet to continue" : loading ? "Preparing execution…" : "Review & invest"}</button></div></section>}

    {executionPlan && <section className="execution"><header><div><p className="eyebrow">EXECUTION PLAN</p><h2>{executionPlan.phase === "allowance_required" ? "Step 1 · Exact allowance" : executionPlan.phase === "ready" ? "Step 2 · Ready to invest" : "Execution blocked"}</h2></div><span className={executionPlan.executable ? "pill ok" : "pill"}>{executionPlan.executable ? "Checks passed" : "Fail closed"}</span></header><div className="call-list">{executionPlan.calls.map((call,index) => <div key={`${call.kind}-${index}`}><b>{index+1}. {call.label}</b><code>{call.to}</code></div>)}</div><div className="checks">{executionPlan.checks.map(check => <span key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.name}{check.detail ? ` · ${check.detail}` : ""}</span>)}</div>{executionPlan.expiresAt && <p className="note">Firm 0x quote expires at {new Date(executionPlan.expiresAt).toLocaleTimeString()}.</p>}<button className="execute-button" onClick={executePlan} disabled={operationPending || !executionPlan.executable}>{executionPlan.phase === "allowance_required" ? "Approve exact USDC allowance" : "Confirm & invest"}</button><p className="note">Your CDP Smart Account submits this operation only after you approve it. The AI never signs transactions.</p></section>}

    {executionPending && <section className="lifecycle-card pending"><div><p className="eyebrow">EXECUTION</p><h2>Portfolio transaction is confirming.</h2><p>StockOS is watching Base independently of this browser. You can close the page and the worker will keep reconciling the receipt.</p></div><div className="lifecycle-side"><span className="status-dot">Confirming</span>{portfolioState?.execution?.transactionHash && <a href={`https://basescan.org/tx/${portfolioState.execution.transactionHash}`} target="_blank" rel="noreferrer">View on BaseScan</a>}</div></section>}

    {executionFailed && <section className="lifecycle-card failed"><div><p className="eyebrow">EXECUTION FAILED</p><h2>The portfolio transaction did not complete.</h2><p>{portfolioState?.execution?.failureMessage ?? "The Base transaction failed. Prepare a fresh execution plan before retrying."}</p></div><button onClick={() => void prepare()} disabled={!result || operationPending}>Prepare fresh execution</button></section>}

    {portfolioState?.activeStrategy && <section className="active-portfolio"><header><div><p className="eyebrow">ACTIVE PORTFOLIO</p><h2>{portfolioState.activeStrategy.name}</h2><p>StockOS is monitoring the Smart Account on Base and comparing actual holdings with this strategy's target weights.</p></div><span className="live-pill">● Live monitoring</span></header>{portfolioState.portfolio ? <><div className="portfolio-metrics"><div><span>Portfolio value</span><strong>{formatUsd(portfolioState.portfolio.totalValueUsd)}</strong></div><div><span>Cash</span><strong>{formatUsd(portfolioState.portfolio.cashValueUsd)}</strong></div><div><span>Largest drift</span><strong>{(portfolioState.portfolio.largestDrift * 100).toFixed(1)}%</strong></div><div><span>Last snapshot</span><strong>{new Date(portfolioState.portfolio.capturedAt).toLocaleTimeString()}</strong></div></div><div className="position-list">{positions.map(position => <div key={position.asset}><div><strong>{position.asset}</strong><span>{formatUsd(Number(position.valueUsd ?? 0))}</span></div><div className="weight-line"><span>Actual {((position.currentWeight ?? 0) * 100).toFixed(1)}%</span><span>Target {((position.targetWeight ?? 0) * 100).toFixed(1)}%</span><span className={(position.absoluteDrift ?? 0) <= .03 ? "drift-ok" : "drift-warn"}>Drift {((position.drift ?? 0) * 100).toFixed(1)}%</span></div></div>)}</div></> : <div className="snapshot-pending">First onchain portfolio snapshot is pending. The worker captures one after confirmation and then every minute.</div>}<footer><div><span>Next rebalance</span><strong>{portfolioState.activeStrategy.nextRebalanceAt ? new Date(portfolioState.activeStrategy.nextRebalanceAt).toLocaleString() : "Manual"}</strong></div><div className="buttons"><button onClick={() => void refreshPortfolio()} disabled={operationPending}>Refresh monitoring</button>{portfolioState.execution?.transactionHash && <a className="button-link" href={`https://basescan.org/tx/${portfolioState.execution.transactionHash}`} target="_blank" rel="noreferrer">Last transaction</a>}</div></footer></section>}

    {isSignedIn && <section className="settings"><div><p className="eyebrow">AI SETTINGS</p><h2>Managed AI by default. Use your own provider if you prefer.</h2><p>AI only interprets portfolio intent. Token addresses, policy checks, quotes and transaction calldata remain deterministic and outside the model.</p></div><div className="byok"><div className="provider-row"><strong>Current</strong><span>{aiSettings?.mode === "byok" ? `${providerLabels[(aiSettings?.byok?.provider as ByokProvider) ?? byokProvider]} · ${aiSettings?.byok?.maskedHint ?? "your key"}` : "Managed AI"}</span></div><label className="field-label">Provider<select value={byokProvider} onChange={event => { const provider = event.target.value as ByokProvider; setByokProvider(provider); setByokModel(providerModels[provider]); }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option><option value="openrouter">OpenRouter</option></select></label><label className="field-label">API key<input type="password" value={byokKey} onChange={event => setByokKey(event.target.value)} placeholder={`${providerLabels[byokProvider]} API key`} autoComplete="off"/></label><label className="field-label">Model<input value={byokModel} onChange={event => setByokModel(event.target.value)} placeholder={providerModels[byokProvider]}/></label><div className="buttons"><button onClick={saveByok} disabled={operationPending}>Use my provider</button>{aiSettings?.mode === "byok" && <button className="secondary-action" onClick={useManagedAi} disabled={operationPending}>Back to managed AI</button>}</div></div></section>}

    {isSignedIn && walletOpen && <div className="wallet-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setWalletOpen(false); }}>
      <section className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title">
        <header className="wallet-modal-header"><div><p className="eyebrow">YOUR BASE WALLET</p><h2 id="wallet-modal-title">Wallet</h2></div><button type="button" className="wallet-modal-close" aria-label="Close wallet" onClick={() => setWalletOpen(false)}>×</button></header>
        <div className="wallet-panel wallet-panel-modal"><div><h2>Your assets</h2><p>The Smart Account holds and trades your assets. Its owner EOA is the exportable key that controls it.</p><div className="balance-grid"><div><span>USDC</span><strong>{usdcBalance}</strong></div><div><span>ETH</span><strong>{ethBalance}</strong></div></div><div className="wallet-address"><span>Smart Account</span><code>{smartAddress ?? "Creating…"}</code></div>{ownerAddress && <div className="wallet-address"><span>Owner EOA</span><code>{ownerAddress}</code></div>}<div className="buttons wallet-top-actions"><button onClick={copyReceiveAddress} disabled={!smartAddress}>Receive / copy address</button><button className="secondary-action" onClick={() => refreshWallet().catch(error => setMessage(error.message))} disabled={operationPending}>Refresh balances</button>{smartAddress && <a className="button-link" href={`https://basescan.org/address/${smartAddress}`} target="_blank" rel="noreferrer">BaseScan</a>}</div></div><div className="wallet-actions"><div className="wallet-box"><strong>Fund wallet</strong><p>Buy USDC into this Smart Account with Coinbase Onramp, where available.</p><div className="fund-config"><label>Country code<input value={fundCountry} maxLength={2} onChange={event => setFundCountry(event.target.value.toUpperCase())} placeholder="NG"/></label>{fundCountry === "US" && <label>State code<input value={fundSubdivision} maxLength={3} onChange={event => setFundSubdivision(event.target.value.toUpperCase())} placeholder="NY"/></label>}</div><div className="buttons">{countryReady && smartAddress ? <FundModal country={fundCountry} subdivision={fundSubdivision || undefined} cryptoCurrency="usdc" fiatCurrency="usd" fetchBuyQuote={fetchBuyQuote} fetchBuyOptions={fetchBuyOptions} network="base" destinationAddress={smartAddress} presetAmountInputs={[25,50,100]} title="Fund your StockOS wallet" onSuccess={() => { setMessage("Funding completed. Refreshing wallet balance."); refreshWallet().catch(() => undefined); }} onError={() => setMessage("Coinbase funding is unavailable for this country, account, or payment method.")} /> : <button disabled>{!smartAddress ? "Smart Account is still being created" : "Enter country code to fund"}</button>}{ownerAddress && <ExportWalletModal address={ownerAddress} onCopySuccess={() => setMessage("Owner private key copied through Coinbase's secure export flow. StockOS never receives it.")} onIframeError={error => setMessage(error ?? "Wallet export failed")}><button type="button" className="secondary-action">Export owner key</button></ExportWalletModal>}</div><small>You can always fund directly by sending Base USDC or ETH to the Smart Account address.</small></div><div className="wallet-box"><strong>Send / withdraw</strong><p>Prepare a deterministic transfer, then approve it with your CDP Smart Account.</p><div className="send-row"><select value={sendAsset} onChange={event => setSendAsset(event.target.value as "USDC" | "ETH")}><option value="USDC">USDC</option><option value="ETH">ETH</option></select><input value={sendAmount} onChange={event => setSendAmount(event.target.value)} inputMode="decimal" placeholder="Amount"/></div><input value={sendTo} onChange={event => setSendTo(event.target.value)} placeholder="0x recipient address"/><button onClick={sendWalletAsset} disabled={operationPending || !sendAmount.trim() || !sendTo.trim()}>Review & send {sendAsset}</button><small>The AI cannot call this action. The backend only prepares transfer calldata after you enter the destination and amount.</small></div></div></div>
        <footer className="wallet-modal-footer"><div><strong>Account</strong><span>Signed in with Coinbase CDP</span></div><AuthButton /></footer>
      </section>
    </div>}
  </main>;
}
