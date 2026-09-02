import "./styles.css";
import { Providers } from "./providers";

export const metadata = { title: "StockOS", description: "Tell your portfolio what you want." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><Providers>{children}</Providers></body></html>;
}
