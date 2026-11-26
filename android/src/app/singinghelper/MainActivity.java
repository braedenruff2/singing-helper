package app.singinghelper;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Singing Helper on the phone: the same web app as on the PC (bundled in assets/www), shown in a WebView from the
 * secure address https://appassets.androidplatform.net/ so the microphone and the audio worklet work. The page talks
 * to Android through window.SHAndroid (app updates); Android calls back window.SHUpdateState().
 */
public class MainActivity extends Activity {
    private static final int PICK_FILE = 1, MIC = 2, NOTIFY = 3, BT = 4;
    /** An update waiting to install goes in only after he has been away this long (not when he just switches to
     *  Spotify or locks the screen for a moment: the restart would lose a loaded chart). */
    static final long INSTALL_AFTER_MS = 10 * 60_000L;
    /** The app is on screen: Updater can show Android's install prompt straight away instead of a notification. */
    static volatile boolean visible;
    /** The host of the page now shown (the bridge only answers our own page, not the Spotify login). */
    private volatile String pageHost = Assets.HOST;
    /** "Allow updates" waits for the notification question to be answered before Settings opens over it. */
    private boolean allowAfterNotify;
    private WebView web;
    static final int TV_PORT = 47321;
    private volatile java.net.DatagramSocket tvSocket;
    private android.widget.FrameLayout root;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest pendingMic;
    private boolean ownScreenOnTop; // set when the app opens something over itself (file picker, a link, Settings)

