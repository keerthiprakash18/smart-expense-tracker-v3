const ACCOUNTS = [{ id: 12, name: 'Synthetic Test Bank', account_type: 'BANK' }];
export function useFinance() {
  return { accounts: ACCOUNTS, profile: { currency: '₹' },
    refresh: async () => {}, notify: () => {} };
}