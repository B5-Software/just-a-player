package org.b5_software.justaplayer;

import android.content.Context;
import java.io.*;
import java.nio.file.*;

/** Stream the bundled lossless bank off the UI thread; no run-time download. */
final class MidiResources {
  static synchronized File ensure(Context context) throws IOException {
    File dir = new File(context.getFilesDir(), "soundfonts");
    dir.mkdirs();
    File target = new File(dir, "MuseScore_General_HQ.sf2");
    if (!BuildConfig.BUNDLED_MIDI) {
      Files.deleteIfExists(target.toPath());
      return null;
    }
    if (target.length() == 489517354L) return target;
    File staged = new File(dir, "default.tmp");
    try (InputStream input = context.getAssets().open("soundfonts/MuseScore_General_HQ.sf2");
        OutputStream output = new FileOutputStream(staged)) {
      byte[] buffer = new byte[65536];
      int n;
      while ((n = input.read(buffer)) >= 0) output.write(buffer, 0, n);
    }
    Files.move(
        staged.toPath(),
        target.toPath(),
        StandardCopyOption.REPLACE_EXISTING,
        StandardCopyOption.ATOMIC_MOVE);
    return target;
  }
}
