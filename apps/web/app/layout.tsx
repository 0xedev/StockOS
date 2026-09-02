import "./styles.css";
export const metadata = { title:"StockOS", description:"Tell your portfolio what you want." };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
