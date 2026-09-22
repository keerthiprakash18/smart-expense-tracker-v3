import React from 'react';
import { Link } from 'react-router-dom';
import logoFull from '../assets/logo-full.png';

const sections = {
  privacy: {
    eyebrow: 'PRIVACY',
    title: 'Privacy Policy',
    intro: 'Smart Expense Tracker stores only the information needed to provide your personal finance workspace.',
    items: [
      ['Data we process', 'Profile details you submit, accounts you create, transactions, budgets, goals, optional receipt images/OCR data, notifications and security settings.'],
      ['How it is used', 'To provide expense tracking, analytics, receipt scanning, backups, reminders and account security.'],
      ['Security', 'Production traffic uses HTTPS, API access is authenticated and user-scoped, sensitive endpoints are rate-limited, and optional authenticator 2FA is available.'],
      ['Sharing', 'The app does not sell your personal finance data. Hosting/storage providers process data only as required to operate the service.'],
      ['Retention & deletion', 'You can export your data and permanently delete your account from Profile & Settings. Deletion removes app records associated with the account.'],
      ['Your responsibility', 'Do not upload documents or data you do not have permission to store. Keep your password, authenticator and recovery codes private.'],
    ],
  },
  terms: {
    eyebrow: 'TERMS',
    title: 'Terms of Use',
    intro: 'Smart Expense Tracker is a personal record-keeping tool and is not a bank, payment service, accountant or financial adviser.',
    items: [
      ['Use of the service', 'Use the app only for lawful personal finance tracking and do not attempt to disrupt, abuse or bypass its security controls.'],
      ['Accuracy', 'OCR and automated insights can be imperfect. Review scanned amounts, dates and categories before relying on them.'],
      ['Financial decisions', 'App summaries and insights are informational only. You remain responsible for financial, tax and payment decisions.'],
      ['Account security', 'Use a strong password, enable 2FA when appropriate, and store recovery codes securely.'],
      ['Availability', 'The service may change or be temporarily unavailable for maintenance, hosting incidents or security work.'],
      ['Account deletion', 'You may permanently delete your account and associated app data from Profile & Settings.'],
    ],
  },
};

export default function Legal({type='privacy'}){
  const page=sections[type]||sections.privacy;
  return <main className="legal-page">
    <div className="legal-shell">
      <Link className="legal-brand" to="/"><img src={logoFull} alt="Smart Expense Tracker"/></Link>
      <span className="micro-label">{page.eyebrow}</span>
      <h1>{page.title}</h1>
      <p className="legal-intro">{page.intro}</p>
      <p className="legal-date">Effective: 22 September 2026</p>
      <div className="legal-sections">{page.items.map(([title,body])=><section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div>
      <div className="legal-links"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/login">Sign in</Link></div>
    </div>
  </main>
}
