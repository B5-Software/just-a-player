package org.b5_software.justaplayer;

import android.content.*;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/** Consume granted content URIs before their temporary read permission expires. */
final class OpenedMusic {
  final MainActivity activity;
  final List<String> pending = new ArrayList<>();
  final ExecutorService io = Executors.newSingleThreadExecutor();

  OpenedMusic(MainActivity activity) {
    this.activity = activity;
  }

  synchronized org.json.JSONArray take() {
    org.json.JSONArray out = new org.json.JSONArray(pending);
    pending.clear();
    return out;
  }

  void receive(Intent intent) {
    if (!Intent.ACTION_VIEW.equals(intent.getAction())
        && !Intent.ACTION_SEND.equals(intent.getAction())
        && !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) return;
    List<Uri> uris = new ArrayList<>();
    if (intent.getData() != null) uris.add(intent.getData());
    if (intent.getClipData() != null)
      for (int n = 0; n < intent.getClipData().getItemCount() && n < 1000; n++) {
        Uri uri = intent.getClipData().getItemAt(n).getUri();
        if (uri != null && !uris.contains(uri)) uris.add(uri);
      }
    io.execute(
        () -> {
          List<String> files = new ArrayList<>();
          for (Uri uri : uris)
            try {
              if ("file".equals(uri.getScheme())) {
                File file = new File(uri.getPath());
                if (file.isFile() && file.getName().matches(AppBridge.AUDIO))
                  files.add(file.getCanonicalPath());
              } else if ("content".equals(uri.getScheme())) {
                String name = "";
                try (Cursor cursor =
                    activity
                        .getContentResolver()
                        .query(
                            uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                  if (cursor != null && cursor.moveToFirst()) name = cursor.getString(0);
                }
                if (!name.matches(AppBridge.AUDIO)) {
                  String type = activity.getContentResolver().getType(uri);
                  String ext =
                      android.webkit.MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
                  if (ext != null) name = name + "." + ext;
                }
                name = new File(name).getName();
                if (!name.matches(AppBridge.AUDIO)) throw new IOException("不支持的音乐文件：" + name);
                String key =
                    AppBridge.hash(uri.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8))
                        .substring(0, 20);
                File directory = new File(activity.getExternalFilesDir(null), "Opened/" + key);
                directory.mkdirs();
                File target = new File(directory, name), staged = new File(directory, "import.tmp");
                try (InputStream input = activity.getContentResolver().openInputStream(uri);
                    OutputStream output = new FileOutputStream(staged)) {
                  if (input == null) throw new IOException("无法读取文件");
                  byte[] buffer = new byte[65536];
                  int n;
                  long total = 0;
                  while ((n = input.read(buffer)) >= 0) {
                    total += n;
                    if (total > 32L * 1024 * 1024 * 1024) throw new IOException("音乐文件超过 32 GiB");
                    output.write(buffer, 0, n);
                  }
                } catch (Exception e) {
                  staged.delete();
                  throw e;
                }
                Files.move(
                    staged.toPath(),
                    target.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
                files.add(target.getCanonicalPath());
              }
            } catch (Exception e) {
              MainActivity.emit("nativeError", e.getMessage());
            }
          synchronized (this) {
            pending.addAll(files);
          }
          if (!files.isEmpty()) MainActivity.emit("openFiles", true);
        });
  }
}
