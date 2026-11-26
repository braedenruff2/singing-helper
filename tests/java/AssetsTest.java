package app.singinghelper;

/** Plain-JVM checks of the phone app's Assets helpers (run by tests/java.cjs). */
public class AssetsTest {
    static int fails = 0;
    static void check(String label, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + label); if (!ok) fails++; }
    public static void main(String[] a) {
        check("start page", "www/index.html".equals(Assets.path("/")) && "www/index.html".equals(Assets.path("")) && "www/index.html".equals(Assets.path(null)));
        check("Spotify's way back (?code=) is the start page", "www/index.html".equals(Assets.path("/index.html?code=abc&state=x")));
        check("files and folders", "www/app.js".equals(Assets.path("/app.js")) && "www/examples/echo.txt".equals(Assets.path("/examples/echo.txt")));
        check("never outside the bundled folder", Assets.path("/../AndroidManifest.xml") == null && Assets.path("/examples/../../x") == null
            && Assets.path("/a//b") == null && Assets.path("/a\\b") == null && Assets.path("/./app.js") == null);
        check("mime types (worklet and modules as JavaScript)", Assets.mime("www/pitch-worklet.js").equals("text/javascript") && Assets.mime("www/index.html").equals("text/html")
            && Assets.mime("www/examples/echo.txt").equals("text/plain") && Assets.mime("www/icon.svg").equals("image/svg+xml") && Assets.mime("www/x.bin").equals("application/octet-stream"));
        check("only the app and Spotify login stay in the app", Assets.staysInApp("appassets.androidplatform.net") && Assets.staysInApp("accounts.spotify.com")
            && !Assets.staysInApp("evil.example") && !Assets.staysInApp("accounts.spotify.com.evil.example") && !Assets.staysInApp(null));
        check("version.json code", Assets.code("{\"code\": 10466128, \"name\": \"0.1.x\", \"size\": 5}") == 10466128 && Assets.code("{}") == -1 && Assets.code("{\"code\": 0}") == -1 && Assets.code(null) == -1);
        check("version.json name", "0.1.x".equals(Assets.str("{\"code\": 1, \"name\": \"0.1.x\"}", "name")) && Assets.str("{}", "name") == null);
        check("quote escapes for the page", Assets.quote("a\"b\\c\nd ").equals("\"a\\\"b\\\\c\\u000ad\\u2028\"") && Assets.quote(null).equals("null"));
        check("the bridge answers only our own page", Assets.ownPage("appassets.androidplatform.net") && Assets.ownPage("APPASSETS.androidplatform.net")
            && !Assets.ownPage("accounts.spotify.com") && !Assets.ownPage(null) && !Assets.ownPage("appassets.androidplatform.net.evil.example"));
        check("an update must be exactly the version announced", Assets.updateChecksOut("app.singinghelper", "app.singinghelper", 30474022L, 30474022L)
            && !Assets.updateChecksOut("app.singinghelper", "app.singinghelper", 30470000L, 30474022L) && !Assets.updateChecksOut("other.app", "app.singinghelper", 5, 5)
            && !Assets.updateChecksOut(null, "app.singinghelper", 5, 5));
        check("a waiting update isn't fetched again", Assets.alreadyHave(7, 7L, true) && !Assets.alreadyHave(7, 7L, false) && !Assets.alreadyHave(6, 7L, true) && !Assets.alreadyHave(0, 0L, true));
        check("TV pitch only to home-network addresses", Assets.lanIp("192.168.1.50") && Assets.lanIp("10.0.0.7") && Assets.lanIp("172.20.3.4")
            && !Assets.lanIp("8.8.8.8") && !Assets.lanIp("172.32.0.1") && !Assets.lanIp("192.168.1.255") && !Assets.lanIp("192.168.1.0") && !Assets.lanIp("192.168.1.300")
            && !Assets.lanIp("192.168.1") && !Assets.lanIp("tv.local") && !Assets.lanIp(null) && !Assets.lanIp("192.168.1.5 ") && !Assets.lanIp("127.0.0.1"));
        String[] two = {"android.permission.RECORD_AUDIO", "android.permission.BLUETOOTH_CONNECT"};
        check("each permission's own answer (mic + Nearby devices asked together)", Assets.answered(two, new int[]{0, -1}, "android.permission.RECORD_AUDIO") == 1
            && Assets.answered(two, new int[]{0, -1}, "android.permission.BLUETOOTH_CONNECT") == -1
            && Assets.answered(new String[]{"android.permission.BLUETOOTH_CONNECT"}, new int[]{0}, "android.permission.RECORD_AUDIO") == 0
            && Assets.answered(two, new int[]{}, "android.permission.RECORD_AUDIO") == 0 && Assets.answered(null, null, "x") == 0);
        System.out.println(fails == 0 ? "java: passed" : "java: " + fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
