export type WalletExecution = { to: `0x${string}`; data: `0x${string}`; value?: bigint };
export interface StockOSWalletAdapter {
  getSmartAccountAddress(userId: string): Promise<`0x${string}`>;
  executeUserApproved(userId: string, calls: WalletExecution[]): Promise<{ transactionHash: `0x${string}` }>;
}
// CDP implementation is intentionally behind this interface. The API/worker never receives a user's private key.