    private final Updater.Listener updateListener = () -> runOnUiThread(() -> {
        if (web != null) web.evaluateJavascript("window.SHUpdateState&&SHUpdateState()", null);
    });

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        // practising: the screen stays on while the app is open
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0F1115"));
        root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0F1115"));
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        // Android 15 draws edge to edge: keep the page clear of the status bar, gesture bar and keyboard
        root.setOnApplyWindowInsetsListener((v, in) -> { int[] p = insets(in); v.setPadding(p[0], p[1], p[2], p[3]); return in; });
        setContentView(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "SHAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!Assets.HOST.equalsIgnoreCase(u.getHost())) return null; // the internet (Spotify, LRCLIB) as usual
                return asset(u.getPath());
            }
            @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                try { pageHost = Uri.parse(url).getHost(); } catch (Exception e) { pageHost = null; }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!r.isForMainFrame()) return false; // a frame inside a page (Spotify's login has some): load it in place
                if ("https".equals(u.getScheme()) && Assets.staysInApp(u.getHost())) return false; // the app, Spotify login
                try { ownScreenOnTop = true; startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { ownScreenOnTop = false; }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(final PermissionRequest req) {
                runOnUiThread(() -> {
                    boolean wantsMic = false;
                    for (String res : req.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) wantsMic = true;
                    if (!wantsMic || !Assets.HOST.equalsIgnoreCase(req.getOrigin().getHost())) { req.deny(); return; }
                    // a Bluetooth headset's mic is only offered to the page with "Nearby devices" (Android 12+): asked once,
                    // together with the mic, so the headset shows in the mic list
                    boolean askBt = Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
                        && !getSharedPreferences("asked", MODE_PRIVATE).getBoolean("bt", false);
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                        if (askBt) requestPermissions(new String[]{Manifest.permission.BLUETOOTH_CONNECT}, BT);
                    } else {
                        if (pendingMic != null) pendingMic.deny();
                        pendingMic = req;
                        requestPermissions(askBt ? new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT} : new String[]{Manifest.permission.RECORD_AUDIO}, MIC);
                    }
                });
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try { ownScreenOnTop = true; startActivityForResult(i, PICK_FILE); }
                catch (Exception e) { ownScreenOnTop = false; fileCallback = null; cb.onReceiveValue(null); return false; }
                return true;
            }
        });
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(Assets.ORIGIN + "index.html");
    }

    /** A bundled file for the page, or a 404. */
    private WebResourceResponse asset(String urlPath) {
        String p = Assets.path(urlPath);
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        h.put("Access-Control-Allow-Origin", Assets.ORIGIN.substring(0, Assets.ORIGIN.length() - 1));
        if (p != null) {
            try {
                InputStream in = getAssets().open(p);
                String mime = Assets.mime(p);
                return new WebResourceResponse(mime, Assets.isText(mime) ? "UTF-8" : null, 200, "OK", h, in);
            } catch (Exception ignored) { }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", h, new java.io.ByteArrayInputStream(new byte[0]));
    }

    @SuppressWarnings("deprecation")
    private static int[] insets(WindowInsets in) {
        if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            android.graphics.Insets ime = in.getInsets(WindowInsets.Type.ime());
            return new int[]{bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom)};
        }
        return new int[]{in.getSystemWindowInsetLeft(), in.getSystemWindowInsetTop(), in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom()};
    }

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == NOTIFY) {
            // answered (empty results = the dialog was cut short: ask again another time)
            if (res.length > 0) getSharedPreferences("asked", MODE_PRIVATE).edit().putBoolean("notify", true).apply();
            if (allowAfterNotify) { allowAfterNotify = false; openUnknownSources(); }
            return;
        }
        if ((req == MIC || req == BT) && Assets.answered(perms, res, Manifest.permission.BLUETOOTH_CONNECT) != 0) {
            getSharedPreferences("asked", MODE_PRIVATE).edit().putBoolean("bt", true).apply();
            if (web != null) web.evaluateJavascript("window.SHMicsChanged&&SHMicsChanged()", null); // the headset may show now
        }
        if (req != MIC || pendingMic == null) return;
        if (Assets.answered(perms, res, Manifest.permission.RECORD_AUDIO) > 0) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else pendingMic.deny();
        pendingMic = null;
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == PICK_FILE && fileCallback != null) {
            Uri u = res == RESULT_OK && data != null ? data.getData() : null;
            fileCallback.onReceiveValue(u == null ? null : new Uri[]{u});
            fileCallback = null;
        }
    }

    @Override protected void onStart() {
        super.onStart();
        Updater.InstallLater.cancel(this); // back within the wait: no restart
    }

    @Override protected void onResume() {
        super.onResume();
        visible = true;
        ownScreenOnTop = false;
        Updater.cancelReadyNotice(this); // he's in the app: "Update now" is right here
        if (web != null) web.onResume();
        Updater.check(getApplicationContext(), false, updateListener);
    }

    @Override protected void onPause() {
        // the page stops the mic itself when hidden; WebView timers pause too
        visible = false;
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override protected void onStop() {
        super.onStop();
        // install a downloaded update once he has been away from the app for a while (it restarts the app): an alarm,
        // because a cached app's own timers stop (and uptime stops while the phone sleeps). Not while the app has its
        // own screen on top (the chart file picker, a link): the restart would lose it. Scheduled even if the update
        // is still downloading; the alarm checks again when it goes off.
        if (!isChangingConfigurations() && !ownScreenOnTop && fileCallback == null) Updater.InstallLater.schedule(this, INSTALL_AFTER_MS);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }

    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        super.onDestroy();
    }

    /** Asks once for notifications (Android 13+), so "Tap to install" and "updated" notices can show. */
    private boolean needNotifications() {
        return Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            && !getSharedPreferences("asked", MODE_PRIVATE).getBoolean("notify", false);
    }
    /** Asks once for notifications (Android 13+); the answer is recorded in onRequestPermissionsResult. */
    private void askNotifications() {
        if (needNotifications()) runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY));
    }
    private void openUnknownSources() {
        try { ownScreenOnTop = true; startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); }
        catch (Exception e) { ownScreenOnTop = false; }
    }

    /** window.SHAndroid in the page (called on a background thread). */
    class Bridge {
        @JavascriptInterface public boolean isApp() { return Assets.ownPage(pageHost); }
        @JavascriptInterface public String updateStatus() { return Assets.ownPage(pageHost) ? Updater.status(getApplicationContext()) : ""; }
        @JavascriptInterface public void updateCheck() { if (!Assets.ownPage(pageHost)) return; askNotifications(); Updater.check(getApplicationContext(), true, updateListener); }
        @JavascriptInterface public void updateAllow() {
            if (!Assets.ownPage(pageHost)) return;
            runOnUiThread(() -> {
                // first the notification question (for "Tap to install"), then Settings, never both at once
                if (needNotifications()) { allowAfterNotify = true; requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFY); }
                else openUnknownSources();
            });
        }
        /** The app's page in Android's Settings (to allow the mic after he refused it twice). */
        @JavascriptInterface public void openSettings() {
            if (!Assets.ownPage(pageHost)) return;
            runOnUiThread(() -> {
                try { ownScreenOnTop = true; startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); }
                catch (Exception e) { ownScreenOnTop = false; }
            });
        }
        /** Karaoke on the TV: one pitch message to the TV app (UDP 47321). Home network addresses only. */
        @JavascriptInterface public boolean tvSend(String ip, String msg) {
            if (!Assets.ownPage(pageHost) || !Assets.lanIp(ip) || msg == null || msg.length() > 512) return false;
            try {
                if (tvSocket == null) tvSocket = new java.net.DatagramSocket();
                byte[] b = msg.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                tvSocket.send(new java.net.DatagramPacket(b, b.length, java.net.InetAddress.getByName(ip), TV_PORT));
                return true;
            } catch (Exception e) { return false; }
        }
        /** Asks the home network "any Singing Helper TV there?"; answers go to window.SHTVFound([{name, ip}]) after 1.5 s. */
        @JavascriptInterface public void tvFind() {
            if (!Assets.ownPage(pageHost)) return;
            new Thread(() -> {
                StringBuilder found = new StringBuilder("[");
                java.util.Set<String> seen = new java.util.HashSet<>();
                try (java.net.DatagramSocket s = new java.net.DatagramSocket()) {
                    s.setBroadcast(true);
                    s.setSoTimeout(300);
                    byte[] hello = ("{\"v\":1,\"type\":\"hello\",\"name\":" + Assets.quote(Build.MODEL) + "}").getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    long end = System.currentTimeMillis() + 1500;
                    for (int round = 0; round < 3 && System.currentTimeMillis() < end; round++) {
                        s.send(new java.net.DatagramPacket(hello, hello.length, java.net.InetAddress.getByName("255.255.255.255"), TV_PORT));
                        long until = Math.min(end, System.currentTimeMillis() + 500);
                        while (System.currentTimeMillis() < until) {
                            byte[] buf = new byte[600];
                            java.net.DatagramPacket p = new java.net.DatagramPacket(buf, buf.length);
                            try { s.receive(p); } catch (java.net.SocketTimeoutException t) { continue; }
                            String ip = p.getAddress().getHostAddress();
                            String txt = new String(p.getData(), 0, p.getLength(), java.nio.charset.StandardCharsets.UTF_8);
                            if (!txt.contains("\"type\":\"tv\"") || !Assets.lanIp(ip) || !seen.add(ip)) continue;
                            String name = Assets.str(txt, "name");
                            found.append(found.length() > 1 ? "," : "").append("{\"ip\":").append(Assets.quote(ip)).append(",\"name\":").append(Assets.quote(name == null ? "TV" : name)).append('}');
                        }
                    }
                } catch (Exception ignored) { }
                final String js = "window.SHTVFound&&SHTVFound(" + found.append(']') + ")";
                runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
            }, "sh-tv-find").start();
        }
        @JavascriptInterface public void updateInstall() {
            if (!Assets.ownPage(pageHost)) return;
            final Context app = getApplicationContext();
            new Thread(() -> Updater.install(app), "sh-update-install").start();
        }
    }
}
