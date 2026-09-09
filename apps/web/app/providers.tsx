"use client";

import { getAccessToken } from "@coinbase/cdp-core";
import { CDPReactProvider, type Config } from "@coinbase/cdp-react";
import { useEffect, useState } from "react";

function StockOsApiSessionRefresh({ children }: { children: React.ReactNode }) {
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl) return;

    const originalFetch = window.fetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch.call(window, input, init);
      const requestUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (response.status !== 401 || !requestUrl.startsWith(apiUrl)) {
        return response;
      }

      // StockOS API validates CDP end-user access tokens server-side. If a cached
      // 15-minute access token expired, force one refresh and replay the request.
      // Retry through originalFetch so this interceptor can never recurse.
      try {
        const freshToken = await getAccessToken({ forceRefresh: true });
        if (!freshToken) {
          setSessionExpired(true);
          return response;
        }

        // All current StockOS authenticated API calls use URL strings. Avoid
        // replaying an already-consumed Request body from an arbitrary caller.
        if (typeof input !== "string" && !(input instanceof URL)) {
          setSessionExpired(true);
          return response;
        }

        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${freshToken}`);
        const retry = await originalFetch.call(window, input, { ...init, headers });

        if (retry.status === 401) {
          setSessionExpired(true);
        } else {
          setSessionExpired(false);
        }
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
