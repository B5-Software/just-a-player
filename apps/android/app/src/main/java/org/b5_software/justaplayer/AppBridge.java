package org.b5_software.justaplayer;

import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.hardware.usb.*;
import android.os.*;
import android.util.*;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

/** Only installed in the trusted, offline appassets origin. Never on remote pages. */
final class AppBridge {
  final MainActivity activity;
  final ExecutorService io =
      Executors.newSingleThreadExecutor(r -> new Thread(r, "jap-android-files"));
  final android.content.SharedPreferences prefs;
  final Set<String> writes = ConcurrentHashMap.newKeySet();
  static final Map<String, UsbDeviceConnection> usbConnections = new ConcurrentHashMap<>();
  static boolean usbReceiverInstalled;
  final File music;
  final boolean exporting;

  AppBridge(MainActivity a) {
    this(a, false);
  }

  AppBridge(MainActivity a, boolean exporting) {
    activity = a;
    this.exporting = exporting;
    prefs = a.getSharedPreferences("player", 0);
    music = new File(a.getExternalFilesDir(null), "Music");
    music.mkdirs();
    installUsbReceiver(a.getApplicationContext());
  }

  void close() {
    if (exporting) io.shutdownNow();
    else io.shutdown();
  }

  static Object nullable(Object value) {
    return value == null ? JSONObject.NULL : value;
  }

  @JavascriptInterface
  public String snapshot() {
    try {
      return new JSONObject()
          .put("surface", exporting ? "export" : "main")
          .put("settings", new JSONObject(prefs.getString("settings", "{}")))
          .put("fonts", new JSONArray(prefs.getString("fonts", "[]")))
          .put("version", BuildConfig.VERSION_NAME)
          .put("viewport", activity.viewportInfo())
          .put("bundledMidi", BuildConfig.BUNDLED_MIDI)
          .put("qa", BuildConfig.DEBUG && activity.getIntent().getBooleanExtra("e2e", false))
          .put(
              "qaWindow",
              BuildConfig.DEBUG
                  ? new JSONObject()
                      .put("visible", MainActivity.visible)
                      .put(
                          "playing",
                          PlaybackService.instance != null && PlaybackService.instance.playingState)
                      .put("flags", activity.getWindow().getAttributes().flags)
                      .put("rootHold", activity.root != null && activity.root.getKeepScreenOn())
                      .put("webHold", activity.web != null && activity.web.getKeepScreenOn())
                  : JSONObject.NULL)
          .put("hdr", activity.displayInfo())
          .toString();
    } catch (Exception e) {
      return "{}";
    }
  }

  void emit(String key, Object value) {
    if (exporting) activity.emitExport(key, value);
    else MainActivity.emit(key, value);
  }

  @JavascriptInterface
  public void engine(String message) {
    final String prepared;
    try {
      JSONObject request = new JSONObject(message);
      if (request.optString("kind").equals("offline")
          && (request.optString("action").equals("original")
              || (request.optString("action").equals("open") && request.optBoolean("writeAudio"))))
        request.put(
            "audioPath",
            activity.video.tempAudio(
                request.optString("action").equals("original") ? "original" : "wav"));
      prepared = request.toString();
    } catch (Exception e) {
      emit("nativeError", e.getMessage());
      return;
    }
    PlaybackService s = PlaybackService.instance;
    if (!exporting && s != null) s.send(prepared);
    else
      io.execute(
          () -> {
            try {
              JSONObject request = new JSONObject(prepared);
              if (exporting && request.optString("kind").equals("command")) return;
              String r = Native.message(request.toString());
              JSONObject v = new JSONObject(r);
              if (v.has("kind")) emit("engine", v);
            } catch (Exception e) {
              emit("nativeError", e.getMessage());
            }
          });
  }

  @JavascriptInterface
  public void flushLibrary(String json) {
    if (json.length() <= 24 * 1024 * 1024)
      io.execute(
          () -> {
            try {
              atomic(
                  new File(activity.getFilesDir(), "library.json"),
                  json.getBytes(StandardCharsets.UTF_8));
            } catch (Exception e) {
              MainActivity.emit("nativeError", e.getMessage());
            }
          });
  }

