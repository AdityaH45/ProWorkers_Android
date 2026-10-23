# ProWorkers – Android app

This is your React frontend wrapped with Capacitor. The website files are bundled inside the app;
the app talks to your **backend over the internet**, so the backend must be hosted (Render, Railway, VPS...).

## 1. Set your backend URL
Edit `.env`:
    VITE_API_URL=https://your-backend.onrender.com
(no trailing slash; the app adds `/api`). Use `https://` – Android blocks nothing, but it is safer.

## 2a. Build with GitHub (no install needed)
1. Create a GitHub repo and upload this folder.
2. Repo -> Settings -> Secrets and variables -> Actions -> **Variables** -> add `API_URL` = your backend URL.
3. Actions tab -> "Build Android APK" -> Run workflow. Download `ProWorkers-debug-apk` when it finishes.

## 2b. Build locally
    npm install
    npm run android:sync
    cd android && ./gradlew assembleDebug      (or open `android/` in Android Studio)
APK: `android/app/build/outputs/apk/debug/app-debug.apk`

## Play Store release
Needs a signed release build (`./gradlew bundleRelease` + your own keystore). Ask and I will set that up.
