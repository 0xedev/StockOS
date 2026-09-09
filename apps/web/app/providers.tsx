"use client";

import { getAccessToken } from "@coinbase/cdp-core";
import { CDPReactProvider, type Config } from "@coinbase/cdp-react";
import { useEffect, useState } from "react";

const TOKEN_REFRESH_SKEW_SECONDS = 60;

function bearerToken(headers?: HeadersInit): string | null {
  if (!headers) return null;
  const value = new Headers(headers).get("Authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function jwtExpiresSoon(token: string): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return true;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const decoded = JSON.parse(window.atob(padded)) as { exp?: number };
    if (typeof decoded.exp !== "number") return true;
    return decoded.exp <= Math.floor(Date.now() / 1000) + TOKEN_REFRESH_SKEW_SECONDS;
  } catch {
    return true;
  }
}

function StockOsApiSessionRefresh({ children }: { children: React.ReactNode }) {
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) return;

    const originalFetch = window.fetch;
    let refreshPromise: Promise<string | null> | null = null;

    const refreshToken = () => {
      if (!refreshPromise) {
        refreshPromise = Promise.resolve(getAccessToken({ forceRefresh: true }))
          .then(token => token ?? null)
          .finally(() => { refreshPromise = null; });
      }
      return refreshPromise;
    };

    const requestUrl = (input: RequestInfo | URL) => typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    const withToken = (init: RequestInit | undefined, token: string): RequestInit => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return { ...init, headers };
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const isStockOsApi = url.startsWith(apiUrl);
      let requestInit = init;
      let proactivelyRefreshed = false;

      // CDP access tokens are short lived. Refresh before sending a StockOS request
      // when the JWT is already expired or is within one minute of expiry. This avoids
      // an expected 401 and, importantly, coalesces parallel wallet/AI/portfolio calls
      // behind one refresh operation.
      if (isStockOsApi) {
        const token = bearerToken(init?.headers);
        if (token && jwtExpiresSoon(token)) {
          try {
            const freshToken = await refreshToken();
            if (freshToken) {
              requestInit = withToken(init, freshToken);
              proactivelyRefreshed = true;
              setSessionExpired(false);
            }
          } catch {
            // Let the request proceed once; the 401 branch below will surface a clean
            // reconnect state rather than creating a refresh loop.
          }
        }
      }

      const response = await originalFetch.call(window, input, requestInit);
      if (response.status !== 401 || !isStockOsApi) return response;

      // Retry one URL-based StockOS request with a forced fresh token. Avoid replaying
      // arbitrary Request objects because their body may already be consumed.
      if (typeof input !== "string" && !(input instanceof URL)) {
        setSessionExpired(true);
        return response;
      }

      try {
        const freshToken = proactivelyRefreshed ? null : await refreshToken();
        if (!freshToken) {
          setSessionExpired(true);
          return response;
        }
        const retry = await originalFetch.call(window, input, withToken(init, freshToken));
        setSessionExpired(retry.status === 401);
        return retry;
      } catch {
        setSessionExpired(true);
        return response;
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return (
    <>
      {sessionExpired ? (
        <div
          role="status"
          style={{
            position: "fixed",
            zIndex: 10000,
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            width: "min(92vw, 620px)",
            padding: "12px 14px",
            borderRadius: 14,
            background: "#111827",
            color: "white",
            boxShadow: "0 12px 36px rgba(0,0,0,.24)",
            display: "flex",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 14,
          }}
        >
          <span>Your wallet session expired. Reconnect to continue securely.</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              border: 0,
              borderRadius: 10,
              padding: "8px 12px",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Reconnect
          </button>
        </div>
      ) : null}
      {children}
    </>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const projectId = process.env.NEXT_PUBLIC_CDP_PROJECT_ID;
  if (!projectId) {
    return <main className="config-error"><strong>StockOS setup incomplete</strong><p>NEXT_PUBLIC_CDP_PROJECT_ID must be configured before sign-in can start.</p></main>;
  }

  const config: Config = {
    projectId,
    appName: "StockOS",
    authMethods: ["email", "oauth:google"],
    disableAnalytics: true,
    ethereum: {
      createOnLogin: "smart",
      enableSpendPermissions: true,
    },
  };

  return (
    <CDPReactProvider config={config}>
      <StockOsApiSessionRefresh>{children}</StockOsApiSessionRefresh>
    </CDPReactProvider>
  );
}
