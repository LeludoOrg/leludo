package com.leludo.ludo;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
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
 * OkHttp runs the socket on its own threads, so frames received while JS is
 * stalled are delivered as soon as the loop resumes, and the connection stays
 * up regardless of WebView throttling.
 *
 * KEEPALIVE — application-level, NOT WS-level. We deliberately do NOT use
 * OkHttp's `pingInterval`: that sends WebSocket PING control frames and FAILS
 * the connection if no PONG returns within the interval, but Cloudflare's
 * `server.accept()` sockets don't reliably PONG control frames, so OkHttp would
 * kill a perfectly healthy connection ~15s in. Instead a native scheduler sends
 * the same `{"t":"ping"}` DATA frame the server already treats as a no-op
 * keepalive (resets the edge idle-reap timer) — fired off a native thread, so it
 * can't be throttled by the WebView. `readTimeout(0)` keeps an idle socket from
 * timing out its read while waiting for the next frame.
 *
 * The JS side (net-client.js via native-socket.js) owns ALL reconnect POLICY;
 * this plugin only moves bytes + keeps the link warm. One live socket at a time —
 * the JS layer supersedes it on every reconnect, and a per-socket `id` lets late
 * events from a replaced socket be dropped on both sides.
 */
@CapacitorPlugin(name = "LeludoSocket")
public class LeludoSocketPlugin extends Plugin {

    // The app-level keepalive frame; mirrors MSG.PING in scripts/net/net-protocol.js.
    private static final String PING_FRAME = "{\"t\":\"ping\"}";
    private static final long PING_SECONDS = 20;

    private OkHttpClient client;
    // Touched from OkHttp callback threads, the ping scheduler thread, and the
    // plugin-call thread — volatile so each sees the latest socket/generation.
    private volatile WebSocket socket;
    // Generation guard: the id of the socket the JS layer currently cares about.
    // Events / pings for any other id are stale (a superseded socket) and dropped.
    private volatile String currentId;

    private ScheduledExecutorService scheduler;
    private volatile ScheduledFuture<?> pingTask;

    private OkHttpClient client() {
        if (client == null) {
            client = new OkHttpClient.Builder()
                // An open WebSocket may sit idle between turns; never time out its
                // read. (No pingInterval — see the class header for why.)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();
        }
        return client;
    }

    private ScheduledExecutorService scheduler() {
        if (scheduler == null) {
            scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "leludo-socket-ping");
                t.setDaemon(true);
                return t;
            });
        }
        return scheduler;
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
                startPing(sockId);
                emit("open", sockId, null, 0);
            }
            @Override public void onMessage(WebSocket ws, String text) {
                emit("message", sockId, text, 0);
            }
            @Override public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(code, reason);
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) {
                if (sockId.equals(currentId)) stopPing();
                emit("close", sockId, reason, code);
            }
            @Override public void onFailure(WebSocket ws, Throwable t, Response response) {
                if (sockId.equals(currentId)) stopPing();
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

    private void startPing(final String sockId) {
        stopPing();
        pingTask = scheduler().scheduleWithFixedDelay(() -> {
            // Only ping the socket the JS layer still owns, and only while open.
            if (socket != null && sockId.equals(currentId)) {
                try { socket.send(PING_FRAME); } catch (Exception ignored) { }
            }
        }, PING_SECONDS, PING_SECONDS, TimeUnit.SECONDS);
    }

    private void stopPing() {
        if (pingTask != null) {
            pingTask.cancel(false);
            pingTask = null;
        }
    }

    private void closeSocket(int code, String reason) {
        stopPing();
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
