package com.leludo.ludo;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Native WebSocket transport (keeps the multiplayer connection warm off
        // the WebView's throttle-prone JS thread). Must register before super.
        registerPlugin(LeludoSocketPlugin.class);
        // Paints the window background (the cutout/notch strip in landscape that
        // edge-to-edge leaves black) to match the active theme; driven by JS.
        registerPlugin(SystemChromePlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
                webView.getSettings().setSaveFormData(false);
            }
        }
    }
}
