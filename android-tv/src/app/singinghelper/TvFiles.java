package app.singinghelper;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Plain-Java helpers for the TV app (no Android classes, so they're tested on the JVM): which song files may be stored,
 * the song list the page reads (songs/index.json), their MIME types, and the bits of an HTTP request the upload server
 * needs.
 */
final class TvFiles {
    private TvFiles() { }
    static final int PITCH_PORT = 47321, UPLOAD_PORT = 47322;
    static final long MAX_UPLOAD = 200L * 1024 * 1024;
    static final String[] KINDS = {".txt", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac", ".webm", ".jpg", ".jpeg", ".png"};

    /** A file name safe to keep in the songs folder (no folders, no hidden files, a song/audio/picture type), or null. */
    static String safeName(String raw) {
        if (raw == null) return null;
        String n = raw;
        int s = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (s >= 0) n = n.substring(s + 1);
        n = n.trim();
        if (n.isEmpty() || n.startsWith(".") || n.length() > 120) return null;
        StringBuilder b = new StringBuilder();
        // by code point (an emoji is one character, as in the page's audioName), letters and decimal digits kept
        for (int i = 0; i < n.length(); ) {
            int c = n.codePointAt(i);
            i += Character.charCount(c);
            if (Character.isLetterOrDigit(c) || (c < 128 && " ._()'&,!+-".indexOf(c) >= 0)) b.appendCodePoint(c); else b.append('_');
        }
        String out = b.toString();
        String low = out.toLowerCase(Locale.ROOT);
        for (String k : KINDS) if (low.endsWith(k) && low.length() > k.length()) return out;
        return null;
    }

    static String mime(String name) {
        String p = name.toLowerCase(Locale.ROOT);
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".m4a") || p.endsWith(".aac")) return "audio/mp4";
        if (p.endsWith(".ogg") || p.endsWith(".opus")) return "audio/ogg";
        if (p.endsWith(".flac")) return "audio/flac";
        if (p.endsWith(".webm")) return "audio/webm";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        return Assets.mime(p);
    }

    /** songs/index.json for the page: every chart (.txt) in the folder, by name. */
    static String index(String[] names) {
        List<String> txt = new ArrayList<>();
        if (names != null) for (String n : names) if (n != null && safeName(n) != null && safeName(n).equals(n) && n.toLowerCase(Locale.ROOT).endsWith(".txt")) txt.add(n);
        String[] a = txt.toArray(new String[0]);
        Arrays.sort(a, String.CASE_INSENSITIVE_ORDER);
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < a.length; i++) b.append(i > 0 ? "," : "").append("{\"txt\":").append(Assets.quote("songs/" + enc(a[i]))).append('}');
        return b.append(']').toString();
    }

    static String enc(String s) {
        try { return URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; }
    }
    static String dec(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); } catch (Exception e) { return null; }
    }

    /** The value of ?key= in a request target like "/upload?name=a%20b.txt&code=1234", decoded; null if absent. */
    static String query(String target, String key) {
        if (target == null) return null;
        int q = target.indexOf('?');
        if (q < 0) return null;
        for (String kv : target.substring(q + 1).split("&")) {
            int e = kv.indexOf('=');
            String k = e < 0 ? kv : kv.substring(0, e);
            if (k.equals(key)) return e < 0 ? "" : dec(kv.substring(e + 1));
        }
        return null;
    }
    /** "/upload?x=1" -> "/upload" */
    static String route(String target) {
        if (target == null) return "";
        int q = target.indexOf('?');
        return q < 0 ? target : target.substring(0, q);
    }

    /** The code on the TV screen must match (so only someone who can see the TV adds or removes songs). */
    static boolean codeOk(String given, String code) {
        if (given == null || code == null || given.length() != code.length()) return false;
        int d = 0;
        for (int i = 0; i < code.length(); i++) d |= given.charAt(i) ^ code.charAt(i);
        return d == 0;
    }

    /** The phone asks "who's there?" ({"v":1,"type":"hello",...}): answered directly, not only passed to the page. */
    static boolean isHello(String msg) { return msg != null && msg.length() < 512 && msg.contains("\"type\":\"hello\""); }
    static String helloReply(String name, String ip) {
        return "{\"v\":1,\"type\":\"tv\",\"name\":" + Assets.quote(name) + ",\"ip\":" + Assets.quote(ip) + "}";
    }

    /** The Host a browser sent must be this TV's own address (a web page can't reach the upload page by a name it
     *  points at the TV: DNS rebinding). */
    static boolean hostOk(String host, String ip) {
        if (host == null || ip == null || ip.isEmpty()) return false;
        String h = host.trim();
        return h.equals(ip) || h.equals(ip + ":" + UPLOAD_PORT);
    }

    /** A "Range: bytes=a-b" request for a file of `size` bytes: {start, end} (inclusive), or null for the whole file
     *  (no range, one we don't understand, or one outside the file). */
    static long[] range(String header, long size) {
        if (header == null || size <= 0) return null;
        String h = header.trim();
        if (!h.startsWith("bytes=") || h.indexOf(',') >= 0) return null;
        String r = h.substring(6).trim();
        int d = r.indexOf('-');
        if (d < 0) return null;
        try {
            String a = r.substring(0, d).trim(), b = r.substring(d + 1).trim();
            long start, end;
            if (a.isEmpty()) { if (b.isEmpty()) return null; long n = Long.parseLong(b); if (n <= 0) return null; start = Math.max(0, size - n); end = size - 1; }
            else { start = Long.parseLong(a); end = b.isEmpty() ? size - 1 : Math.min(size - 1, Long.parseLong(b)); }
            if (start < 0 || start >= size || end < start) return null;
            return new long[]{start, end};
        } catch (NumberFormatException e) { return null; }
    }

    /** Wrong codes: after 5 in a row, the upload page waits (30 s, then twice as long each time). */
    static long lockoutMs(int wrong) {
        if (wrong < 5) return 0;
        return Math.min(3_600_000L, 30_000L << Math.min(7, wrong - 5));
    }
}
