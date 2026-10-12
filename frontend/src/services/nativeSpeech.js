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


export async function startBackgroundWake(assistantName = 'Nova') {
  if (!isNativeAndroid()) throw new Error('BACKGROUND_WAKE_REQUIRES_NATIVE_ANDROID');
  return NativeSpeech.startWakeMode({ assistantName });
}

export async function stopBackgroundWake() {
  if (!isNativeAndroid()) return { running: false };
  return NativeSpeech.stopWakeMode();
}

export async function getBackgroundWakeStatus() {
  if (!isNativeAndroid()) return { running: false, wakePhrase: null };
  return NativeSpeech.getWakeStatus();
}
