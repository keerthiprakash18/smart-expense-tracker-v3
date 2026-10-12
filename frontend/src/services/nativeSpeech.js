import api, { API_BASE_URL } from './api';
import { Capacitor, registerPlugin } from '@capacitor/core';

const NativeSpeech = registerPlugin('NativeSpeech');

export const isNativeAndroid = () => Capacitor.getPlatform() === 'android';

export async function nativeSpeechAvailable() {
  if (!isNativeAndroid()) return false;
  try {
    const result = await NativeSpeech.isAvailable();
    return Boolean(result?.available);
  } catch {
    return false;
  }
}

export async function startNativeSpeech(language = 'AUTO') {
  return NativeSpeech.startListening({ language });
}

export async function stopNativeSpeech() {
  return NativeSpeech.stopListening();
}

export async function cancelNativeSpeech() {
  return NativeSpeech.cancelListening();
}


export async function startBackgroundWake(assistantName = 'Nova', language = 'AUTO') {
  if (!isNativeAndroid()) throw new Error('BACKGROUND_WAKE_REQUIRES_NATIVE_ANDROID');
  const tokenResponse = await api.post('/api/v3/assistant/wake-token/', {});
  const wakeToken = tokenResponse?.data?.token;
  if (!wakeToken) throw new Error('WAKE_SESSION_TOKEN_MISSING');
  return NativeSpeech.startWakeMode({
    assistantName,
    language,
    wakeToken,
    apiBaseUrl: API_BASE_URL || 'https://smart-expense-tracker-v3-production.up.railway.app',
  });
}

export async function stopBackgroundWake() {
  if (!isNativeAndroid()) return { running: false };
  const result = await NativeSpeech.stopWakeMode().catch(() => ({ running: false }));
  await api.delete('/api/v3/assistant/wake-token/').catch(() => {});
  return result;
}

export async function getBackgroundWakeStatus() {
  if (!isNativeAndroid()) return { running: false, wakePhrase: null };
  return NativeSpeech.getWakeStatus();
}
