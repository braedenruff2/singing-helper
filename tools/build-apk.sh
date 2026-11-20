#!/usr/bin/env bash
# Builds dist/SingingHelper.apk (the phone app) without Gradle: aapt2 -> javac -> d8 -> zip -> zipalign -> apksigner.
#   BT=/path/to/build-tools/35.x ANDROID_JAR=/path/to/android-35/android.jar bash tools/build-apk.sh
# The web app files (the same ones the PC uses) go into assets/www. The signing key is android/singing.keystore: made
# once, kept on the PC, never in git (updates only install over the old app when they're signed with the same key).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
: "${BT:?set BT to an Android build-tools folder (aapt2, zipalign, lib/d8.jar, lib/apksigner.jar)}"
: "${ANDROID_JAR:?set ANDROID_JAR to platforms/android-35/android.jar}"
OUT=$ROOT/build
CODE=${SH_CODE:-$(( 10000000 + ($(date -u +%s) - 1767225600) / 60 ))}  # minutes since 2026-01-01, always increasing
NAME=${SH_NAME:-0.1.$(date -u +%Y%m%d.%H%M)}
KS=$ROOT/android/singing.keystore
PASS=singinghelper   # a personal sideload key, not a secret
WEB="index.html app.js lyrics.js melody.js pitch-worklet.js spotify.js icon.svg manifest.webmanifest examples"
rm -rf "$OUT"; mkdir -p "$OUT"/{gen,classes,dex,stage/assets/www}
echo "- resources ($NAME, code $CODE)"
"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2" link -I "$ANDROID_JAR" --manifest android/AndroidManifest.xml --java "$OUT/gen" \
  -o "$OUT/base.apk" "$OUT/res.zip" --version-code "$CODE" --version-name "$NAME" --replace-version
echo "- java"
find android/src "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
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
if [ ! -e "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" -alias sing -keyalg RSA -keysize 2048 \
    -validity 20000 -dname "CN=Singing Helper" >/dev/null
  echo "- made a new signing key: android/singing.keystore (keep it; never put it in git)"
fi
mkdir -p dist
java -jar "$BT/lib/apksigner.jar" sign --ks "$KS" --ks-pass pass:$PASS --key-pass pass:$PASS --out dist/SingingHelper.apk "$OUT/aligned.apk"
java -jar "$BT/lib/apksigner.jar" verify dist/SingingHelper.apk
echo "$NAME" > dist/version.txt
printf '{"code": %s, "name": "%s", "size": %s}\n' "$CODE" "$NAME" "$(stat -c %s dist/SingingHelper.apk)" > dist/version.json
ls -la dist/SingingHelper.apk
