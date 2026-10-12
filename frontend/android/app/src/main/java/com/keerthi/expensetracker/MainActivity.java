package com.keerthi.expensetracker;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    public static final String EXTRA_WAKE_ASSISTANT = "wake_assistant";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeSpeechPlugin.class);
        super.onCreate(savedInstanceState);
        handleWakeIntent(getIntent(), 1200);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleWakeIntent(intent, 350);
    }

    private void handleWakeIntent(Intent intent, long delayMs) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_WAKE_ASSISTANT, false)) return;
        intent.removeExtra(EXTRA_WAKE_ASSISTANT);
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (bridge == null || bridge.getWebView() == null) return;
            bridge.getWebView().evaluateJavascript(
                "window.location.hash='#/assistant';" +
                "setTimeout(function(){window.dispatchEvent(new CustomEvent('smart-expense-wake'));},500);",
                null
            );
        }, delayMs);
    }
}
