package app.singinghelper;

import android.app.Activity;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Singing Helper on the TV: tv.html (bundled in assets/www) full screen, served from https://appassets.androidplatform.net/
 * like the phone app. While it's on screen it
 *  - listens on UDP 47321 for the phone's pitch messages and hands each one to the page (SHTV.message), answering
 *    the phone's "hello" with the TV's name so the phone can find it;
 *  - takes songs from a browser on the home network at http://<TV>:47322/ (UltraStar .txt + audio), with the code
 *    shown on the TV, into the app's songs folder, which the page reads as songs/.
 * Both stop when the app leaves the screen.
 */
public class TvActivity extends Activity {
    private WebView web;
    private File songs;
    private volatile boolean running;
    private volatile DatagramSocket udp;
    private volatile ServerSocket http;
    private int wrongCodes;
    private long lockedUntil;
    private WifiManager.MulticastLock multicast;
    private final String code = String.format(Locale.ROOT, "%04d", new SecureRandom().nextInt(10000));

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        File ext = getExternalFilesDir("songs");
        songs = ext != null ? ext : new File(getFilesDir(), "songs");
        songs.mkdirs();
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B1020"));
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Bridge(), "SHTVAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!Assets.HOST.equalsIgnoreCase(u.getHost())) return null;
                return serve(u.getPath(), r.getRequestHeaders());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !Assets.HOST.equalsIgnoreCase(r.getUrl().getHost()); // nothing else opens on the TV
            }
        });
        web.setFocusable(true);
        web.requestFocus();
        if (saved == null || web.restoreState(saved) == null) web.loadUrl(Assets.ORIGIN + "tv.html");
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); if (web != null) web.saveState(out); }

    @Override protected void onStart() {
        super.onStart();
        running = true;
        if (web != null) web.onResume();
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) { multicast = wm.createMulticastLock("singing-helper"); multicast.setReferenceCounted(false); multicast.acquire(); }
        } catch (Exception ignored) { }
        new Thread(this::listen, "pitch").start();
        new Thread(this::uploads, "uploads").start();
    }

    @Override protected void onStop() {
        running = false;
        if (web != null) { web.evaluateJavascript("window.SHTV&&SHTV.hide&&SHTV.hide()", null); web.onPause(); }
        if (udp != null) udp.close();
        try { if (http != null) http.close(); } catch (Exception ignored) { }
        if (multicast != null && multicast.isHeld()) multicast.release();
        super.onStop();
    }

    /** The remote's play/pause keys go to the page once per press (WebView may not pass media keys on, or pass them
     *  twice through the media session). */
    @Override public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        String act = TvFiles.mediaAction(e.getKeyCode());
        if (act == null || web == null) return super.dispatchKeyEvent(e);
        if (e.getAction() == android.view.KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0)
            web.evaluateJavascript("window.SHTV&&SHTV.media&&SHTV.media(" + Assets.quote(act) + ")", null);
        return true;
    }

    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("!!(window.SHTV&&SHTV.back())", v -> { if (!"true".equals(v)) TvActivity.super.onBackPressed(); });
    }

    private void toPage(String js) { runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); }); }

    // ------------------------------------------------------------ the phone's pitch (UDP)
    private void listen() {
        try {
            DatagramSocket s = new DatagramSocket(null);
            s.setReuseAddress(true);
            s.setBroadcast(true);
            s.bind(new InetSocketAddress(TvFiles.PITCH_PORT));
            udp = s;
            if (!running) { s.close(); return; } // the app left the screen while this was starting
            byte[] buf = new byte[600];
            while (running) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                s.receive(p);
                if (p.getLength() > 512) continue;
                String msg = new String(p.getData(), p.getOffset(), p.getLength(), StandardCharsets.UTF_8);
                if (TvFiles.isHello(msg)) {
                    byte[] r = TvFiles.helloReply(Build.MODEL, ip()).getBytes(StandardCharsets.UTF_8);
                    try { s.send(new DatagramPacket(r, r.length, p.getAddress(), p.getPort())); } catch (Exception ignored) { }
                }
                toPage("window.SHTV&&SHTV.message(" + Assets.quote(msg) + ")");
            }
        } catch (Exception e) {
            if (running) toPage("window.SHTV&&SHTV.problem&&SHTV.problem(" + Assets.quote("The TV couldn't listen for the phone: " + e.getMessage()) + ")");
        }
    }

    /** This TV's address on the home network (the phone and the PC need it). */
    static String ip() {
        try {
            java.util.List<String[]> found = new java.util.ArrayList<>();
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) if (a instanceof Inet4Address && a.isSiteLocalAddress()) found.add(new String[]{ni.getName(), a.getHostAddress()});
            }
            return TvFiles.pickIp(found); // Wi-Fi / Ethernet, never a Wi-Fi Direct address the phone can't reach
        } catch (Exception ignored) { }
        return "";
    }

    // ------------------------------------------------------------ the page's files and the songs folder
    private WebResourceResponse serve(String urlPath, Map<String, String> req) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        String p = urlPath == null ? "" : urlPath;
        if (p.equals("/songs/index.json")) {
            byte[] b = TvFiles.index(songs.list()).getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse("application/json", "UTF-8", 200, "OK", h, new ByteArrayInputStream(b));
        }
        if (p.startsWith("/songs/")) {
            String name = p.substring(7); // WebView has already decoded the path
            if (TvFiles.safeName(name) != null && TvFiles.safeName(name).equals(name)) {
                File f = new File(songs, name);
                try {
                    if (f.isFile()) {
                        String mime = TvFiles.mime(name);
                        long size = f.length();
                        h.put("Accept-Ranges", "bytes");
                        String rh = null;
                        if (req != null) for (Map.Entry<String, String> e : req.entrySet()) if ("range".equalsIgnoreCase(e.getKey())) rh = e.getValue();
                        long[] rg = TvFiles.range(rh, size);
                        FileInputStream in = new FileInputStream(f);
                        if (rg == null) {
                            h.put("Content-Length", String.valueOf(size));
                            return new WebResourceResponse(mime, Assets.isText(mime) ? "UTF-8" : null, 200, "OK", h, in);
                        }
                        long skip = rg[0];
                        while (skip > 0) { long n = in.skip(skip); if (n <= 0) break; skip -= n; }
                        h.put("Content-Range", "bytes " + rg[0] + "-" + rg[1] + "/" + size);
                        h.put("Content-Length", String.valueOf(rg[1] - rg[0] + 1));
                        return new WebResourceResponse(mime, Assets.isText(mime) ? "UTF-8" : null, 206, "Partial Content", h, new Limited(in, rg[1] - rg[0] + 1));
                    }
                } catch (Exception ignored) { }
            }
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0]));
        }
        String a = Assets.path(p);
        if (a != null) {
            try {
                InputStream in = getAssets().open(a);
                String mime = Assets.mime(a);
                return new WebResourceResponse(mime, Assets.isText(mime) ? "UTF-8" : null, 200, "OK", h, in);
            } catch (Exception ignored) { }
        }
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", h, new ByteArrayInputStream(new byte[0]));
    }

    // ------------------------------------------------------------ adding songs from a PC browser (HTTP, port 47322)
    private void uploads() {
        try {
            ServerSocket ss = new ServerSocket();
            ss.setReuseAddress(true);
            ss.bind(new InetSocketAddress(TvFiles.UPLOAD_PORT));
            http = ss;
            if (!running) { ss.close(); return; }
            while (running) {
                final Socket c = ss.accept();
                new Thread(() -> handle(c), "upload").start();
            }
        } catch (Exception ignored) { }
    }

    private void handle(Socket c) {
        try (Socket sock = c; InputStream in = sock.getInputStream(); OutputStream out = new BufferedOutputStream(sock.getOutputStream())) {
            sock.setSoTimeout(30000);
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) return;
            String method = req[0], target = req[1], route = TvFiles.route(target);
            long len = -1;
            String host = null;
            for (String l : lines) {
                String low = l.toLowerCase(Locale.ROOT);
                if (low.startsWith("content-length:")) try { len = Long.parseLong(l.substring(15).trim()); } catch (Exception ignored) { }
                if (low.startsWith("host:")) host = l.substring(5).trim();
            }
            if (!TvFiles.hostOk(host, ip())) { refuse(sock, in, out, len, 403, "{\"error\":\"Open this page by the TV's address\"}"); return; }
            if ("GET".equals(method) && "/".equals(route)) { reply(out, 200, "text/html; charset=utf-8", UPLOAD_PAGE); return; }
            synchronized (this) {
                long wait = lockedUntil - System.currentTimeMillis();
                if (wait > 0) { refuse(sock, in, out, len, 429, "{\"error\":\"Too many wrong codes: try again in " + (wait / 1000 + 1) + " s\"}"); return; }
                String given = TvFiles.query(target, "code");
                if (!TvFiles.isGuess(given)) { refuse(sock, in, out, len, 403, "{\"error\":\"Type the code shown on the TV\"}"); return; }
                if (!TvFiles.codeOk(given, code)) {
                    wrongCodes++;
                    lockedUntil = System.currentTimeMillis() + TvFiles.lockoutMs(wrongCodes);
                    refuse(sock, in, out, len, 403, "{\"error\":\"Wrong code: use the one on the TV\"}");
                    return;
                }
                wrongCodes = 0;
            }
            if ("GET".equals(method) && "/list".equals(route)) { reply(out, 200, "application/json", TvFiles.index(songs.list())); return; }
            if ("PUT".equals(method) && "/upload".equals(route)) {
                String name = TvFiles.safeName(TvFiles.query(target, "name"));
                if (name == null) { refuse(sock, in, out, len, 400, "{\"error\":\"Only UltraStar .txt, audio (.mp3 .m4a .ogg .opus .wav .flac .webm) and pictures\"}"); return; }
                if (len < 0 || len > TvFiles.MAX_UPLOAD) { refuse(sock, in, out, len, 400, "{\"error\":\"Too big (200 MB at most)\"}"); return; }
                File part = new File(songs, ".part-" + Thread.currentThread().getId());
                boolean saved = false;
                try {
                    try (OutputStream f = new FileOutputStream(part)) {
                        byte[] b = new byte[65536];
                        long left = len;
                        while (left > 0) {
                            int n = in.read(b, 0, (int) Math.min(b.length, left));
                            if (n < 0) throw new java.io.IOException("cut off");
                            f.write(b, 0, n); left -= n;
                        }
                    }
                    File dest = new File(songs, name);
                    if (dest.exists() && !dest.delete()) { reply(out, 500, "application/json", "{\"error\":\"Couldn't replace the old file\"}"); return; }
                    if (!part.renameTo(dest)) { reply(out, 500, "application/json", "{\"error\":\"Couldn't save\"}"); return; }
                    saved = true;
                } finally {
                    if (!saved) part.delete(); // a cut-off upload leaves nothing behind
                }
                reply(out, 200, "application/json", "{\"ok\":true,\"name\":" + Assets.quote(name) + "}");
                toPage("window.SHTV&&SHTV.songsChanged&&SHTV.songsChanged()");
                return;
            }
            reply(out, 404, "text/plain", "Not found");
        } catch (Exception ignored) { }
    }

    /** An error answer before the upload was read: answer, then read (and drop) a little of the rest so the browser
     *  gets the message instead of a reset connection. */
    private static void refuse(Socket sock, InputStream in, OutputStream out, long len, int status, String json) throws java.io.IOException {
        reply(out, status, "application/json", json);
        try {
            sock.shutdownOutput();
            sock.setSoTimeout(2000);
            long left = len < 0 ? 0 : Math.min(len, 8L * 1024 * 1024);
            byte[] b = new byte[65536];
            while (left > 0) { int n = in.read(b, 0, (int) Math.min(b.length, left)); if (n < 0) break; left -= n; }
        } catch (Exception ignored) { }
    }

    /** A song file from a point on, cut off after `left` bytes (for Range requests). */
    static final class Limited extends java.io.FilterInputStream {
        private long left;
        Limited(InputStream in, long left) { super(in); this.left = left; }
        @Override public int read() throws java.io.IOException { if (left <= 0) return -1; int c = super.read(); if (c >= 0) left--; return c; }
        @Override public int read(byte[] b, int off, int len) throws java.io.IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    private static String readHead(InputStream in) throws java.io.IOException {
        StringBuilder b = new StringBuilder();
        int c, n = 0;
        while ((c = in.read()) >= 0) {
            b.append((char) c);
            if (++n > 16384) return null;
            int L = b.length();
            if (L >= 4 && b.charAt(L - 4) == '\r' && b.charAt(L - 3) == '\n' && b.charAt(L - 2) == '\r' && b.charAt(L - 1) == '\n') return b.substring(0, L - 4);
        }
        return null;
    }

    private static void reply(OutputStream out, int status, String type, String body) throws java.io.IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        String h = "HTTP/1.1 " + status + (status == 200 ? " OK" : " Error") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + b.length + "\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8)); out.write(b); out.flush();
    }

    class Bridge {
        /** For the page: where the phone and the PC find this TV, and the code for adding songs. */
        @JavascriptInterface public String info() {
            String ip = ip();
            return "{\"ip\":" + Assets.quote(ip) + ",\"port\":" + TvFiles.PITCH_PORT + ",\"upload\":" + Assets.quote(ip.isEmpty() ? "" : "http://" + ip + ":" + TvFiles.UPLOAD_PORT + "/") + ",\"code\":" + Assets.quote(code) + ",\"name\":" + Assets.quote(Build.MODEL) + "}";
        }
    }

    /** The page a PC browser gets at http://<TV>:47322/: pick files, type the code from the TV, send. */
    static final String UPLOAD_PAGE = "<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        + "<title>Add songs to the TV</title><style>body{font:16px system-ui,sans-serif;max-width:40em;margin:2em auto;padding:0 1em;background:#0b1020;color:#f4f6ff}"
        + "input,button{font:inherit;padding:.4em .7em;margin:.3em 0}button{background:#7c8cff;color:#fff;border:0;border-radius:.4em}li{margin:.2em 0}.no{color:#f87171}.ok{color:#34d399}</style></head><body>"
        + "<h1>Add songs to Singing Helper TV</h1><p>Pick an UltraStar chart (.txt) and its audio file (the name in the chart's #MP3 line), "
        + "only from songs you own. They appear in the TV's song list straight away.</p>"
        + "<p><label>Code on the TV: <input id=code inputmode=numeric size=6 autocomplete=off></label></p>"
        + "<p><input id=files type=file multiple accept='.txt,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,.webm,.jpg,.jpeg,.png'></p>"
        + "<p><button id=send>Send to the TV</button></p><ul id=log></ul><h2>On the TV</h2><ul id=list><li>Type the code to see them.</li></ul>"
        + "<script>const $=id=>document.getElementById(id);const log=(t,ok)=>{const li=document.createElement('li');li.textContent=t;li.className=ok?'ok':'no';$('log').appendChild(li)};"
        + "async function list(){const r=await fetch('list?code='+encodeURIComponent($('code').value));if(!r.ok)return;const a=await r.json();"
        + "$('list').innerHTML='';for(const s of a){const li=document.createElement('li');li.textContent=decodeURIComponent(s.txt.replace(/^songs\\//,''));$('list').appendChild(li)}}"
        + "$('code').oninput=()=>{if($('code').value.length===4)list()};"
        + "$('send').onclick=async()=>{const c=await fetch('list?code='+encodeURIComponent($('code').value));if(!c.ok){let m='Wrong code';try{m=(await c.json()).error}catch(e){}log(m,false);return}"
        + "for(const f of $('files').files){try{const r=await fetch('upload?name='+encodeURIComponent(f.name)+'&code='+encodeURIComponent($('code').value),{method:'PUT',body:f});"
        + "const j=await r.json();log(r.ok?'Sent '+j.name:f.name+': '+j.error,r.ok)}catch(e){log(f.name+': '+e.message,false)}}list()};</script></body></html>";
}
