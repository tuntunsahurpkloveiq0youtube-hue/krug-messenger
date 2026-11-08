"""Генерирует Android-проект «Круг» (WebView-обёртка) в krug-android/.

Запуск: python tools/make-android.py
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'krug-android')

FILES = {}

FILES['settings.gradle.kts'] = '''pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Krug"
include(":app")
'''

FILES['build.gradle.kts'] = '''plugins {
    id("com.android.application") version "9.5.0" apply false
}
'''

FILES['gradle.properties'] = '''org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
org.gradle.parallel=true
android.useAndroidX=true
android.nonTransitiveRClass=true
# путь к проекту может содержать кириллицу — иначе AGP отказывается собирать
android.overridePathCheck=true

# Адрес сервера «Круга». Для домашней сети: http://192.168.0.197:3210/
krug.serverUrl=https://krug-messenger.onrender.com/
'''

FILES['.gitignore'] = '''*.iml
.gradle/
local.properties
.idea/
build/
app/build/
captures/
.externalNativeBuild/
.cxx/
'''

FILES['app/build.gradle.kts'] = '''plugins {
    id("com.android.application")
}

android {
    namespace = "ru.krug.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "ru.krug.app"
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        val url = (project.findProperty("krug.serverUrl") as String?)
            ?: "https://krug-messenger.onrender.com/"
        buildConfigField("String", "SERVER_URL", "\\"$url\\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
'''

FILES['app/proguard-rules.pro'] = '''# Ничего не минифицируем — правила не нужны.
'''

FILES['app/src/main/AndroidManifest.xml'] = '''<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.microphone" android:required="false" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:label="@string/app_name"
        android:networkSecurityConfig="@xml/network_security_config"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.NoActionBar"
        android:usesCleartextTraffic="true">

        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout|uiMode"
            android:exported="true"
            android:launchMode="singleTask"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
'''

FILES['app/src/main/res/values/strings.xml'] = '''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Круг</string>
</resources>
'''

FILES['app/src/main/res/xml/network_security_config.xml'] = '''<?xml version="1.0" encoding="utf-8"?>
<!-- Разрешаем обычный http: домашний сервер работает без TLS. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
'''

FILES['app/src/main/java/ru/krug/app/MainActivity.java'] = r'''package ru.krug.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

import java.util.ArrayList;
import java.util.List;

/**
 * «Круг» на телефоне: WebView открывает сервер мессенджера.
 * Адрес задаётся в gradle.properties (krug.serverUrl) и попадает в BuildConfig.
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_PERM = 1002;

    private WebView web;
    private ProgressBar progress;
    private ValueCallback<Uri[]> fileCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0f1a"));

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setBackgroundColor(Color.parseColor("#0b0f1a"));
        root.addView(web);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        progress.setVisibility(View.GONE);
        root.addView(progress, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 8));

        setContentView(root);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " KrugApp/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                String appHost = Uri.parse(BuildConfig.SERVER_URL).getHost();
                if (host != null && !host.equals(appHost)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                        // нечем открыть — остаёмся в приложении
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.loadUrl(BuildConfig.SERVER_URL);
        askPermissions();
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        for (String p : new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) {
                need.add(p);
            }
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_PERM);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            if (cb == null) {
                return;
            }
            if (resultCode != RESULT_OK || data == null) {
                cb.onReceiveValue(null);
                return;
            }
            Uri[] uris;
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                uris = new Uri[n];
                for (int i = 0; i < n; i++) {
                    uris[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            } else {
                uris = null;
            }
            cb.onReceiveValue(uris);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
'''

FILES['README-ANDROID.md'] = '''# «Круг» — Android-приложение (WebView)

Обёртка вокруг того же сайта: приложение открывает сервер мессенджера на весь экран,
поддерживает камеру, микрофон и выбор фото — то есть звонки и картинки работают.

## Как собрать в Android Studio

1. **File → Open** → выберите папку `krug-android`.
2. Дождитесь Gradle Sync. Если студия предложит обновить Gradle/AGP — согласитесь.
3. В `gradle.properties` проверьте адрес сервера:

   ```properties
   krug.serverUrl=https://krug-messenger.onrender.com/
   ```

   Для домашней сети: `krug.serverUrl=http://192.168.0.197:3210/`
4. Подключите телефон (или запустите эмулятор) и нажмите **Run ▶**.

## Собрать APK

- **Build → Build Bundle(s) / APK(s) → Build APK(s)** — файл появится в
  `app/build/outputs/apk/debug/app-debug.apk`.
- Для раздачи друзьям: **Build → Generate Signed App Bundle / APK**, создать ключ
  (Keystore) и собрать `release` — получится подписанный APK или AAB для Google Play.

## Что внутри

| Файл | Зачем |
| --- | --- |
| `app/src/main/java/ru/krug/app/MainActivity.java` | WebView, разрешения камеры/микрофона, выбор файлов, кнопка «Назад» |
| `app/src/main/AndroidManifest.xml` | интернет, камера, микрофон, `usesCleartextTraffic` для http |
| `app/src/main/res/xml/network_security_config.xml` | разрешает обычный http (домашний сервер) |
| `app/build.gradle.kts` | `compileSdk 37`, `minSdk 24`, адрес сервера через `buildConfigField` |

## Важные ограничения

- **Камера и микрофон работают только по HTTPS.** WebView, как и браузер, считает
  `http://192.168.x.x` небезопасным адресом и блокирует `getUserMedia`. Поэтому звонки —
  только через Render (`https://…`). По http будут работать чаты, каналы и картинки.
- Адрес сервера «вшит» при сборке: поменяли `krug.serverUrl` — нужна пересборка.
- Приложение не обходит сеть: если телефон не видит сервер, APK тоже не увидит.
'''

GENERATED = set(FILES)


def write_all() -> None:
    for rel, content in FILES.items():
        path = os.path.join(OUT, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
        print('written:', rel)


def make_icons() -> None:
    spec = importlib.util.spec_from_file_location(
        'mkicons', os.path.join(HERE, 'make-icons.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    sizes = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for dpi, size in sizes.items():
        img = mod.build(size, True)
        for name in ('ic_launcher.png', 'ic_launcher_round.png'):
            path = os.path.join(OUT, 'app', 'src', 'main', 'res',
                                f'mipmap-{dpi}', name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            img.save(path, 'PNG', optimize=True)
        print(f'icons: mipmap-{dpi} ({size}px)')


if __name__ == '__main__':
    write_all()
    make_icons()
    print('готово:', OUT)
