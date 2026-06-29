package com.leludo.ludo;

import android.graphics.Color;
import android.view.View;
import android.view.ViewParent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SystemChrome — paints the backdrop behind the WebView so the display-cutout
 * strip matches the active theme instead of showing black.
 *
 * Under edge-to-edge the WebView is inset away from the system bars AND the
 * display cutout. The edge-to-edge plugin paints color overlays for the TOP
 * (status bar) and BOTTOM (navigation bar) inset strips only — never the
 * LEFT/RIGHT strips, which in landscape on a notched phone is the camera
 * cutout area. That strip falls through to whatever sits behind the WebView.
 *
 * The WebView's *immediate parent* ViewGroup is that backdrop (it's also where
 * the edge-to-edge plugin adds its bar overlays), and it defaults to no/black
 * background — so painting only the decor view wasn't enough: the parent's own
 * background still covered it. We paint the parent (and the decor view as a
 * belt-and-suspenders fallback) the theme color. Combined with the window
 * extending into the cutout (LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES, set in
 * MainActivity), the notch strip then renders the theme color.
 *
 * native-bars.js calls this with the same color it hands the bar overlays, on
 * boot and on every theme change, so all four edges stay in sync.
 */
@CapacitorPlugin(name = "SystemChrome")
public class SystemChromePlugin extends Plugin {

    @PluginMethod
    public void setBackgroundColor(PluginCall call) {
        String color = call.getString("color");
        if (color == null) {
            call.reject("color is required");
            return;
        }
        final int parsed;
        try {
            parsed = Color.parseColor(color);
        } catch (IllegalArgumentException e) {
            call.reject("invalid color: " + color);
            return;
        }
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().getDecorView().setBackgroundColor(parsed);
            View webView = getBridge() != null ? getBridge().getWebView() : null;
            if (webView != null) {
                ViewParent parent = webView.getParent();
                if (parent instanceof View) {
                    ((View) parent).setBackgroundColor(parsed);
                }
            }
        });
        call.resolve();
    }
}
