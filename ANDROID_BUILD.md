# Android build — no Android Studio required

Smart Expense Tracker is configured to build Android packages from the command line and GitHub Actions.

## Automatic GitHub build
Every push to `main` that changes the frontend starts **Android APK Build**.
The workflow:
1. installs Node, Java and Android SDK,
2. builds the Vite production app,
3. runs `npx cap sync android`,
4. builds the APK with Gradle,
5. uploads `SmartExpenseTracker.apk` as a GitHub Actions artifact.

Android Studio is not required.

## Windows one-command build
From the `frontend` folder:

```cmd
build-android.cmd
```

The APK is created at:

```
frontend\release\SmartExpenseTracker.apk
```

The app icon, splash resources and Capacitor project are synced from the repository before every build.
