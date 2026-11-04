import React from 'react';
import { createRoot } from 'react-dom/client';
import BankStatements from '../src/pages/BankStatements.jsx';
import '../src/index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode><BankStatements /></React.StrictMode>
);