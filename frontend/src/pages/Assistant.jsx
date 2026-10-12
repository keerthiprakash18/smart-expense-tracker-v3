import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Mic,
  MicOff,
  Send,
  Settings2,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import api from '../services/api';
import { useFinance } from '../context/FinanceContext';
import { PageHeader, Surface, money } from '../components/Ui';

const defaultSettings = {
  assistant_name: 'Nova',
  language: 'AUTO',
  voice_responses: true,
  personality: 'FRIENDLY',
  confirmation_mode: 'SMART',
  quick_add: false,
};

const suggestions = [
  'Petrol ku 500 spend panniten',
  'இந்த மாதம் foodக்கு எவ்வளவு செலவு?',
  'Salary 35k credit aachu',
  'Last month oda compare pannu',
];

function uid() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const n = Math.random() * 16 | 0;
    const value = char === 'x' ? n : (n & 0x3 | 0x8);
    return value.toString(16);
  });
}

function readError(error, fallback = 'Unable to complete that request.') {
  return error?.response?.data?.error || error?.response?.data?.detail || error?.message || fallback;
}

function CommandCard({ command, symbol, busy, onConfirm, onCancel }) {
  const payload = command?.payload || {};
  const amount = payload.amount || payload.corrected_amount;
  const isMutation = ['CREATE_EXPENSE', 'CREATE_INCOME', 'UPDATE_TRANSACTION', 'DELETE_TRANSACTION'].includes(command?.intent);
  if (!isMutation || command?.status !== 'PENDING') return null;

  return (
    <div className="assistant-command-card">
      <div className="assistant-command-top">
        <span>{command.intent === 'DELETE_TRANSACTION' ? 'DELETE REQUEST' : command.intent === 'UPDATE_TRANSACTION' ? 'UPDATE REQUEST' : 'TRANSACTION PREVIEW'}</span>
        <em>{Math.round(Number(command.confidence || 0) * 100)}% understood</em>
      </div>
      <div className="assistant-command-main">
        <div>
          <small>{payload.title || payload.category || 'Transaction'}</small>
          <strong>{amount ? money(Number(amount), symbol) : '—'}</strong>
        </div>
        <div className="assistant-command-meta">
          {payload.category && <span>{payload.category}</span>}
          {payload.date && <span>{payload.date}</span>}
          {payload.transaction_type && <span>{payload.transaction_type}</span>}
        </div>
      </div>
      <div className="assistant-command-actions">
        <button type="button" className="button ghost" disabled={busy} onClick={() => onCancel(command)}>
          <X size={16}/> Cancel
        </button>
        <button type="button" className="button primary" disabled={busy} onClick={() => onConfirm(command)}>
          <Check size={16}/> Confirm
        </button>
      </div>
    </div>
  );
}

