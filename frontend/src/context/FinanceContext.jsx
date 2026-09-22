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

export function FinanceProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(emptySummary);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, type = 'success') => {
    setToast({ message, type, id: Date.now() });
  }, []);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    silent ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      await Promise.allSettled([
        api.post('/api/v3/recurring/process/'),
        api.post('/api/v3/notifications/sync/'),
      ]);
      const [profileRes, accountsRes, txRes, summaryRes] = await Promise.all([
        api.get('/api/profile/'),
        api.get('/api/accounts/'),
        api.get('/api/expenses/'),
        api.get('/api/dashboard/'),
      ]);
      setProfile(profileRes.data);
      setAccounts(Array.isArray(accountsRes.data) ? accountsRes.data : []);
      setTransactions(Array.isArray(txRes.data) ? txRes.data : []);
      setSummary({ ...emptySummary, ...(summaryRes.data || {}) });
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
    await loadAll({ silent: true });
    notify('Transaction saved');
    return response.data;
  }, [loadAll, notify]);

  const updateTransaction = useCallback(async (id, payload) => {
    const response = await api.patch(`/api/expenses/${id}/`, payload);
    await loadAll({ silent: true });
    notify('Transaction updated');
    return response.data;
  }, [loadAll, notify]);

  const deleteTransaction = useCallback(async (id) => {
    await api.delete(`/api/expenses/${id}/`);
    await loadAll({ silent: true });
    notify('Transaction deleted');
  }, [loadAll, notify]);

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
    profile, accounts, transactions, summary, loading, refreshing, error,
    toast, setToast, notify, refresh: () => loadAll({ silent: true }),
    createTransaction, updateTransaction, deleteTransaction, createAccount, updateProfile,
  }), [profile, accounts, transactions, summary, loading, refreshing, error, toast, notify, loadAll, createTransaction, updateTransaction, deleteTransaction, createAccount, updateProfile]);

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>;
}

export function useFinance() {
  const value = useContext(FinanceContext);
  if (!value) throw new Error('useFinance must be used inside FinanceProvider');
  return value;
}
