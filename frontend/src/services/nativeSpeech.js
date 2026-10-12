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
