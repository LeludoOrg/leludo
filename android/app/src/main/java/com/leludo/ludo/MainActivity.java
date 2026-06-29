package com.leludo.ludo;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
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
        // Let the window lay out INTO the display cutout on short edges. Without
        // this, real devices letterbox the notch area solid black in landscape
        // (the window never extends there), so no background color — JS-set or
        // otherwise — can reach it. With SHORT_EDGES the cutout strip becomes
        // part of the window: SystemChromePlugin's decor-view background paints
        // it the theme color, and the edge-to-edge plugin's displayCutout insets
        // still keep the WebView content clear of the physical notch.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WebView webView = this.bridge.getWebView();
            if (webView != null) {
                webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
                webView.getSettings().setSaveFormData(false);
            }
        }
    }
}
