package app.singinghelper;

/**
 * Plain-Java helpers (no Android classes, so they're tested on the JVM): which bundled file a page request maps to,
 * its MIME type, and tiny JSON readers for version.json.
 * The page is served from https://appassets.androidplatform.net/ (intercepted, never fetched from the internet): a
 * secure origin, so the microphone, AudioWorklet and fetch() work as on the PC, and Spotify can send you back to it.
 */
final class Assets {
    private Assets() { }
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST + "/";

    /** "www/..." for a request path, or null if it tries to leave the bundled folder. "/" is the app's start page. */
    static String path(String urlPath) {
        String p = urlPath == null ? "" : urlPath;
        int q = p.indexOf('?'); if (q >= 0) p = p.substring(0, q);
        int h = p.indexOf('#'); if (h >= 0) p = p.substring(0, h);
        while (p.startsWith("/")) p = p.substring(1);
        if (p.isEmpty()) p = "index.html";
        if (p.indexOf('\\') >= 0 || p.indexOf('\0') >= 0) return null;
        for (String seg : p.split("/", -1)) if (seg.equals("..") || seg.equals(".") || seg.isEmpty()) return null;
        return "www/" + p;
    }

    static String mime(String path) {
        String p = path.toLowerCase(java.util.Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".txt")) return "text/plain";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
    static boolean isText(String mime) { return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml"); }

    /** Pages the app may show itself: its own files and Spotify's login. Everything else opens in the browser. */
    static boolean staysInApp(String host) {
        if (host == null) return false;
        String h = host.toLowerCase(java.util.Locale.ROOT);
        return h.equals(HOST) || h.equals("accounts.spotify.com") || h.equals("challenge.spotify.com") || h.equals("www.spotify.com");
    }

    static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 32 || c == 0x2028 || c == 0x2029) b.append(String.format("\\u%04x", (int) c));
            else b.append(c);
        }
        return b.append('"').toString();
    }
    /** The number after "key": in a small flat JSON object, or "" */
    static String num(String json, String key) {
        if (json == null) return "";
        int i = json.indexOf("\"" + key + "\""); if (i < 0) return "";
        i = json.indexOf(':', i); if (i < 0) return "";
        int j = i + 1; while (j < json.length() && json.charAt(j) == ' ') j++;
        int k = j; while (k < json.length() && (Character.isDigit(json.charAt(k)) || json.charAt(k) == '-')) k++;
        return json.substring(j, k);
    }
    /** The string after "key": (no escapes needed for version names), or null */
    static String str(String json, String key) {
        if (json == null) return null;
        int i = json.indexOf("\"" + key + "\""); if (i < 0) return null;
        i = json.indexOf(':', i); if (i < 0) return null;
        int a = json.indexOf('"', i + 1); if (a < 0) return null;
        int b = json.indexOf('"', a + 1); if (b < 0) return null;
        return json.substring(a + 1, b);
    }
    /** version.json's code, or -1 if it isn't one. */
    static long code(String json) {
        try { long c = Long.parseLong(num(json, "code")); return c > 0 ? c : -1; } catch (NumberFormatException e) { return -1; }
    }
    /** The bridge answers only our own page (appassets), never a page loaded in the app such as the Spotify login. */
    /* One permission's answer in onRequestPermissionsResult: 1 granted, -1 refused, 0 not in this answer (or cut short). */
    static int answered(String[] perms, int[] res, String name) {
        if (perms == null || res == null) return 0;
        for (int i = 0; i < perms.length && i < res.length; i++) if (name.equals(perms[i])) return res[i] == 0 ? 1 : -1; // 0 = PERMISSION_GRANTED
        return 0;
    }
    static boolean ownPage(String host) { return host != null && HOST.equalsIgnoreCase(host); }
    /** A downloaded update is this app and exactly the version version.json named (a stale cached APK is not). */
    static boolean updateChecksOut(String pkg, String ours, long gotCode, long wantCode) { return ours != null && ours.equals(pkg) && gotCode == wantCode; }
    /** That version is already downloaded and waiting to install: no need to fetch it again. */
    static boolean alreadyHave(int readyCode, long code, boolean fileExists) { return readyCode > 0 && readyCode == code && fileExists; }
}
