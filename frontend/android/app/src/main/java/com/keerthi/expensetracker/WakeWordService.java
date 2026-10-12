package com.keerthi.expensetracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.SpeechService;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class WakeWordService extends Service implements TextToSpeech.OnInitListener {
    public static final String ACTION_START = "com.keerthi.expensetracker.action.START_WAKE";
    public static final String ACTION_STOP = "com.keerthi.expensetracker.action.STOP_WAKE";

    public static final String EXTRA_ASSISTANT_NAME = "assistant_name";
    public static final String EXTRA_LANGUAGE = "language";
    public static final String EXTRA_WAKE_TOKEN = "wake_token";
    public static final String EXTRA_API_BASE_URL = "api_base_url";
    public static final String EXTRA_MODEL_PATH = "model_path";

    private static final String CHANNEL_LISTENING = "assistant_wake_listening";
    private static final String CHANNEL_ALERT = "assistant_wake_alert";
    private static final int LISTENING_NOTIFICATION_ID = 4101;
    private static final int WAKE_NOTIFICATION_ID = 4102;
    private static final float WAKE_SAMPLE_RATE = 16000.0f;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private Model wakeModel;
    private Recognizer wakeRecognizer;
    private SpeechService wakeSpeechService;
    private SpeechRecognizer commandRecognizer;
    private TextToSpeech tts;

    private String assistantName = "Nova";
    private String language = "AUTO";
    private String wakeToken = "";
    private String apiBaseUrl = "";
    private String modelPath = "";
    private String wakePhrase = "hey nova";

    private boolean stopping = false;
    private boolean sessionBusy = false;
    private boolean loadingWakeModel = false;
    private boolean ttsReady = false;
    private Runnable afterSpeech;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        tts = new TextToSpeech(this, this);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                handler.post(WakeWordService.this::runAfterSpeech);
            }

            @Override
            public void onError(String utteranceId) {
                handler.post(WakeWordService.this::runAfterSpeech);
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopWakeService();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            assistantName = valueOrDefault(intent.getStringExtra(EXTRA_ASSISTANT_NAME), "Nova");
            language = valueOrDefault(intent.getStringExtra(EXTRA_LANGUAGE), "AUTO");
            wakeToken = valueOrDefault(intent.getStringExtra(EXTRA_WAKE_TOKEN), "");
            apiBaseUrl = trimTrailingSlash(valueOrDefault(intent.getStringExtra(EXTRA_API_BASE_URL), ""));
            modelPath = valueOrDefault(intent.getStringExtra(EXTRA_MODEL_PATH), "");
        }

        String normalizedName = normalize(assistantName);
        if (normalizedName.isEmpty()) normalizedName = "nova";
        wakePhrase = "hey " + normalizedName;
        stopping = false;
        sessionBusy = false;

        Notification notification = buildListeningNotification("Starting offline wake engine…");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                LISTENING_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            );
        } else {
            startForeground(LISTENING_NOTIFICATION_ID, notification);
        }

        getSharedPreferences("assistant_wake", MODE_PRIVATE)
            .edit()
            .putBoolean("running", true)
            .putString("assistant_name", assistantName)
            .putString("engine", "vosk")
            .apply();

        handler.post(this::startWakeEngine);
        return START_NOT_STICKY;
    }

    private void startWakeEngine() {
        if (stopping || sessionBusy || wakeSpeechService != null || loadingWakeModel) return;

        File modelDirectory = new File(modelPath);
        if (modelPath.isEmpty() || !new File(modelDirectory, "am/final.mdl").isFile()) {
            updateListeningNotification("Wake model unavailable. Open AI settings to repair.");
            showActionNotification(
                assistantName + " Wake Mode needs setup",
                "Open AI Assistant and enable Background Wake Mode again.",
                null
            );
            return;
        }

        if (wakeModel == null) {
            loadingWakeModel = true;
            updateListeningNotification("Loading offline wake model…");
            worker.execute(() -> {
                try {
                    Model loaded = new Model(modelPath);
                    handler.post(() -> {
                        loadingWakeModel = false;
                        if (stopping) {
                            try { loaded.close(); } catch (Exception ignored) {}
                            return;
                        }
                        wakeModel = loaded;
                        startVoskListening();
                    });
                } catch (Exception error) {
                    handler.post(() -> {
                        loadingWakeModel = false;
                        updateListeningNotification("Offline wake engine failed to load.");
                        showActionNotification(
                            assistantName + " Wake Mode error",
                            "Tap to reopen AI Assistant and retry.",
                            null
                        );
                    });
                }
            });
            return;
        }

        startVoskListening();
    }

    private void startVoskListening() {
        if (stopping || sessionBusy || wakeModel == null || wakeSpeechService != null) return;

        try {
            JSONArray grammar = new JSONArray();
            grammar.put(wakePhrase);
            grammar.put(normalize(assistantName));
            grammar.put("[unk]");

            wakeRecognizer = new Recognizer(wakeModel, WAKE_SAMPLE_RATE, grammar.toString());
            wakeSpeechService = new SpeechService(wakeRecognizer, WAKE_SAMPLE_RATE);

            boolean started = wakeSpeechService.startListening(new org.vosk.android.RecognitionListener() {
                @Override
                public void onPartialResult(String hypothesis) {
                    if (matchesWake(hypothesis)) onWakeDetected();
                }

                @Override
                public void onResult(String hypothesis) {
                    if (matchesWake(hypothesis)) onWakeDetected();
                }

                @Override
                public void onFinalResult(String hypothesis) {
                    if (matchesWake(hypothesis)) {
                        onWakeDetected();
                    } else if (!stopping && !sessionBusy) {
                        stopWakeEngineAudio();
                        handler.postDelayed(WakeWordService.this::startWakeEngine, 120);
                    }
                }

                @Override
                public void onError(Exception exception) {
                    stopWakeEngineAudio();
                    if (!stopping && !sessionBusy) {
                        updateListeningNotification("Restarting offline wake engine…");
                        handler.postDelayed(WakeWordService.this::startWakeEngine, 800);
                    }
                }

                @Override
                public void onTimeout() {
                    stopWakeEngineAudio();
                    if (!stopping && !sessionBusy) {
                        handler.postDelayed(WakeWordService.this::startWakeEngine, 120);
                    }
                }
            });

            if (!started) {
                stopWakeEngineAudio();
                handler.postDelayed(this::startWakeEngine, 600);
                return;
            }
            updateListeningNotification("Offline · Listening for \"Hey " + assistantName + "\"");
        } catch (Exception error) {
            stopWakeEngineAudio();
            updateListeningNotification("Wake phrase could not start. Retrying…");
            if (!stopping) handler.postDelayed(this::startWakeEngine, 1200);
        }
    }

    private boolean matchesWake(String jsonHypothesis) {
        try {
            JSONObject value = new JSONObject(jsonHypothesis);
            String text = value.optString("partial", value.optString("text", ""));
            String normalized = normalize(text);
            String normalizedName = normalize(assistantName);
            return normalized.equals(wakePhrase)
                || normalized.contains(wakePhrase)
                || (!normalizedName.isEmpty() && normalized.equals(normalizedName));
        } catch (Exception ignored) {
            return false;
        }
    }

    private void onWakeDetected() {
        if (stopping || sessionBusy) return;
        sessionBusy = true;
        stopWakeEngineAudio();
        updateListeningNotification("Wake detected · waiting for your command");
        speakThen("Yes?", this::listenForCommand);
    }

    private void listenForCommand() {
        listenOnce(transcript -> {
            if (transcript == null || transcript.trim().isEmpty()) {
                speakThen("I didn't hear a command.", this::resumeWakeMode);
                return;
            }
            updateListeningNotification("Understanding: " + shorten(transcript, 44));
            sendWakeMessage(transcript.trim(), 0);
        }, () -> {
            showActionNotification(
                assistantName + " couldn't hear the command",
                "Tap to open the assistant and try again.",
                null
            );
            resumeWakeMode();
        });
    }

    private void sendWakeMessage(String transcript, int clarificationTurn) {
        worker.execute(() -> {
            HttpResult response = postJson(
                "/api/v3/assistant/wake/message/",
                new JSONObject()
                    .put("message", transcript)
                    .put("client_request_id", UUID.randomUUID().toString())
            );
            handler.post(() -> handleAssistantResponse(response, transcript, clarificationTurn));
        });
    }

    private void handleAssistantResponse(HttpResult response, String transcript, int clarificationTurn) {
        if (stopping) return;

        if (response.code == 401) {
            showActionNotification(
                "Wake session needs re-authorization",
                "Command captured: " + shorten(transcript, 70) + ". Tap to reopen Smart Expense.",
                transcript
            );
            speakThen("Open Smart Expense once to re-enable wake mode.", this::resumeWakeMode);
            return;
        }

        if (response.code < 200 || response.code >= 300 || response.body == null) {
            showActionNotification(
                "Command captured but not processed",
                shorten(transcript, 90) + " · Tap to retry in Smart Expense.",
                transcript
            );
            speakThen("I captured that, but I couldn't reach Smart Expense.", this::resumeWakeMode);
            return;
        }

        JSONObject body = response.body;
        String status = body.optString("status", "");
        String message = body.optString("message", "Done.");
        int commandId = body.optInt("id", -1);
        boolean requiresConfirmation = body.optBoolean("requires_confirmation", false);

        if ("COMPLETED".equals(status)) {
            speakThen(message, this::resumeWakeMode);
            return;
        }

        if ("PENDING".equals(status) && requiresConfirmation && commandId > 0) {
            speakThen(message + " Say yes to confirm or no to cancel.", () -> listenForConfirmation(commandId));
            return;
        }

        if ("NEEDS_CLARIFICATION".equals(status) && clarificationTurn < 2) {
            speakThen(message, () -> listenOnce(followUp -> {
                if (followUp == null || followUp.trim().isEmpty()) {
                    resumeWakeMode();
                    return;
                }
                sendWakeMessage(followUp.trim(), clarificationTurn + 1);
            }, this::resumeWakeMode));
            return;
        }

        showActionNotification(
            assistantName + " needs your attention",
            message,
            null
        );
        speakThen(message, this::resumeWakeMode);
    }

    private void listenForConfirmation(int commandId) {
        listenOnce(answer -> {
            String normalized = normalize(answer);
            if (isYes(normalized)) {
                sendWakeDecision(commandId, true);
            } else if (isNo(normalized)) {
                sendWakeDecision(commandId, false);
            } else {
                speakThen("Please say yes or no.", () -> listenOnce(second -> {
                    String secondNormalized = normalize(second);
                    if (isYes(secondNormalized)) sendWakeDecision(commandId, true);
                    else if (isNo(secondNormalized)) sendWakeDecision(commandId, false);
                    else {
                        showActionNotification(
                            assistantName + " is waiting for confirmation",
                            "Tap to review the pending finance action.",
                            null
                        );
                        resumeWakeMode();
                    }
                }, this::resumeWakeMode));
            }
        }, this::resumeWakeMode);
    }

    private void sendWakeDecision(int commandId, boolean confirm) {
        worker.execute(() -> {
            String action = confirm ? "confirm" : "cancel";
            HttpResult response = postJson(
                "/api/v3/assistant/wake/commands/" + commandId + "/" + action + "/",
                new JSONObject()
            );
            handler.post(() -> {
                if (response.code >= 200 && response.code < 300 && response.body != null) {
                    speakThen(response.body.optString("message", confirm ? "Done." : "Cancelled."), this::resumeWakeMode);
                } else {
                    showActionNotification(
                        "Confirmation could not be completed",
                        "Tap to review the pending assistant action.",
                        null
                    );
                    resumeWakeMode();
                }
            });
        });
    }

    private void listenOnce(SpeechResultCallback callback, Runnable failure) {
        destroyCommandRecognizer();
        if (stopping || !SpeechRecognizer.isRecognitionAvailable(this)) {
            failure.run();
            return;
        }

        commandRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        commandRecognizer.setRecognitionListener(new RecognitionListener() {
            private boolean delivered = false;

            @Override public void onReadyForSpeech(Bundle params) {
                updateListeningNotification("Listening to your command…");
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {
                updateListeningNotification("Processing your command…");
            }

            @Override
            public void onError(int error) {
                if (delivered) return;
                delivered = true;
                destroyCommandRecognizer();
                failure.run();
            }

            @Override
            public void onResults(Bundle results) {
                if (delivered) return;
                delivered = true;
                ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                String best = matches != null && !matches.isEmpty() ? matches.get(0).trim() : "";
                destroyCommandRecognizer();
                callback.onResult(best);
            }

            @Override public void onPartialResults(Bundle partialResults) {}
            @Override public void onEvent(int eventType, Bundle params) {}
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());

        if ("TA".equalsIgnoreCase(language)) {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ta-IN");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "ta-IN");
        } else {
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN");
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-IN");
        }

        try {
            commandRecognizer.startListening(intent);
        } catch (Exception error) {
            destroyCommandRecognizer();
            failure.run();
        }
    }

    private HttpResult postJson(String path, JSONObject body) {
        if (apiBaseUrl.isEmpty() || wakeToken.isEmpty()) return new HttpResult(401, null);

        HttpURLConnection connection = null;
        try {
            URL url = new URL(apiBaseUrl + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(30000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + wakeToken);
            connection.setRequestProperty("X-Requested-With", "XMLHttpRequest");

            byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(data.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(data);
            }

            int code = connection.getResponseCode();
            InputStream stream = code >= 200 && code < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            String text = readStream(stream);
            JSONObject json = text.isEmpty() ? null : new JSONObject(text);
            return new HttpResult(code, json);
        } catch (Exception error) {
            return new HttpResult(0, null);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String readStream(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private void resumeWakeMode() {
        if (stopping) return;
        sessionBusy = false;
        afterSpeech = null;
        destroyCommandRecognizer();
        updateListeningNotification("Offline · Listening for \"Hey " + assistantName + "\"");
        handler.postDelayed(this::startWakeEngine, 220);
    }

    private void speakThen(String text, Runnable next) {
        afterSpeech = next;
        if (!ttsReady || tts == null || text == null || text.trim().isEmpty()) {
            handler.postDelayed(this::runAfterSpeech, 150);
            return;
        }
        try {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "wake-" + UUID.randomUUID());
        } catch (Exception ignored) {
            handler.postDelayed(this::runAfterSpeech, 150);
        }
    }

    private void runAfterSpeech() {
        Runnable next = afterSpeech;
        afterSpeech = null;
        if (next != null && !stopping) next.run();
    }

    private boolean isYes(String value) {
        return value.equals("yes") || value.equals("yeah") || value.equals("yep")
            || value.equals("confirm") || value.equals("ok") || value.equals("okay")
            || value.equals("add") || value.contains("சரி") || value.contains("ஆம்")
            || value.contains("ஆமா");
    }

    private boolean isNo(String value) {
        return value.equals("no") || value.equals("nope") || value.equals("cancel")
            || value.equals("stop") || value.contains("வேண்டாம்") || value.contains("இல்ல");
    }

    private void stopWakeEngineAudio() {
        SpeechService service = wakeSpeechService;
        wakeSpeechService = null;
        if (service != null) {
            try { service.cancel(); } catch (Exception ignored) {}
            try { service.shutdown(); } catch (Exception ignored) {}
        }
        Recognizer recognizer = wakeRecognizer;
        wakeRecognizer = null;
        if (recognizer != null) {
            try { recognizer.close(); } catch (Exception ignored) {}
        }
    }

    private void destroyCommandRecognizer() {
        SpeechRecognizer recognizer = commandRecognizer;
        commandRecognizer = null;
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (Exception ignored) {}
            try { recognizer.destroy(); } catch (Exception ignored) {}
        }
    }

    private PendingIntent assistantPendingIntent(String transcript) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_WAKE_ASSISTANT, true);
        if (transcript != null && !transcript.trim().isEmpty()) {
            intent.putExtra(MainActivity.EXTRA_WAKE_TRANSCRIPT, transcript);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            this,
            transcript == null ? 4104 : 4103,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private Notification buildListeningNotification(String text) {
        Intent stopIntent = new Intent(this, WakeWordService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(
            this,
            4105,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new Notification.Builder(this, CHANNEL_LISTENING)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(assistantName + " Wake Mode")
            .setContentText(text)
            .setContentIntent(assistantPendingIntent(null))
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void updateListeningNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(LISTENING_NOTIFICATION_ID, buildListeningNotification(text));
    }

    private void showActionNotification(String title, String text, String transcript) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(assistantPendingIntent(transcript))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setPriority(Notification.PRIORITY_HIGH)
            .build();

        manager.notify(WAKE_NOTIFICATION_ID, notification);
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel listening = new NotificationChannel(
            CHANNEL_LISTENING,
            "Assistant wake mode",
            NotificationManager.IMPORTANCE_LOW
        );
        listening.setDescription("Visible while offline background wake listening is active.");

        NotificationChannel alert = new NotificationChannel(
            CHANNEL_ALERT,
            "Assistant wake alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        alert.setDescription("Wake commands that need attention in Smart Expense.");

        manager.createNotificationChannel(listening);
        manager.createNotificationChannel(alert);
    }

    private void stopWakeService() {
        stopping = true;
        sessionBusy = false;
        handler.removeCallbacksAndMessages(null);
        stopWakeEngineAudio();
        destroyCommandRecognizer();
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) {}
        }
        if (wakeModel != null) {
            try { wakeModel.close(); } catch (Exception ignored) {}
            wakeModel = null;
        }
        getSharedPreferences("assistant_wake", MODE_PRIVATE)
            .edit()
            .putBoolean("running", false)
            .apply();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        stopWakeEngineAudio();
        destroyCommandRecognizer();
        if (wakeModel != null) {
            try { wakeModel.close(); } catch (Exception ignored) {}
            wakeModel = null;
        }
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) {}
            try { tts.shutdown(); } catch (Exception ignored) {}
            tts = null;
        }
        worker.shutdownNow();
        getSharedPreferences("assistant_wake", MODE_PRIVATE)
            .edit()
            .putBoolean("running", false)
            .apply();
        super.onDestroy();
    }

    @Override
    public void onInit(int status) {
        ttsReady = status == TextToSpeech.SUCCESS;
        if (ttsReady && tts != null) {
            tts.setLanguage("TA".equalsIgnoreCase(language) ? new Locale("ta", "IN") : new Locale("en", "IN"));
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private String normalize(String value) {
        if (value == null) return "";
        return value.toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9\\u0B80-\\u0BFF ]", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private String valueOrDefault(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private String trimTrailingSlash(String value) {
        String result = value == null ? "" : value.trim();
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private String shorten(String value, int max) {
        if (value == null) return "";
        String clean = value.replaceAll("\\s+", " ").trim();
        return clean.length() <= max ? clean : clean.substring(0, Math.max(0, max - 1)) + "…";
    }

    private interface SpeechResultCallback {
        void onResult(String transcript);
    }

    private static final class HttpResult {
        final int code;
        final JSONObject body;

        HttpResult(int code, JSONObject body) {
            this.code = code;
            this.body = body;
        }
    }
}
