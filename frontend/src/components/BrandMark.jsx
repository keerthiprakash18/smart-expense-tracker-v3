import React from 'react';

export default function BrandMark({ compact = false, showText = true, className = '' }) {
  return (
    <span className={`brand-lockup-component ${compact ? 'compact' : ''} ${className}`.trim()}>
      <img className="brand-icon" src="/app-logo.svg" alt="Smart Expense Tracker" />
      {showText && (
        <span className="brand-wordmark">
          <strong>Smart</strong>
          <span>Expense Tracker</span>
        </span>
      )}
    </span>
  );
}
