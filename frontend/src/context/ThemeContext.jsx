import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

export const THEMES = [
  { id: 'midnight', name: 'Midnight', accent: '#49b9ff', swatch: 'linear-gradient(135deg,#071019,#0d2230)' },
  { id: 'ocean', name: 'Ocean', accent: '#5d8cff', swatch: 'linear-gradient(135deg,#081124,#12295f)' },
  { id: 'emerald', name: 'Emerald', accent: '#36d69b', swatch: 'linear-gradient(135deg,#071410,#12362a)' },
  { id: 'gold', name: 'Gold', accent: '#e5b95c', swatch: 'linear-gradient(135deg,#12100a,#382b12)' },
];

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('smart_expense_theme') || 'midnight');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('smart_expense_theme', theme);
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme, themes: THEMES }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
