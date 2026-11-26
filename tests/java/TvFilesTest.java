package app.singinghelper;

/** Plain-JVM checks of the TV app's TvFiles helpers (run by tests/java.cjs). */
public class TvFilesTest {
    static int fails = 0;
    static void check(String label, boolean ok) { System.out.println((ok ? "ok   " : "FAIL ") + label); if (!ok) fails++; }
    public static void main(String[] a) {
        check("song files keep their names", "My Song (Live).txt".equals(TvFiles.safeName("My Song (Live).txt")) && "Beyoncé - Halo.mp3".equals(TvFiles.safeName("Beyoncé - Halo.mp3")));
        check("folders in a name are dropped", "song.txt".equals(TvFiles.safeName("../../etc/song.txt")) && "song.mp3".equals(TvFiles.safeName("C:\\Users\\x\\song.mp3")));
        check("hidden, empty, no-type and other types refused", TvFiles.safeName(".hidden.txt") == null && TvFiles.safeName("") == null && TvFiles.safeName(null) == null
            && TvFiles.safeName(".txt") == null && TvFiles.safeName("run.apk") == null && TvFiles.safeName("page.html") == null && TvFiles.safeName("noext") == null);
        check("odd characters become _", "a_b_c.txt".equals(TvFiles.safeName("a:b*c.txt")) && "x_y.ogg".equals(TvFiles.safeName("x\0y.ogg")));
        StringBuilder longName = new StringBuilder(); for (int i = 0; i < 130; i++) longName.append('a');
        check("very long names refused", TvFiles.safeName(longName + ".txt") == null);
        check("audio types", TvFiles.mime("a.mp3").equals("audio/mpeg") && TvFiles.mime("a.M4A").equals("audio/mp4") && TvFiles.mime("a.opus").equals("audio/ogg")
            && TvFiles.mime("a.txt").equals("text/plain") && TvFiles.mime("a.jpg").equals("image/jpeg"));
        check("songs/index.json: charts only, sorted, names encoded",
            "[{\"txt\":\"songs/a%20song.txt\"},{\"txt\":\"songs/B.txt\"}]".equals(TvFiles.index(new String[]{"B.txt", "song.mp3", "a song.txt", ".part-3", "x.apk"})));
        check("index of an empty or missing folder", "[]".equals(TvFiles.index(new String[0])) && "[]".equals(TvFiles.index(null)));
        check("a file stored under an unsafe name isn't listed", "[]".equals(TvFiles.index(new String[]{"a:b.txt"})));
        check("query values decoded", "a b.txt".equals(TvFiles.query("/upload?name=a%20b.txt&code=1234", "name")) && "1234".equals(TvFiles.query("/upload?name=x&code=1234", "code"))
            && TvFiles.query("/upload", "code") == null && TvFiles.query("/upload?x=1", "code") == null && "".equals(TvFiles.query("/u?code", "code")) && TvFiles.query(null, "a") == null);
        check("route without the query", "/upload".equals(TvFiles.route("/upload?x=1")) && "/".equals(TvFiles.route("/")) && "".equals(TvFiles.route(null)));
        check("the code must match exactly", TvFiles.codeOk("0427", "0427") && !TvFiles.codeOk("0428", "0427") && !TvFiles.codeOk("042", "0427") && !TvFiles.codeOk(null, "0427") && !TvFiles.codeOk("04270", "0427"));
        check("hello found and answered", TvFiles.isHello("{\"v\":1,\"type\":\"hello\",\"name\":\"Pixel\"}") && !TvFiles.isHello("{\"v\":1,\"type\":\"pitch\"}") && !TvFiles.isHello(null)
            && TvFiles.helloReply("AFT\"x", "192.168.1.9").equals("{\"v\":1,\"type\":\"tv\",\"name\":\"AFT\\\"x\",\"ip\":\"192.168.1.9\"}"));
        check("upload page only by the TV's own address", TvFiles.hostOk("192.168.1.50:47322", "192.168.1.50") && TvFiles.hostOk("192.168.1.50", "192.168.1.50")
            && !TvFiles.hostOk("evil.example:47322", "192.168.1.50") && !TvFiles.hostOk(null, "192.168.1.50") && !TvFiles.hostOk("192.168.1.50:47322", ""));
        long[] r1 = TvFiles.range("bytes=0-", 1000), r2 = TvFiles.range("bytes=100-199", 1000), r3 = TvFiles.range("bytes=-100", 1000), r4 = TvFiles.range("bytes=900-5000", 1000);
        check("Range requests for seeking in songs", r1[0] == 0 && r1[1] == 999 && r2[0] == 100 && r2[1] == 199 && r3[0] == 900 && r3[1] == 999 && r4[0] == 900 && r4[1] == 999);
        check("ranges outside the file or odd ones: the whole file", TvFiles.range("bytes=1000-", 1000) == null && TvFiles.range("bytes=5-2", 1000) == null
            && TvFiles.range("bytes=0-1,5-6", 1000) == null && TvFiles.range("items=0-1", 1000) == null && TvFiles.range(null, 1000) == null && TvFiles.range("bytes=x-", 1000) == null
            && TvFiles.range("bytes=-0", 1000) == null && TvFiles.range("bytes=0-", 0) == null);
        check("wrong codes: a growing wait after 5", TvFiles.lockoutMs(4) == 0 && TvFiles.lockoutMs(5) == 30_000 && TvFiles.lockoutMs(6) == 60_000 && TvFiles.lockoutMs(100) == 3_600_000);
        System.out.println(fails == 0 ? "java (TV): passed" : "java (TV): " + fails + " FAILED");
        System.exit(fails == 0 ? 0 : 1);
    }
}
