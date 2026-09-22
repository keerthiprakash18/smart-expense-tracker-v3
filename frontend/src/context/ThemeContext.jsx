import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const ThemeContext = createContext(null);

export const THEMES = [
  { id: 'obsidian', name: 'Obsidian', mode: 'dark', accent: '#54c7ff', swatch: 'linear-gradient(135deg,#03070b,#0a1722 58%,#0e2b3d)' },
  { id: 'pearl', name: 'Pearl', mode: 'light', accent: '#1687ff', swatch: 'linear-gradient(135deg,#ffffff,#eef6ff 58%,#dfeeff)' },
  { id: 'midnight', name: 'Midnight', mode: 'dark', accent: '#49b9ff', swatch: 'linear-gradient(135deg,#071019,#0d2230)' },
  { id: 'ocean', name: 'Ocean', mode: 'dark', accent: '#6b8cff', swatch: 'linear-gradient(135deg,#081124,#12295f)' },
  { id: 'emerald', name: 'Emerald', mode: 'dark', accent: '#36d69b', swatch: 'linear-gradient(135deg,#071410,#12362a)' },
  { id: 'gold', name: 'Gold', mode: 'dark', accent: '#e5b95c', swatch: 'linear-gradient(135deg,#12100a,#382b12)' },
];

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('smart_expense_theme');
    return THEMES.some((item) => item.id === saved) ? saved : 'obsidian';
  });

  const selected = THEMES.find((item) => item.id === theme) || THEMES[0];
  const isLight = selected.mode === 'light';

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.mode = selected.mode;
    document.documentElement.style.colorScheme = selected.mode;
    localStorage.setItem('smart_expense_theme', theme);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLight ? '#f5f9ff' : '#05090d');
  }, [theme, selected.mode, isLight]);

  const toggleMode = () => setTheme(isLight ? 'obsidian' : 'pearl');

  const value = useMemo(
    () => ({ theme, setTheme, themes: THEMES, selectedTheme: selected, isLight, toggleMode }),
    [theme, selected, isLight]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
