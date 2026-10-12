package com.keerthi.expensetracker;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;

import java.util.ArrayList;
import java.util.Locale;

public class WakeWordService extends Service implements TextToSpeech.OnInitListener {
    public static final String ACTION_START = "com.keerthi.expensetracker.action.START_WAKE";
    public static final String ACTION_STOP = "com.keerthi.expensetracker.action.STOP_WAKE";
    public static final String EXTRA_ASSISTANT_NAME = "assistant_name";

    private static final String CHANNEL_LISTENING = "assistant_wake_listening";
    private static final String CHANNEL_ALERT = "assistant_wake_alert";
    private static final int LISTENING_NOTIFICATION_ID = 4101;
    private static final int WAKE_NOTIFICATION_ID = 4102;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private TextToSpeech tts;
    private String assistantName = "Nova";
    private String wakePhrase = "hey nova";
    private boolean stopping = false;
    private boolean recognizerRunning = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        tts = new TextToSpeech(this, this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopWakeService();
            return START_NOT_STICKY;
        }

        if (intent != null) {
            String requestedName = intent.getStringExtra(EXTRA_ASSISTANT_NAME);
            if (requestedName != null && !requestedName.trim().isEmpty()) {
                assistantName = requestedName.trim();
            }
        }
        wakePhrase = normalize("hey " + assistantName);
        stopping = false;

        Notification notification = buildListeningNotification();
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
            .apply();

        handler.post(this::startRecognizer);
        return START_NOT_STICKY;
    }

    private void startRecognizer() {
        if (stopping || recognizerRunning) return;
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            updateListeningNotification("Speech recognition unavailable");
            handler.postDelayed(this::startRecognizer, 5000);
            return;
        }

        destroyRecognizer();

        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && SpeechRecognizer.isOnDeviceRecognitionAvailable(this)
        ) {
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
        } else {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        }

        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(android.os.Bundle params) {
                recognizerRunning = true;
                updateListeningNotification("Listening for \"Hey " + assistantName + "\"");
            }

            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {
                recognizerRunning = false;
            }

            @Override public void onError(int error) {
                recognizerRunning = false;
                destroyRecognizer();
                if (!stopping) handler.postDelayed(WakeWordService.this::startRecognizer, retryDelay(error));
            }

            @Override public void onResults(android.os.Bundle results) {
                recognizerRunning = false;
                if (containsWakePhrase(results)) {
                    onWakeDetected();
                } else {
                    destroyRecognizer();
                    if (!stopping) handler.postDelayed(WakeWordService.this::startRecognizer, 250);
                }
            }

            @Override public void onPartialResults(android.os.Bundle partialResults) {
                if (containsWakePhrase(partialResults)) {
                    try {
                        recognizer.cancel();
                    } catch (Exception ignored) {}
                    recognizerRunning = false;
                    onWakeDetected();
                }
            }

            @Override public void onEvent(int eventType, android.os.Bundle params) {}
        });

        Intent recognitionIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN");
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "en-IN");
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());

        try {
            recognizerRunning = true;
            recognizer.startListening(recognitionIntent);
        } catch (Exception exception) {
            recognizerRunning = false;
            destroyRecognizer();
            if (!stopping) handler.postDelayed(this::startRecognizer, 1500);
        }
    }

    private boolean containsWakePhrase(android.os.Bundle bundle) {
        if (bundle == null) return false;
        ArrayList<String> matches = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null) return false;

        String nameOnly = normalize(assistantName);
        for (String match : matches) {
            String normalized = normalize(match);
            if (normalized.contains(wakePhrase)) return true;

            // Speech engines sometimes drop the short "hey" token. Accept the
            // configured assistant name only when the utterance is very short.
            if (!nameOnly.isEmpty() && normalized.equals(nameOnly)) return true;
        }
        return false;
    }

    private void onWakeDetected() {
        destroyRecognizer();
        speakAcknowledgement();
        showWakeAlert();

        Intent openAssistant = new Intent(this, MainActivity.class);
        openAssistant.setAction(Intent.ACTION_VIEW);
        openAssistant.putExtra(MainActivity.EXTRA_WAKE_ASSISTANT, true);
        openAssistant.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
        );

        try {
            startActivity(openAssistant);
        } catch (Exception ignored) {
            // Modern Android may block background activity launches. The
            // heads-up notification remains the supported fallback.
        }

        if (!stopping) handler.postDelayed(this::startRecognizer, 3500);
    }

    private void speakAcknowledgement() {
        if (tts == null) return;
        try {
            tts.speak("Yes?", TextToSpeech.QUEUE_FLUSH, null, "assistant-wake");
        } catch (Exception ignored) {}
    }

    private void showWakeAlert() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            4103,
            assistantIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification notification = new Notification.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(assistantName + " is ready")
            .setContentText("Tap to speak your finance command")
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setPriority(Notification.PRIORITY_HIGH)
            .build();

        manager.notify(WAKE_NOTIFICATION_ID, notification);
    }

    private Intent assistantIntent() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra(MainActivity.EXTRA_WAKE_ASSISTANT, true);
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    private Notification buildListeningNotification() {
        PendingIntent openApp = PendingIntent.getActivity(
            this,
            4104,
            assistantIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

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
            .setContentText("Listening for \"Hey " + assistantName + "\"")
            .setContentIntent(openApp)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
    }

    private void updateListeningNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        Notification notification = new Notification.Builder(this, CHANNEL_LISTENING)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(assistantName + " Wake Mode")
            .setContentText(text)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    4104,
                    assistantIntent(),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                )
            )
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build();
        manager.notify(LISTENING_NOTIFICATION_ID, notification);
    }

    private long retryDelay(int error) {
        if (
            error == SpeechRecognizer.ERROR_NETWORK
            || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
            || error == SpeechRecognizer.ERROR_SERVER
        ) return 3000;
        if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) return 1500;
        return 600;
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
        listening.setDescription("Persistent microphone indicator while background wake mode is enabled.");

        NotificationChannel alert = new NotificationChannel(
            CHANNEL_ALERT,
            "Assistant wake alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        alert.setDescription("Alerts shown when your assistant wake phrase is detected.");

        manager.createNotificationChannel(listening);
        manager.createNotificationChannel(alert);
    }

    private String normalize(String value) {
        if (value == null) return "";
        return value
            .toLowerCase(Locale.ROOT)
            .replaceAll("[^a-z0-9 ]", " ")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {}
            recognizer = null;
        }
        recognizerRunning = false;
    }

    private void stopWakeService() {
        stopping = true;
        handler.removeCallbacksAndMessages(null);
        destroyRecognizer();
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
        destroyRecognizer();
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        getSharedPreferences("assistant_wake", MODE_PRIVATE)
            .edit()
            .putBoolean("running", false)
            .apply();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Keep the explicitly enabled foreground service alive when the UI is
        // dismissed. The user can stop it from the persistent notification.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS && tts != null) {
            tts.setLanguage(Locale.ENGLISH);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
