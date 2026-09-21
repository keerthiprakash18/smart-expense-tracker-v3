import React, { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from '../components/AppShell';
import { FinanceProvider } from '../context/FinanceContext';
import ProtectedRoute from './ProtectedRoute';

const Login = lazy(() => import('../pages/Login'));
const Register = lazy(() => import('../pages/Register'));
const Overview = lazy(() => import('../pages/Overview'));
const Transactions = lazy(() => import('../pages/Transactions'));
const TransactionEditor = lazy(() => import('../pages/TransactionEditor'));
const Analytics = lazy(() => import('../pages/Analytics'));
const MoneyHub = lazy(() => import('../pages/MoneyHub'));
const Profile = lazy(() => import('../pages/Profile'));
const Planner = lazy(() => import('../pages/Planner'));
const ReceiptVault = lazy(() => import('../pages/ReceiptVault'));
const Notifications = lazy(() => import('../pages/Notifications'));

function RouteLoader() {
  return <div className="boot-screen"><div className="boot-mark" />Loading Smart Expense…</div>;
}

function ProtectedApp() {
  return (
    <ProtectedRoute>
      <FinanceProvider>
        <AppShell />
      </FinanceProvider>
    </ProtectedRoute>
  );
}

export default function AppRouter() {
  return (
    <Suspense fallback={<RouteLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route element={<ProtectedApp />}>
          <Route index element={<Overview />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="transactions/:id/edit" element={<TransactionEditor />} />
          <Route path="add" element={<TransactionEditor />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="money" element={<MoneyHub />} />
          <Route path="planner" element={<Planner />} />
          <Route path="receipts" element={<ReceiptVault />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="profile" element={<Profile />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
