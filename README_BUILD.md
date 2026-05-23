# MH4G スキルシミュレータ Android版 ビルド手順

## 必要なもの
- Android Studio (最新版)
- Android SDK (compileSdk 34)

## ビルド手順

1. このフォルダを Android Studio で開く
   - [File] → [Open] → mh4g_simulator フォルダを選択

2. Gradle Sync が自動で実行される
   - 初回は gradle-wrapper.jar のダウンロードが必要

3. ビルド
   - [Build] → [Build Bundle(s) / APK(s)] → [Build APK(s)]
   - または: `./gradlew assembleDebug`

4. APKの場所
   - `app/build/outputs/apk/debug/app-debug.apk`

## アプリの仕様
- Java Swing版「頑シミュ MH4G ver.0.9.6」をWebViewで完全移植
- UIと機能はオリジナルと同じ
- お守り・マイセット・固定/除外装備の設定はアプリ再起動後も保持

## データファイル
`app/src/main/assets/data/` に全CSVが同梱済み（UTF-8変換済）
