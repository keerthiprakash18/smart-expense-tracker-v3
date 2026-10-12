package com.keerthi.expensetracker;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class WakeModelManager {
    public interface Callback {
        void onReady(File modelDirectory);
        void onError(Exception error);
    }

    private static final String MODEL_NAME = "vosk-model-small-en-in-0.4";
    private static final String MODEL_URL =
        "https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip";
    private static final long MAX_DOWNLOAD_BYTES = 80L * 1024L * 1024L;

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean PREPARING = new AtomicBoolean(false);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private WakeModelManager() {}

    public static File modelDirectory(Context context) {
        return new File(new File(context.getFilesDir(), "wake-models"), MODEL_NAME);
    }

    public static boolean isReady(Context context) {
        File model = modelDirectory(context);
        return new File(model, "am/final.mdl").isFile()
            && new File(model, "conf/mfcc.conf").isFile();
    }

    public static void ensureModel(Context context, Callback callback) {
        Context appContext = context.getApplicationContext();
        if (isReady(appContext)) {
            MAIN.post(() -> callback.onReady(modelDirectory(appContext)));
            return;
        }

        if (!PREPARING.compareAndSet(false, true)) {
            waitForPreparation(appContext, callback, 0);
            return;
        }

        EXECUTOR.execute(() -> {
            try {
                File model = downloadAndExtract(appContext);
                MAIN.post(() -> callback.onReady(model));
            } catch (Exception error) {
                MAIN.post(() -> callback.onError(error));
            } finally {
                PREPARING.set(false);
            }
        });
    }

    private static void waitForPreparation(Context context, Callback callback, int attempts) {
        if (isReady(context)) {
            callback.onReady(modelDirectory(context));
            return;
        }
        if (!PREPARING.get()) {
            callback.onError(new IOException("Wake model preparation failed."));
            return;
        }
        if (attempts >= 240) {
            callback.onError(new IOException("Wake model preparation timed out."));
            return;
        }
        MAIN.postDelayed(() -> waitForPreparation(context, callback, attempts + 1), 500);
    }

    private static File downloadAndExtract(Context context) throws IOException {
        File root = new File(context.getFilesDir(), "wake-models");
        if (!root.exists() && !root.mkdirs()) {
            throw new IOException("Could not create wake model directory.");
        }

        File zipFile = new File(root, MODEL_NAME + ".download");
        File finalModel = modelDirectory(context);
        if (finalModel.exists() && !isReady(context)) {
            deleteRecursively(finalModel);
        }

        HttpURLConnection connection = null;
        long written = 0;
        try {
            connection = (HttpURLConnection) new URL(MODEL_URL).openConnection();
            connection.setConnectTimeout(30000);
            connection.setReadTimeout(120000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "SmartExpenseTracker/1.0 Android");
            connection.connect();

            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("Wake model download failed with HTTP " + status);
            }

            long declaredLength = connection.getContentLengthLong();
            if (declaredLength > MAX_DOWNLOAD_BYTES) {
                throw new IOException("Wake model download is unexpectedly large.");
            }

            try (
                BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
                BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(zipFile))
            ) {
                byte[] buffer = new byte[32 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    written += count;
                    if (written > MAX_DOWNLOAD_BYTES) {
                        throw new IOException("Wake model exceeded the allowed download size.");
                    }
                    output.write(buffer, 0, count);
                }
            }
        } finally {
            if (connection != null) connection.disconnect();
        }

        if (written < 1024 * 1024) {
            zipFile.delete();
            throw new IOException("Wake model download was incomplete.");
        }

        extractZipSafely(zipFile, root);
        zipFile.delete();

        if (!isReady(context)) {
            deleteRecursively(finalModel);
            throw new IOException("Downloaded wake model is incomplete.");
        }
        return finalModel;
    }

    private static void extractZipSafely(File zipFile, File destinationRoot) throws IOException {
        String canonicalRoot = destinationRoot.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(new java.io.FileInputStream(zipFile)))) {
            ZipEntry entry;
            byte[] buffer = new byte[32 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                File output = new File(destinationRoot, entry.getName());
                String canonicalOutput = output.getCanonicalPath();
                if (!canonicalOutput.startsWith(canonicalRoot)) {
                    throw new IOException("Unsafe path inside wake model archive.");
                }

                if (entry.isDirectory()) {
                    if (!output.exists() && !output.mkdirs()) {
                        throw new IOException("Could not create wake model folder.");
                    }
                } else {
                    File parent = output.getParentFile();
                    if (parent != null && !parent.exists() && !parent.mkdirs()) {
                        throw new IOException("Could not create wake model folder.");
                    }
                    try (BufferedOutputStream fileOut = new BufferedOutputStream(new FileOutputStream(output))) {
                        int count;
                        while ((count = zip.read(buffer)) != -1) {
                            fileOut.write(buffer, 0, count);
                        }
                    }
                }
                zip.closeEntry();
            }
        }
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursively(child);
            }
        }
        file.delete();
    }
}