export default function Assistant() {
  const { profile, refresh } = useFinance();
  const [settings, setSettings] = useState(defaultSettings);
  const [settingsDraft, setSettingsDraft] = useState(defaultSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [booting, setBooting] = useState(true);
  const recognitionRef = useRef(null);
  const bottomRef = useRef(null);
  const symbol = profile?.currency || '₹';

  const SpeechRecognition = useMemo(
    () => window.SpeechRecognition || window.webkitSpeechRecognition || null,
    []
  );
  const speechSupported = Boolean(SpeechRecognition);

  const speak = (text, currentSettings = settings) => {
    if (!currentSettings.voice_responses || !('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    if (currentSettings.language === 'TA' || /[\u0B80-\u0BFF]/.test(text)) utterance.lang = 'ta-IN';
    else utterance.lang = 'en-IN';
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    let live = true;
    Promise.all([
      api.get('/api/v3/assistant/settings/'),
      api.get('/api/v3/assistant/history/').catch(() => ({ data: { results: [] } })),
    ])
      .then(([settingsRes, historyRes]) => {
        if (!live) return;
        const next = { ...defaultSettings, ...(settingsRes.data || {}) };
        setSettings(next);
        setSettingsDraft(next);
        const recent = Array.isArray(historyRes.data?.results) ? historyRes.data.results.slice(0, 4).reverse() : [];
        const restored = recent
          .filter((item) => item?.message)
          .map((item) => ({ id: `history-${item.id}`, role: 'assistant', text: item.message, command: item, historical: true }));
        setMessages(restored);
      })
      .catch(() => {
        if (live) setMessages([{ id: 'boot-error', role: 'assistant', text: 'Assistant settings could not be loaded. You can still retry from this page.', error: true }]);
      })
      .finally(() => { if (live) setBooting(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, interim, busy]);

  useEffect(() => () => {
    try { recognitionRef.current?.abort(); } catch {}
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const pushAssistant = (command, currentSettings = settings) => {
    const text = command?.message || 'Done.';
    setMessages((prev) => [...prev, { id: `a-${Date.now()}-${Math.random()}`, role: 'assistant', text, command }]);
    speak(text, currentSettings);
  };

  const sendMessage = async (rawText) => {
    const text = String(rawText ?? draft).trim();
    if (!text || busy) return;
    setDraft('');
    setInterim('');
    setVoiceError('');
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', text }]);
    setBusy(true);
    try {
      const response = await api.post('/api/v3/assistant/message/', {
        message: text,
        client_request_id: uid(),
      });
      const command = response.data;
      pushAssistant(command);
      if (command?.status === 'COMPLETED' && ['CREATE_EXPENSE', 'CREATE_INCOME', 'UPDATE_TRANSACTION', 'DELETE_TRANSACTION'].includes(command.intent)) {
        await refresh();
      }
    } catch (error) {
      const textError = readError(error);
      setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: 'assistant', text: textError, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const confirmCommand = async (command) => {
    if (!command?.id || busy) return;
    setBusy(true);
    try {
      const response = await api.post(`/api/v3/assistant/commands/${command.id}/confirm/`, {});
      const next = response.data;
      setMessages((prev) => prev.map((message) => message.command?.id === command.id ? { ...message, text: next.message, command: next } : message));
      speak(next.message);
      await refresh();
    } catch (error) {
      setMessages((prev) => [...prev, { id: `confirm-error-${Date.now()}`, role: 'assistant', text: readError(error, 'I could not safely confirm that action.'), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const cancelCommand = async (command) => {
    if (!command?.id || busy) return;
    setBusy(true);
    try {
      const response = await api.post(`/api/v3/assistant/commands/${command.id}/cancel/`, {});
      const next = response.data;
      setMessages((prev) => prev.map((message) => message.command?.id === command.id ? { ...message, text: next.message, command: next } : message));
    } catch (error) {
      setMessages((prev) => [...prev, { id: `cancel-error-${Date.now()}`, role: 'assistant', text: readError(error), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const stopListening = () => {
    try { recognitionRef.current?.stop(); } catch {}
    setListening(false);
  };

  const startListening = () => {
    if (!speechSupported) {
      setVoiceError('Voice recognition is not available in this browser. Type your request below.');
      return;
    }
    if (listening) {
      stopListening();
      return;
    }

    setVoiceError('');
    setInterim('');
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = settings.language === 'TA' ? 'ta-IN' : 'en-IN';

    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      let finalText = '';
      let temporary = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) finalText += transcript;
        else temporary += transcript;
      }
      setInterim(temporary);
      if (finalText.trim()) {
        setInterim('');
        setListening(false);
        sendMessage(finalText);
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      setInterim('');
      const map = {
        'not-allowed': 'Microphone access is blocked. Allow microphone permission or type your request.',
        'no-speech': 'I did not hear anything. Tap the mic and try again.',
        'audio-capture': 'No microphone is available on this device.',
        'network': 'Voice recognition needs a network connection right now.',
      };
      setVoiceError(map[event.error] || 'Voice recognition stopped. You can retry or type your request.');
    };
    recognition.onend = () => setListening(false);

    try { recognition.start(); }
    catch { setVoiceError('Voice recognition could not start. Try again or use text input.'); }
  };

  const saveSettings = async () => {
    if (savingSettings) return;
    setSavingSettings(true);
    try {
      const response = await api.patch('/api/v3/assistant/settings/', {
        assistant_name: settingsDraft.assistant_name,
        language: settingsDraft.language,
        voice_responses: Boolean(settingsDraft.voice_responses),
        personality: settingsDraft.personality,
        confirmation_mode: settingsDraft.confirmation_mode,
        quick_add: Boolean(settingsDraft.quick_add),
      });
      const next = { ...defaultSettings, ...response.data };
      setSettings(next);
      setSettingsDraft(next);
      setSettingsOpen(false);
      setMessages((prev) => [...prev, { id: `settings-${Date.now()}`, role: 'assistant', text: `Settings saved. You can call me ${next.assistant_name}.` }]);
    } catch (error) {
      setVoiceError(readError(error, 'Unable to save assistant settings.'));
    } finally {
      setSavingSettings(false);
    }
  };

  const hasLiveMessages = messages.some((item) => !item.historical);

  return (
    <div className="page-stack assistant-page">
      <PageHeader
        eyebrow="AI FINANCE ASSISTANT"
        title={settings.assistant_name}
        description="Speak or type naturally in English, Tamil or Tanglish. Financial writes stay behind validation and confirmation."
        actions={
          <button type="button" className="button ghost" onClick={() => setSettingsOpen((value) => !value)}>
            <Settings2 size={17}/> Configure
          </button>
        }
      />

      {settingsOpen && (
        <Surface className="assistant-settings-panel">
          <div className="section-heading">
            <div><span>PERSONALISE</span><h2>Your assistant</h2></div>
            <button type="button" className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close assistant settings"><X size={17}/></button>
          </div>
          <div className="assistant-settings-grid">
            <label>
              <span>Assistant name</span>
              <input value={settingsDraft.assistant_name} maxLength={40} onChange={(event) => setSettingsDraft((prev) => ({ ...prev, assistant_name: event.target.value }))}/>
            </label>
            <label>
              <span>Language</span>
              <div className="select-wrap">
                <select value={settingsDraft.language} onChange={(event) => setSettingsDraft((prev) => ({ ...prev, language: event.target.value }))}>
                  <option value="AUTO">Auto · English + Tamil</option>
                  <option value="EN">English</option>
                  <option value="TA">தமிழ்</option>
                </select>
                <ChevronDown size={15}/>
              </div>
            </label>
            <label>
              <span>Personality</span>
              <div className="select-wrap">
                <select value={settingsDraft.personality} onChange={(event) => setSettingsDraft((prev) => ({ ...prev, personality: event.target.value }))}>
                  <option value="FRIENDLY">Friendly</option>
                  <option value="PROFESSIONAL">Professional</option>
                  <option value="MINIMAL">Minimal</option>
                </select>
                <ChevronDown size={15}/>
              </div>
            </label>
            <label>
              <span>Confirmation</span>
              <div className="select-wrap">
                <select value={settingsDraft.confirmation_mode} onChange={(event) => setSettingsDraft((prev) => ({ ...prev, confirmation_mode: event.target.value }))}>
                  <option value="SMART">Smart confirmation</option>
                  <option value="ALWAYS">Always confirm</option>
                </select>
                <ChevronDown size={15}/>
              </div>
            </label>
          </div>
          <div className="assistant-toggle-row">
            <button type="button" className={`assistant-toggle ${settingsDraft.voice_responses ? 'active' : ''}`} onClick={() => setSettingsDraft((prev) => ({ ...prev, voice_responses: !prev.voice_responses }))}>
              {settingsDraft.voice_responses ? <Volume2 size={18}/> : <VolumeX size={18}/>}
              <span><strong>Voice replies</strong><small>Speak successful results and questions</small></span>
              <i/>
            </button>
            <button type="button" className={`assistant-toggle ${settingsDraft.quick_add ? 'active' : ''}`} onClick={() => setSettingsDraft((prev) => ({ ...prev, quick_add: !prev.quick_add }))}>
              <Sparkles size={18}/>
              <span><strong>Quick Add</strong><small>Auto-save high-confidence low-value entries</small></span>
              <i/>
            </button>
          </div>
          <div className="assistant-settings-actions">
            <button type="button" className="button primary" onClick={saveSettings} disabled={savingSettings || !settingsDraft.assistant_name.trim()}>
              {savingSettings ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </Surface>
      )}

      <Surface className="assistant-console">
        <div className="assistant-hero">
          <div className={`assistant-orb ${listening ? 'listening' : busy ? 'thinking' : ''}`} aria-hidden="true">
            <span/><i/><b/>
            {listening ? <Mic size={30}/> : busy ? <Sparkles size={30}/> : <Sparkles size={30}/>}
          </div>
          <div>
            <span className="assistant-state">
              {listening ? 'LISTENING' : busy ? 'UNDERSTANDING' : booting ? 'CONNECTING' : 'READY'}
            </span>
            <h2>{listening ? 'Speak naturally' : `Ask ${settings.assistant_name}`}</h2>
            <p>{listening ? (interim || 'Tamil, English and Tanglish commands are supported.') : 'Your finance data is calculated by the backend — the assistant never invents totals.'}</p>
          </div>
        </div>

        {!hasLiveMessages && (
          <div className="assistant-suggestions" aria-label="Suggested assistant prompts">
            {suggestions.map((item) => <button key={item} type="button" onClick={() => sendMessage(item)} disabled={busy}>{item}</button>)}
          </div>
        )}

        <div className="assistant-thread" aria-live="polite">
          {messages.map((message) => (
            <div key={message.id} className={`assistant-message ${message.role} ${message.error ? 'error' : ''} ${message.historical ? 'historical' : ''}`}>
              <div className="assistant-message-avatar">{message.role === 'user' ? (profile?.name || profile?.username || 'U').slice(0,1).toUpperCase() : <Sparkles size={15}/>}</div>
              <div className="assistant-message-body">
                <span>{message.role === 'user' ? 'You' : settings.assistant_name}</span>
                <p>{message.text}</p>
                {message.command?.result && Object.keys(message.command.result).length > 0 && message.command.status === 'COMPLETED' && (
                  <div className="assistant-result-pill">
                    <Check size={14}/> Verified backend result
                  </div>
                )}
                <CommandCard command={message.command} symbol={symbol} busy={busy} onConfirm={confirmCommand} onCancel={cancelCommand}/>
              </div>
            </div>
          ))}
          {busy && (
            <div className="assistant-message assistant">
              <div className="assistant-message-avatar"><Sparkles size={15}/></div>
              <div className="assistant-message-body"><span>{settings.assistant_name}</span><div className="assistant-typing"><i/><i/><i/></div></div>
            </div>
          )}
          <div ref={bottomRef}/>
        </div>

        {voiceError && <div className="assistant-voice-error"><MicOff size={15}/><span>{voiceError}</span></div>}

        <div className={`assistant-composer ${listening ? 'is-listening' : ''}`}>
          <button
            type="button"
            className="assistant-mic"
            onClick={startListening}
            disabled={busy}
            aria-label={listening ? 'Stop listening' : 'Start voice input'}
            title={speechSupported ? 'Push to talk' : 'Voice recognition unavailable'}
          >
            {listening ? <Square size={18}/> : <Mic size={20}/>}
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            }}
            rows={1}
            maxLength={600}
            disabled={busy || listening}
            placeholder={listening ? 'Listening…' : `Ask ${settings.assistant_name} about your money…`}
            aria-label="Assistant message"
          />
          <button type="button" className="assistant-send" onClick={() => sendMessage()} disabled={busy || listening || !draft.trim()} aria-label="Send assistant message">
            <Send size={18}/>
          </button>
        </div>
        <div className="assistant-privacy-note">
          <span className="privacy-dot"/>
          Push-to-talk only. Raw microphone audio is not stored by Smart Expense.
        </div>
      </Surface>
    </div>
  );
}
