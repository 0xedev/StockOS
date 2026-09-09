import "./styles.css";
import { Providers } from "./providers";

export const metadata = {
  title: "StockOS",
  description: "Tell your portfolio what you want.",
  other: {
    "base:app_id": "6a989846fa998e02f8e863a7",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
