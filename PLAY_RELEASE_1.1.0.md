# Smart Expense Tracker — Play Store Release 1.1.0

## Release
- Package: `com.keerthi.expensetracker`
- Version name: `1.1.0`
- Version code: `2026101201`
- Primary Android addition: optional background AI assistant wake mode

## Suggested Play release notes
Meet the upgraded Smart Expense AI Assistant. Enable optional Background Wake Mode to call your assistant by name, capture expenses or quick notes by voice, confirm financial changes safely, and view saved voice notes inside the app. This release also improves Android voice reliability, privacy controls, and logout/wake-session security.

## Foreground service declaration — microphone
**Feature:** Background Wake Mode for the user-configured AI assistant.

**Why microphone foreground service is required:**
When the user explicitly enables Background Wake Mode, Smart Expense Tracker keeps a visible Android foreground-service notification and listens locally for the configured wake phrase, such as “Hey Lucifer”. This allows the user to start a finance command while another app is open without manually opening Smart Expense Tracker.

**User initiation and control:**
- Background Wake Mode is OFF by default.
- The user must enable it from AI Assistant settings.
- A prominent disclosure explains background microphone access before activation.
- Android microphone permission is requested through the normal runtime permission flow.
- A persistent notification is visible while listening is enabled.
- The user can stop listening from the notification, disable Wake Mode in settings, or log out.
- Logging out revokes the background wake session.

**Data behavior:**
- Wake phrase detection runs on-device after the one-time offline wake model setup.
- Smart Expense Tracker does not persist raw microphone audio.
- After the wake phrase, Android speech recognition transcribes the spoken command. Depending on the device/system speech service, transcription may use network processing.
- The resulting transcript is sent securely to the Smart Expense backend only to process the requested assistant action.
- Finance mutations continue through validation and confirmation.
- Quick notes may be saved to the authenticated user's Assistant Notes.

## Permission disclosure shown in the app
“Microphone stays active while Wake Mode is on. Android shows a persistent notification, and you can stop Wake Mode from that notification or this settings screen at any time.

Wake phrase detection is local after first setup. The first enable downloads an offline speech model. ‘Hey <Assistant Name>’ detection then runs on this device.

Your command starts only after the wake phrase. After wake, Android speech recognition transcribes the command; depending on your device it may use an Android speech service/network. The transcript is sent to Smart Expense to process your finance request or save a note. Smart Expense does not store raw microphone audio.”

## Play Console checklist
- Upload the signed AAB, not the unsigned validation bundle.
- Confirm Play App Signing / Upload key certificate.
- Complete the microphone foreground-service declaration.
- Review Data safety for microphone/audio handling and transmitted voice transcripts.
- Verify the public Privacy Policy reflects the behavior above.
- Use Closed testing first for the native wake feature.
- Test: enable/disable Wake Mode, denied microphone permission, app backgrounded, screen locked where supported, Stop notification action, logout, wake phrase, expense confirmation, note capture, expired wake session.
- After closed-test validation, roll out gradually to production.
