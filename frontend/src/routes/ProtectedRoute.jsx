import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({children}){const {isAuthenticated,loading}=useAuth();const location=useLocation();if(loading)return <div className="boot-screen"><div className="boot-mark"/>Loading your workspace…</div>;if(!isAuthenticated)return <Navigate to="/login" replace state={{from:location.pathname}}/>;return children}