  @JavascriptInterface
  public void request(int id, String method, String payload) {
    io.execute(
        () -> {
          try {
            Object value = call(method, new JSONObject(payload));
            emit("rpc", new JSONObject().put("id", id).put("value", nullable(value)));
          } catch (Exception e) {
            try {
              emit(
                  "rpc",
                  new JSONObject()
                      .put("id", id)
                      .put("error", e.getMessage() == null ? e.toString() : e.getMessage()));
            } catch (Exception ignored) {
            }
          }
        });
  }

  Object call(String method, JSONObject p) throws Exception {
    switch (method) {
      case "nativeHdrTest":
        if (!BuildConfig.DEBUG || !activity.getIntent().getBooleanExtra("e2e", false) || exporting)
          throw new IOException("Native shader QA is unavailable");
        return HdrSurface.validate(p);
      case "nativeHdr":
        return activity.configureHdr(p.optBoolean("enabled"));
      case "hdrScene":
        {
          HdrSurface surface = activity.hdrSurface;
          if (surface == null) return false;
          surface.offer(p);
          return true;
        }
      case "takeOpenFiles":
        return activity.takeOpenFiles();
      case "importSoundfont":
        {
          File source = new File(p.getString("path"));
          byte[] header = new byte[12];
          try (InputStream input = new FileInputStream(source)) {
            if (input.read(header) != 12
                || !new String(header, 0, 4, StandardCharsets.US_ASCII).equals("RIFF")
                || !new String(header, 8, 4, StandardCharsets.US_ASCII).equals("sfbk"))
              throw new IOException("请选择有效的 SF2 音色库");
          }
          if (source.length() > 1024L * 1024 * 1024) throw new IOException("音色库超过 1 GiB");
          File dir = new File(activity.getFilesDir(), "soundfonts");
          dir.mkdirs();
          File target =
              new File(
                  dir,
                  "user-"
                      + hash(source.getCanonicalPath().getBytes(StandardCharsets.UTF_8))
                      + "-"
                      + source.getName());
          if (!source.getCanonicalPath().equals(target.getCanonicalPath()))
            Files.copy(source.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
          return target.getCanonicalPath();
        }
      case "videoEnqueue":
        return activity.video.enqueue(p);
      case "videoQueue":
        return activity.video.queue();
      case "videoWorkerReady":
        activity.video.ready();
        return null;
      case "videoProgress":
        activity.video.progress(p);
        return null;
      case "videoCancelJob":
        activity.video.cancelJob(p.getString("id"));
        return null;
      case "videoStart":
        return activity.video.start(p);
      case "videoFrame":
        activity.video.frame(p.getString("id"), p.getString("data"));
        return null;
      case "videoFinish":
        return activity.video.finish(p.getString("id"), p.getString("audioPath"));
      case "videoCancel":
        activity.video.cancel(p.getString("id"));
        return null;
      case "browse":
        return browse(p.optString("path", music.getAbsolutePath()));
      case "permission":
        activity.mediaPermission();
        return true;
      case "settings":
        {
          JSONObject s = new JSONObject(prefs.getString("settings", "{}"));
          JSONObject patch = p.getJSONObject("patch");
          for (Iterator<String> it = patch.keys(); it.hasNext(); ) {
            String k = it.next();
            s.put(k, patch.get(k));
          }
          if (!exporting) {
            prefs.edit().putString("settings", s.toString()).apply();
            activity.applyPlaybackWindow();
          }
          return s;
        }
      case "musicFolders":
        return new JSONArray()
            .put(music.getAbsolutePath())
            .put(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)
                    .getAbsolutePath())
            .put(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                    .getAbsolutePath());
      case "scan":
        {
          LinkedHashSet<String> paths = new LinkedHashSet<>();
          JSONArray roots = p.getJSONArray("paths");
          for (int n = 0; n < roots.length(); n++)
            scan(new File(roots.getString(n)), p.optBoolean("recursive"), paths, 0);
          return new JSONArray(paths);
        }
      case "pathsExist":
        {
          JSONArray out = new JSONArray(), paths = p.getJSONArray("paths");
          for (int n = 0; n < paths.length(); n++) out.put(new File(paths.getString(n)).isFile());
          return out;
        }
      case "readFile":
        return read(new File(p.getString("path")), 64 * 1024 * 1024);
      case "sidecarLyrics":
        {
          File f = sidecar(p.getString("path"), new String[] {"lrc", "txt"});
          return f == null ? null : read(f, 4 * 1024 * 1024);
        }
      case "sidecarCover":
        {
          String path = p.getString("path");
          File f = sidecar(path, new String[] {"jpg", "jpeg", "png", "webp"});
          if (f == null) {
            File parent = new File(path).getParentFile();
            for (String name : new String[] {"cover.jpg", "cover.png", "folder.jpg", "front.jpg"}) {
              File test = new File(parent, name);
              if (test.isFile()) {
                f = test;
                break;
              }
            }
          }
          if (f == null) return null;
          return new JSONObject()
              .put("mime", mime(f.getName()))
              .put("base64", read(f, 24 * 1024 * 1024));
        }
      case "libraryLoad":
        {
          File f = new File(activity.getFilesDir(), "library.json");
          return f.exists()
              ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)
              : null;
        }
      case "librarySave":
        atomic(
            new File(activity.getFilesDir(), "library.json"),
            p.getString("json").getBytes(StandardCharsets.UTF_8));
        return null;
      case "lyricsGet":
        {
          File f = lyrics(p.getString("path"));
          return f.isFile() ? read(f, 4 * 1024 * 1024) : null;
        }
      case "lyricsSet":
        {
          File f = lyrics(p.getString("path"));
          if (p.isNull("data")) Files.deleteIfExists(f.toPath());
          else atomic(f, Base64.decode(p.getString("data"), 0));
          return null;
        }
      case "grantExport":
        {
          File f = new File(p.getString("path")).getCanonicalFile();
          if (!f.getParentFile().isDirectory()) throw new IOException("目标目录不存在");
          writes.add(f.getPath());
          return true;
        }
      case "writeExport":
        {
          File f = new File(p.getString("path")).getCanonicalFile();
          if (!writes.remove(f.getPath())) throw new IOException("请先在应用内选择保存位置");
          atomic(f, p.getString("content").getBytes(StandardCharsets.UTF_8));
          return true;
        }
      case "fontData":
        {
          String id = p.getString("id");
          if (!id.matches("user-[a-f0-9]{64}")) return null;
          return read(new File(activity.getFilesDir(), "fonts/" + id), 32 * 1024 * 1024);
        }
      case "importFonts":
        {
          JSONArray fonts = new JSONArray(prefs.getString("fonts", "[]")),
              errors = new JSONArray(),
              paths = p.getJSONArray("paths");
          for (int n = 0; n < paths.length(); n++) {
            File f = new File(paths.getString(n));
            try {
              byte[] data = Files.readAllBytes(f.toPath());
              if (data.length < 12 || data.length > 32 * 1024 * 1024)
                throw new IOException("字体大小不合法");
              String signature = new String(data, 0, 4, StandardCharsets.ISO_8859_1);
              if (!signature.equals("OTTO")
                  && !signature.equals("ttcf")
                  && !signature.equals("wOFF")
                  && !signature.equals("wOF2")
                  && !(data[0] == 0 && data[1] == 1 && data[2] == 0 && data[3] == 0))
                throw new IOException("不支持的字体容器");
              String id = "user-" + hash(data);
              boolean exists = false;
              for (int i = 0; i < fonts.length(); i++)
                if (fonts.getJSONObject(i).optString("id").equals(id)) exists = true;
              if (!exists) {
                atomic(new File(activity.getFilesDir(), "fonts/" + id), data);
                fonts.put(
                    new JSONObject()
                        .put("id", id)
                        .put("family", "JAP " + id)
                        .put("label", f.getName().replaceFirst("\\.[^.]+$", ""))
                        .put("weight", 400));
              }
            } catch (Exception e) {
              errors.put(f.getName() + ": " + e.getMessage());
            }
          }
          prefs.edit().putString("fonts", fonts.toString()).apply();
          return new JSONObject().put("fonts", fonts).put("errors", errors);
        }
      case "fullscreen":
        activity.runOnUiThread(
            () -> {
              boolean full = p.optBoolean("value");
              if (full)
                activity
                    .getWindow()
                    .addFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN);
              else
                activity
                    .getWindow()
                    .clearFlags(android.view.WindowManager.LayoutParams.FLAG_FULLSCREEN);
              MainActivity.emit("fullscreen", full);
            });
        return null;
      case "windowMode":
        {
          String mode = p.getString("mode");
          if (mode.equals("mini")) {
            if (!activity
                .getPackageManager()
                .hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE))
              throw new IOException("此设备不支持画中画");
            activity.runOnUiThread(() -> activity.enterPictureInPictureMode(activity.pipParams()));
            return "mini";
          }
          if (mode.equals("normal")) {
            activity.runOnUiThread(
                () ->
                    activity.startActivity(
                        new Intent(activity, MainActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)));
            return "normal";
          }
          throw new IOException("Android 不提供 Windows 桌面壁纸窗口");
        }
      case "systemMedia":
        {
          PlaybackService s = PlaybackService.instance;
          if (s != null) s.metadata(p);
          return null;
        }
      case "connectUsb":
        return connectUsb();
      case "restart":
        activity.runOnUiThread(activity::recreate);
        return null;
      default:
        throw new IOException("此 Android 接口尚不可用: " + method);
    }
  }

  JSONObject browse(String path) throws Exception {
    File f = new File(path).getCanonicalFile();
    if (!f.isDirectory()) f = f.getParentFile();
    if (f == null) f = music;
    JSONArray roots =
        new JSONArray()
            .put(root("应用音乐目录", music))
            .put(
                root(
                    "手机音乐",
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC)))
            .put(
                root(
                    "下载",
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)))
            .put(root("共享存储", Environment.getExternalStorageDirectory()));
    JSONArray entries = new JSONArray();
    File[] list = f.listFiles();
    if (list != null) {
      Arrays.sort(
          list,
          Comparator.comparing(File::isFile)
              .thenComparing(File::getName, String.CASE_INSENSITIVE_ORDER));
      for (File e : list)
        if (!e.getName().startsWith("."))
          entries.put(
              new JSONObject()
                  .put("name", e.getName())
                  .put("path", e.getAbsolutePath())
                  .put("directory", e.isDirectory())
                  .put("size", e.isFile() ? e.length() : 0));
    }
    return new JSONObject()
        .put("path", f.getAbsolutePath())
        .put("parent", nullable(f.getParent()))
        .put("roots", roots)
        .put("entries", entries)
        .put("error", list == null ? "尚无此目录的读取权限，可在文件卡片中授权读取音乐，或使用应用音乐目录。" : JSONObject.NULL);
  }

  JSONObject root(String name, File path) throws Exception {
    return new JSONObject().put("name", name).put("path", path.getAbsolutePath());
  }

  static final String AUDIO =
      "(?i).*\\.(flac|wav|aiff?|mp3|m4a|aac|ogg|oga|opus|mka|caf|alac|dsf|dff|dsd|ncm|ape|dts|dtshd|iso|cue|bin|img|wv|tta|mid|midi|kar|rmi)$";

  static void scan(File f, boolean recursive, Set<String> out, int depth) throws IOException {
    if (depth > 32 || out.size() >= 100000) return;
    if (f.isFile()) {
      if (f.getName().matches(AUDIO)) out.add(f.getCanonicalPath());
      return;
    }
    File[] list = f.listFiles();
    if (list == null) return;
    Arrays.sort(list, Comparator.comparing(File::getName, String.CASE_INSENSITIVE_ORDER));
    for (File c : list) {
      if (c.getName().startsWith(".")) continue;
      if (c.isFile() || recursive) scan(c, recursive, out, depth + 1);
    }
  }

  static String read(File f, int max) throws IOException {
    if (!f.isFile()) return null;
    // Base64/JSON temporarily needs several copies. Audio never uses this UI
    // helper: Rust reads the source directly in bounded decoding blocks.
    long budget = Math.min(Math.min(max, 24 * 1024 * 1024), Runtime.getRuntime().maxMemory() / 8);
    if (f.length() > budget) throw new IOException("文件过大，无法整份读入界面；音频的流式播放不受此限制");
    return Base64.encodeToString(Files.readAllBytes(f.toPath()), Base64.NO_WRAP);
  }

  static String mime(String name) {
    String lower = name.toLowerCase(Locale.ROOT);
    return lower.endsWith("png")
        ? "image/png"
        : lower.endsWith("webp") ? "image/webp" : "image/jpeg";
  }

  static File sidecar(String path, String[] exts) {
    File source = new File(path), parent = source.getParentFile();
    if (parent == null) return null;
    String stem = source.getName().replaceFirst("\\.[^.]+$", "");
    File[] files = parent.listFiles();
    if (files == null) return null;
    for (String ext : exts)
      for (File f : files) if (f.getName().equalsIgnoreCase(stem + "." + ext)) return f;
    return null;
  }

  File lyrics(String path) throws Exception {
    return new File(
        activity.getFilesDir(), "lyrics/" + hash(path.getBytes(StandardCharsets.UTF_8)) + ".lrc");
  }

  static String hash(byte[] data) throws Exception {
    byte[] h = MessageDigest.getInstance("SHA-256").digest(data);
    StringBuilder out = new StringBuilder();
    for (byte b : h) out.append(String.format(Locale.ROOT, "%02x", b & 255));
    return out.toString();
  }

  static void atomic(File f, byte[] data) throws IOException {
    f.getParentFile().mkdirs();
    File temp = new File(f.getParentFile(), f.getName() + ".tmp");
    Files.write(temp.toPath(), data);
    Files.move(
        temp.toPath(),
        f.toPath(),
        StandardCopyOption.REPLACE_EXISTING,
        StandardCopyOption.ATOMIC_MOVE);
  }

  static boolean audioDevice(UsbDevice d) {
    for (int i = 0; i < d.getInterfaceCount(); i++) {
      UsbInterface face = d.getInterface(i);
      if (face.getInterfaceClass() == 1 && face.getInterfaceSubclass() == 2) return true;
    }
    return false;
  }

  static void register(Context context, UsbDevice d) {
    UsbManager m = (UsbManager) context.getSystemService(Context.USB_SERVICE);
    if (!m.hasPermission(d) || usbConnections.containsKey(d.getDeviceName())) return;
    UsbDeviceConnection c = m.openDevice(d);
    if (c == null) {
      MainActivity.emit("nativeError", "无法打开 USB DAC");
      return;
    }
    String result =
        Native.usbAttach(
            d.getDeviceName(),
            c.getFileDescriptor(),
            d.getProductName() == null ? "USB DAC" : d.getProductName(),
            Base64.encodeToString(c.getRawDescriptors(), Base64.NO_WRAP),
            d.getVendorId(),
            d.getProductId());
    if (result.contains("\"error\"")) {
      c.close();
      MainActivity.emit("nativeError", result);
    } else {
      usbConnections.put(d.getDeviceName(), c);
      MainActivity.emit("usb", true);
    }
  }

  static synchronized void installUsbReceiver(Context c) {
    if (usbReceiverInstalled) return;
    usbReceiverInstalled = true;
    IntentFilter f = new IntentFilter(c.getPackageName() + ".USB_PERMISSION");
    f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
    f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
    BroadcastReceiver receiver =
        new BroadcastReceiver() {
          public void onReceive(Context context, Intent intent) {
            UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (d == null) return;
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) {
              Native.usbDetach(d.getDeviceName());
              UsbDeviceConnection connection = usbConnections.remove(d.getDeviceName());
              if (connection != null) connection.close();
              MainActivity.emit("usb", false);
            } else if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                || ((UsbManager) context.getSystemService(Context.USB_SERVICE)).hasPermission(d))
              register(context, d);
            else if (intent.getAction().endsWith("USB_PERMISSION"))
              MainActivity.emit("nativeError", "USB 授权已取消，可继续使用系统输出");
          }
        };
    if (Build.VERSION.SDK_INT >= 33) c.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
    else c.registerReceiver(receiver, f);
    UsbManager m = (UsbManager) c.getSystemService(Context.USB_SERVICE);
    for (UsbDevice d : m.getDeviceList().values())
      if (audioDevice(d) && m.hasPermission(d)) register(c, d);
  }

  String connectUsb() {
    UsbManager m = (UsbManager) activity.getSystemService(Context.USB_SERVICE);
    int found = 0;
    for (UsbDevice d : m.getDeviceList().values())
      if (audioDevice(d)) {
        found++;
        if (m.hasPermission(d)) register(activity, d);
        else {
          PendingIntent permission =
              PendingIntent.getBroadcast(
                  activity,
                  d.getDeviceId(),
                  new Intent(activity.getPackageName() + ".USB_PERMISSION")
                      .setPackage(activity.getPackageName()),
                  PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
          m.requestPermission(d, permission);
        }
      }
    return found == 0 ? "未发现 USB 音频设备，请通过 OTG 连接 DAC。" : "已连接或请求 USB 授权；授权后刷新设备列表。";
  }
}
