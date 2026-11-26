#!/usr/bin/env bash
# Builds dist/SingingHelperTV.apk (the Fire TV karaoke app) like tools/build-apk.sh builds the phone app:
#   BT=/path/to/build-tools/35.x ANDROID_JAR=/path/to/android-35/android.jar bash tools/build-tv-apk.sh
# Same signing key as the phone app (android/singing.keystore, or SH_KEYSTORE=<path>); it never makes a new one.
# Web files: tv.html and what it loads. Android side: android-tv/ (+ the phone app's icons, theme and Assets.java).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
: "${BT:?set BT to an Android build-tools folder (aapt2, zipalign, lib/d8.jar, lib/apksigner.jar)}"
: "${ANDROID_JAR:?set ANDROID_JAR to platforms/android-35/android.jar}"
OUT=$ROOT/build/tv
CODE=${SH_CODE:-$(( 10000000 + ($(date -u +%s) - 1767225600) / 60 ))}
NAME=${SH_NAME:-0.1.$(date -u +%Y%m%d.%H%M)}
KS=${SH_KEYSTORE:-$ROOT/android/singing.keystore}
PASS=singinghelper
WEB="tv.html tv.js karaoke.js lyrics.js icon.svg examples"
[ -e "$KS" ] || { echo "No signing key at $KS (android/singing.keystore, or SH_KEYSTORE=<path>)" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"/{gen,classes,dex,stage/assets/www}
echo "- resources ($NAME, code $CODE)"
"$BT/aapt2" compile --dir android/res -o "$OUT/res-phone.zip"
"$BT/aapt2" compile --dir android-tv/res -o "$OUT/res-tv.zip"
"$BT/aapt2" link -I "$ANDROID_JAR" --manifest android-tv/AndroidManifest.xml --java "$OUT/gen" \
  -o "$OUT/base.apk" "$OUT/res-phone.zip" "$OUT/res-tv.zip" --version-code "$CODE" --version-name "$NAME" --replace-version
echo "- java"
{ find android-tv/src "$OUT/gen" -name '*.java'; echo android/src/app/singinghelper/Assets.java; } > "$OUT/sources.txt"
javac -nowarn -Xlint:-options -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR:$BT/core-lambda-stubs.jar" -classpath "$ANDROID_JAR" -d "$OUT/classes" @"$OUT/sources.txt"
echo "- dex"
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 26 --lib "$ANDROID_JAR" \
  --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
echo "- package"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
cp "$OUT/dex/classes.dex" "$OUT/stage/"
for f in $WEB; do cp -r "$f" "$OUT/stage/assets/www/"; done
( cd "$OUT/stage" && zip -q "$OUT/unsigned.apk" classes.dex && zip -q -r "$OUT/unsigned.apk" assets )
"$BT/zipalign" -P 16 -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk" 2>/dev/null || "$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
mkdir -p dist
java -jar "$BT/lib/apksigner.jar" sign --ks "$KS" --ks-pass pass:$PASS --key-pass pass:$PASS --out dist/SingingHelperTV.apk "$OUT/aligned.apk"
java -jar "$BT/lib/apksigner.jar" verify dist/SingingHelperTV.apk
printf '{"code": %s, "name": "%s", "size": %s}\n' "$CODE" "$NAME" "$(stat -c %s dist/SingingHelperTV.apk)" > dist/tv-version.json
ls -la dist/SingingHelperTV.apk
