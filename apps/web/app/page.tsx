"use client";

import { AuthButton } from "@coinbase/cdp-react/components/AuthButton";
import { useCurrentUser, useGetAccessToken, useIsSignedIn } from "@coinbase/cdp-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";

const sample = "Build me an aggressive AI portfolio with $500. Keep Nvidia below 35% and 10% in cash.";
const defaultModel = "openai/gpt-5.6-luna";

export default function Home() {
  const { isSignedIn } = useIsSignedIn();
  const { currentUser } = useCurrentUser();
  const { getAccessToken } = useGetAccessToken();
  const [prompt, setPrompt] = useState(sample);
  const [result, setResult] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [aiSettings, setAiSettings] = useState<any>(null);
  const [byokKey, setByokKey] = useState("");
  const [byokModel, setByokModel] = useState(defaultModel);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const smartAddress = currentUser?.evmSmartAccountObjects?.[0]?.address ?? null;

  const authenticatedFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getAccessToken();
    if (!token) throw new Error("Sign in is required");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${apiUrl}${path}`, { ...init, headers });
  }, [apiUrl, getAccessToken]);

  const syncSession = useCallback(async () => {
    if (!isSignedIn) return;
    const response = await authenticatedFetch("/v1/session", { method: "POST" });
    if (!response.ok) throw new Error("Could not establish StockOS session");
    setSession(await response.json());
    const aiResponse = await authenticatedFetch("/v1/ai/settings");
    if (aiResponse.ok) {
      const settings = await aiResponse.json();
      setAiSettings(settings);
      setByokModel(settings.model ?? defaultModel);
    }
  }, [authenticatedFetch, isSignedIn]);

  useEffect(() => {
    if (!isSignedIn) {
      setSession(null);
      setAiSettings(null);
      setResult(null);
      return;
    }
    syncSession().catch(error => setMessage(error.message));
  }, [isSignedIn, currentUser?.userId, syncSession]);

  async function compile() {
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/strategy/compile", { method: "POST", body: JSON.stringify({ prompt }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Strategy compilation failed");
      setResult(body);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Strategy compilation failed"); }
    finally { setLoading(false); }
  }

  async function saveByok() {
    if (!byokKey.trim()) return setMessage("Enter an OpenRouter API key first.");
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok/openrouter", { method: "POST", body: JSON.stringify({ apiKey: byokKey, model: byokModel }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save BYOK key");
      setAiSettings(body); setByokKey(""); setMessage("OpenRouter BYOK enabled. The raw key is not returned by StockOS.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not save BYOK key"); }
    finally { setLoading(false); }
  }

  async function useManagedAi() {
    setLoading(true); setMessage("");
    try {
      const response = await authenticatedFetch("/v1/ai/byok/openrouter", { method: "DELETE" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not switch AI provider");
      setAiSettings(body); setMessage("StockOS managed OpenRouter is active.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not switch AI provider"); }
    finally { setLoading(false); }
  }

  const eligibilityLabel = useMemo(() => session?.profile?.eligibilityStatus ?? "unknown", [session]);

  return <main>
    <nav><strong>StockOS</strong><div className="nav-right"><span>Base · AI portfolio OS</span><AuthButton /></div></nav>
    <section className="hero">
      <div><p className="eyebrow">PROGRAMMABLE INVESTING</p><h1>Tell your portfolio<br/>what you want.</h1><p className="lede">Natural language becomes a deterministic, auditable portfolio strategy using tokenized stocks on Base.</p>{isSignedIn && <div className="identity"><span>Smart account</span><code>{smartAddress ?? "Creating…"}</code><span>Eligibility: <b>{eligibilityLabel}</b></span></div>}</div>
      <div className="composer"><label>Ask StockOS</label><textarea value={prompt} onChange={e => setPrompt(e.target.value)} /><button onClick={compile} disabled={loading || !isSignedIn}>{!isSignedIn ? "Sign in to build" : loading ? "Compiling…" : "Build strategy"}</button><small>AI proposes. StockOS validates. You approve execution.</small></div>
    </section>
    {message && <p className="message">{message}</p>}
    {isSignedIn && <section className="settings"><div><p className="eyebrow">AI LAYER</p><h2>Managed AI or bring your own key.</h2><p>Your model can interpret intent, but it never receives authority to move funds.</p></div><div className="byok"><div className="provider-row"><strong>Current</strong><span>{aiSettings?.provider === "openrouter_byok" ? `OpenRouter BYOK ${aiSettings?.byok?.maskedHint ?? ""}` : "StockOS Managed OpenRouter"}</span></div><input type="password" value={byokKey} onChange={e => setByokKey(e.target.value)} placeholder="OpenRouter API key" autoComplete="off"/><input value={byokModel} onChange={e => setByokModel(e.target.value)} placeholder={defaultModel}/><div className="buttons"><button onClick={saveByok} disabled={loading}>Use my key</button><button className="secondary" onClick={useManagedAi} disabled={loading}>Use managed AI</button></div></div></section>}
    {result && <section className="result"><header><div><span>Strategy preview</span><h2>${result.strategy?.totalUsd?.toLocaleString()}</h2><small>{result.ai?.source} · {result.ai?.model}</small></div><span className={result.policy?.allowed ? "pill ok" : "pill"}>{result.policy?.allowed ? "Policy passed" : "Execution gated"}</span></header><div className="grid">{result.strategy?.allocations?.map((a: any) => <article key={a.asset}><strong>{a.asset}</strong><b>{Math.round(a.weight * 100)}%</b><span>${a.amountUsd}</span></article>)}</div><div className="checks">{result.policy?.checks?.map((check: any) => <span key={check.name} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.name}</span>)}</div><p className="note">This is a proposal, not an executed trade. Mainnet execution remains disabled until eligibility, B20 address verification, 0x quote checks and explicit wallet approval all pass.</p></section>}
  </main>;
}
