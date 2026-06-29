package com.leludo.ludo;

import android.graphics.Color;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SystemChrome — paints the Activity window background.
 *
 * Under edge-to-edge the WebView is inset away from the system bars AND the
 * display cutout. The edge-to-edge plugin paints color overlays for the TOP
 * (status bar) and BOTTOM (navigation bar) inset strips only — it never paints
 * the LEFT/RIGHT strips, which in landscape on a notched phone is the camera
 * cutout area. Those uncovered strips fall through to the window background,
 * which defaults to black — the visible black bar beside the notch.
 *
 * Setting the decor-view background to the active theme's background color
 * fills that gap: the cutout strip then matches the app instead of showing
 * black. native-bars.js calls this with the same color it hands the bar
 * overlays, on boot and on every theme change, so all four edges stay in sync.
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
        getActivity().runOnUiThread(() ->
            getActivity().getWindow().getDecorView().setBackgroundColor(parsed)
        );
        call.resolve();
    }
}
