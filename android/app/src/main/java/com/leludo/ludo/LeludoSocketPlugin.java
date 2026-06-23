package com.leludo.ludo;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * LeludoSocket — a native WebSocket transport for multiplayer.
 *
 * The game's connection normally lives in the WebView's JS (`new WebSocket()`).
 * Android's System WebView throttles JS timers while the app is backgrounded /
 * dozing / under battery-saver, so the JS keepalive ping slips, the edge reaps
 * the idle socket, and the client churns through reconnects — felt as lag.
 *
 * OkHttp runs the socket on its own threads and sends WS-level ping frames on a
 * fixed native interval (pingInterval below), independent of the WebView's JS
 * loop, so the connection stays warm even when JS is throttled. Frames received
 * while JS is stalled are delivered as soon as the loop resumes.
 *
 * The JS side (net-client.js via native-socket.js) owns ALL reconnect/keepalive
 * POLICY; this plugin only moves bytes. One live socket at a time — the JS layer
 * supersedes it on every reconnect, and a per-socket `id` lets late events from
 * a replaced socket be dropped on both sides.
 */
@CapacitorPlugin(name = "LeludoSocket")
public class LeludoSocketPlugin extends Plugin {

    private OkHttpClient client;
    private WebSocket socket;
    // Generation guard: the id of the socket the JS layer currently cares about.
    // Events carrying any other id are stale (a superseded socket closing) and
    // are dropped before reaching JS.
    private String currentId;

    private OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                // Native keepalive — fires off the WebView's JS thread, so it
                // can't be throttled by the WebView. Comfortably under the edge's
                // ~60s idle-reap floor.
                .pingInterval(15, TimeUnit.SECONDS)
                .build();
        }
        return client;
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        String id = call.getString("id");
        if (url == null || id == null) {
            call.reject("url and id are required");
            return;
        }
        // The JS layer opens one socket at a time; drop any prior one. Its async
        // onClosed carries the OLD id, so the generation guard ignores it.
        closeSocket(1000, "superseded");
        currentId = id;
        final String sockId = id;

        Request request = new Request.Builder().url(url).build();
        socket = client().newWebSocket(request, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) {
                emit("open", sockId, null, 0);
            }
            @Override public void onMessage(WebSocket ws, String text) {
                emit("message", sockId, text, 0);
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, reason);
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                emit("close", sockId, reason, code);
            }
            @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                // Surface as an unexpected close (1006) so JS reconnects as usual.
                emit("close", sockId, t != null ? t.getMessage() : "failure", 1006);
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        String id = call.getString("id");
        if (socket != null && data != null && id != null && id.equals(currentId)) {
            socket.send(data);
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.equals(currentId)) {
            closeSocket(1000, "client closed");
        }
        call.resolve();
    }

    private void closeSocket(int code, String reason) {
        if (socket != null) {
            try { socket.close(code, reason); } catch (Exception ignored) { }
            socket = null;
        }
    }

    private void emit(String type, String id, String data, int code) {
        // Drop events from a socket the JS layer has already replaced.
        if (currentId == null || !currentId.equals(id)) return;
        JSObject event = new JSObject();
        event.put("id", id);
        if (data != null) event.put("data", data);
        event.put("code", code);
        notifyListeners(type, event);
    }
}
