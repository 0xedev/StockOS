"use client";

import { CDPReactProvider, type Config } from "@coinbase/cdp-react";

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
  return <CDPReactProvider config={config}>{children}</CDPReactProvider>;
}
