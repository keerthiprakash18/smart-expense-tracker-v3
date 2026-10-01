import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../services/api';

const FinanceContext = createContext(null);

const emptySummary = {
  total_income: 0,
  total_expenses: 0,
  total_bills: 0,
  net_balance: 0,
  account_balance: 0,
  count: 0,
  ocr_scanned_count: 0,
  monthly_budget: 0,
  borrowed_remaining: 0,
  lent_remaining: 0,
  unpaid_bills: 0,
  savings_current: 0,
};

const LEDGER_PAGE_SIZE = 50;

// Expenses are paginated server-side; return the rows plus paging metadata.
function expenseRows(payload) {
  if (Array.isArray(payload)) return { rows: payload, paging: null };
  const body = payload || {};
  return {
    rows: Array.isArray(body.results) ? body.results : [],
    paging: {
      count: body.count ?? 0,
      page: body.page ?? 1,
      pageSize: body.page_size ?? LEDGER_PAGE_SIZE,
      totalPages: body.total_pages ?? 1,
      hasNext: Boolean(body.has_next),
      hasPrevious: Boolean(body.has_previous),
    },
  };
}

export function FinanceProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [transactionPaging, setTransactionPaging] = useState(null);
  const [summary, setSummary] = useState(emptySummary);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, type = 'success') => {
    setToast({ message, type, id: Date.now() });
  }, []);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const [profileRes, accountsRes, txRes, summaryRes] = await Promise.all([
        api.get('/api/profile/'),
        api.get('/api/accounts/'),
        api.get(`/api/expenses/?page_size=${LEDGER_PAGE_SIZE}`),
        api.get('/api/dashboard/'),
      ]);
      setProfile(profileRes.data);
      setAccounts(Array.isArray(accountsRes.data) ? accountsRes.data : []);
      const parsed = expenseRows(txRes.data);
      setTransactions(parsed.rows);
      setTransactionPaging(parsed.paging);
      setSummary({ ...emptySummary, ...summaryRes.data });
    } catch (err) {
      if (err.response?.status === 401) {
        setError('');
      } else {
        const message = err.response?.data?.error || err.response?.data?.detail || 'Unable to load your finance workspace.';
        setError(message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Append an older page of transactions (used by the ledger's load-more).
  const loadMoreTransactions = useCallback(async () => {
    const nextPage = transactionPaging?.hasNext ? (transactionPaging.page + 1) : null;
    if (nextPage === null) return false;
    try {
      const res = await api.get(`/api/expenses/?page=${nextPage}&page_size=${LEDGER_PAGE_SIZE}`);
      const parsed = expenseRows(res.data);
      setTransactions((prev) => [...prev, ...parsed.rows]);
      setTransactionPaging(parsed.paging);
      return parsed.paging?.hasNext ?? false;
    } catch {
      return false;
    }
  }, [transactionPaging]);

  // Keeps the local ledger accurate after a create/update/delete without a
  // full refetch, then refreshes aggregate balances in the background.
  const syncAfterMutation = useCallback(async () => {
    await loadAll({ silent: true });
  }, [loadAll]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const createTransaction = useCallback(async (payload) => {
    const hasFile = payload.receipt_image instanceof File;
    let body = payload;
    if (hasFile) {
      body = new FormData();
      Object.entries(payload).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') body.append(key, value);
      });
    }
    const response = await api.post('/api/expenses/', body);
    await syncAfterMutation();
    notify('Transaction saved');
    return response.data;
  }, [syncAfterMutation, notify]);

  const updateTransaction = useCallback(async (id, payload) => {
    const response = await api.patch(`/api/expenses/${id}/`, payload);
    await syncAfterMutation();
    notify('Transaction updated');
    return response.data;
  }, [syncAfterMutation, notify]);

  const deleteTransaction = useCallback(async (id) => {
    await api.delete(`/api/expenses/${id}/`);
    await syncAfterMutation();
    notify('Transaction deleted');
  }, [syncAfterMutation, notify]);

  const createAccount = useCallback(async (payload) => {
    const response = await api.post('/api/accounts/', payload);
    await loadAll({ silent: true });
    notify('Account added');
    return response.data;
  }, [loadAll, notify]);

  const updateProfile = useCallback(async (payload) => {
    const response = await api.put('/api/profile/', payload);
    setProfile(response.data);
    setSummary((prev) => ({ ...prev, monthly_budget: Number(response.data.monthly_budget || 0) }));
    notify('Profile updated');
    return response.data;
  }, [notify]);

  const value = useMemo(() => ({
    profile, accounts, transactions, transactionPaging, summary, loading, refreshing, error,
    toast, setToast, notify, refresh: () => loadAll({ silent: true }), loadMoreTransactions,
    createTransaction, updateTransaction, deleteTransaction, createAccount, updateProfile,
  }), [profile, accounts, transactions, transactionPaging, summary, loading, refreshing, error, toast, notify, loadAll, loadMoreTransactions, createTransaction, updateTransaction, deleteTransaction, createAccount, updateProfile]);

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance() {
  const value = useContext(FinanceContext);
  if (!value) throw new Error('useFinance must be used inside FinanceProvider');
  return value;
}
