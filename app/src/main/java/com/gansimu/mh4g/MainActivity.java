package com.gansimu.mh4g;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.InputStream;
import java.io.IOException;

public class MainActivity extends Activity {

    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);

        webView.addJavascriptInterface(new AndroidBridge(this), "Android");
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    public class AndroidBridge {
        private final Context context;
        AndroidBridge(Context c) { this.context = c; }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            ClipboardManager cb = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            cb.setPrimaryClip(ClipData.newPlainText("MH4G", text));
        }

        @JavascriptInterface
        public String loadAsset(String path) {
            try {
                InputStream is = context.getAssets().open(path);
                byte[] buf = new byte[is.available()];
                is.read(buf);
                is.close();
                return new String(buf, "UTF-8");
            } catch (IOException e) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveData(String key, String value) {
            context.getSharedPreferences("gansimu", Context.MODE_PRIVATE)
                   .edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public String loadData(String key) {
            return context.getSharedPreferences("gansimu", Context.MODE_PRIVATE)
                          .getString(key, "");
        }
    }
}
