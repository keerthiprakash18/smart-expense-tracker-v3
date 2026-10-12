package com.keerthi.expensetracker;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.Locale;

@CapacitorPlugin(
    name = "NativeSpeech",
    permissions = {
        @Permission(alias = "microphone", strings = {Manifest.permission.RECORD_AUDIO})
    }
)
public class NativeSpeechPlugin extends Plugin {
    private SpeechRecognizer recognizer;
    private PluginCall activeCall;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphonePermissionCallback");
            return;
        }
        beginListening(call);
    }

    @PermissionCallback
    private void microphonePermissionCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            beginListening(call);
        } else {
            call.reject("MICROPHONE_PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) {
                recognizer.stopListening();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (recognizer != null) {
                recognizer.cancel();
            }
            rejectActive("LISTENING_CANCELLED");
            destroyRecognizer();
            call.resolve();
        });
    }

    private void beginListening(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("SPEECH_RECOGNITION_UNAVAILABLE");
                return;
            }

            rejectActive("LISTENING_REPLACED");
            destroyRecognizer();
            activeCall = call;
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                @Override
                public void onReadyForSpeech(Bundle params) {
                    emitState("listening");
                }

                @Override
                public void onBeginningOfSpeech() {
                    emitState("speech");
                }

                @Override
                public void onRmsChanged(float rmsdB) {
                    JSObject data = new JSObject();
                    data.put("rms", rmsdB);
                    notifyListeners("volume", data);
                }

                @Override
                public void onBufferReceived(byte[] buffer) {}

                @Override
                public void onEndOfSpeech() {
                    emitState("processing");
                }

                @Override
                public void onError(int error) {
                    String code = mapError(error);
                    PluginCall callToReject = activeCall;
                    activeCall = null;
                    destroyRecognizer();
                    emitState("idle");
                    if (callToReject != null) {
                        callToReject.reject(code);
                    }
                }

                @Override
                public void onResults(Bundle results) {
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    float confidence = 0f;
                    float[] scores = results.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                    if (scores != null && scores.length > 0) {
                        confidence = scores[0];
                    }

                    PluginCall callToResolve = activeCall;
                    activeCall = null;
                    destroyRecognizer();
                    emitState("idle");

                    if (callToResolve == null) {
                        return;
                    }
                    if (matches == null || matches.isEmpty() || matches.get(0).trim().isEmpty()) {
                        callToResolve.reject("NO_SPEECH");
                        return;
                    }

                    JSObject data = new JSObject();
                    data.put("text", matches.get(0).trim());
                    data.put("confidence", confidence);
                    callToResolve.resolve(data);
                }

                @Override
                public void onPartialResults(Bundle partialResults) {
                    ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (matches != null && !matches.isEmpty()) {
                        JSObject data = new JSObject();
                        data.put("text", matches.get(0));
                        notifyListeners("partialResult", data);
                    }
                }

                @Override
                public void onEvent(int eventType, Bundle params) {}
            });

            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());

            String language = call.getString("language");
            if ("TA".equalsIgnoreCase(language)) {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ta-IN");
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "ta-IN");
            } else if ("EN".equalsIgnoreCase(language)) {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN");
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-IN");
            } else {
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag());
            }

            try {
                emitState("starting");
                recognizer.startListening(intent);
            } catch (Exception exception) {
                PluginCall callToReject = activeCall;
                activeCall = null;
                destroyRecognizer();
                emitState("idle");
                if (callToReject != null) {
                    callToReject.reject("SPEECH_RECOGNITION_START_FAILED");
                }
            }
        });
    }

    private void emitState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        notifyListeners("stateChange", data);
    }

    private void rejectActive(String code) {
        PluginCall call = activeCall;
        activeCall = null;
        if (call != null) {
            call.reject(code);
        }
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
    }

    private String mapError(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO:
                return "AUDIO_CAPTURE_ERROR";
            case SpeechRecognizer.ERROR_CLIENT:
                return "SPEECH_CLIENT_ERROR";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "MICROPHONE_PERMISSION_DENIED";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "NETWORK_ERROR";
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "NO_SPEECH";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "RECOGNIZER_BUSY";
            case SpeechRecognizer.ERROR_SERVER:
                return "SPEECH_SERVICE_ERROR";
            default:
                return "SPEECH_RECOGNITION_ERROR";
        }
    }
}
