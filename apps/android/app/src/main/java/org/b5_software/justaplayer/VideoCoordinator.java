package org.b5_software.justaplayer;

import android.util.Base64;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import org.json.*;

/** One hidden export surface and one encoder, independent of live audio/rendering. */
final class VideoCoordinator {
  final MainActivity activity;
  final List<JSONObject> items = new ArrayList<>();
  final Map<String, JSONObject> requests = new HashMap<>();
  final Set<String> temporaryAudio = new HashSet<>();
  JSONObject current;
  volatile boolean loaded;
  volatile long lastProgress;
  volatile Job job;

  static final class Job {
    String id, target;
    File dir;
    JSONObject options;
    Process child;
    OutputStream input;
    volatile boolean cancelled;
  }

  VideoCoordinator(MainActivity a) {
    activity = a;
  }

  void close() {
    Job active = job;
    if (active != null)
      try {
        cancel(active.id);
      } catch (Exception ignored) {
      }
    cleanupAudio();
  }

  synchronized JSONArray queue() {
    return new JSONArray(items);
  }

  synchronized JSONObject enqueue(JSONObject request) throws Exception {
    if (items.stream().filter(i -> i.optString("state").equals("waiting")).count() >= 50)
      throw new IOException("导出队列已满");
    String target = request.getString("target");
    JSONObject options = request.getJSONObject("options");
    JSONObject item =
        new JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("title", request.optString("title"))
            .put("path", options.getString("path"))
            .put("target", target)
            .put("state", "waiting")
            .put("progress", 0)
            .put("status", "排队中")
            .put("error", JSONObject.NULL);
    items.add(item);
    requests.put(item.getString("id"), request);
    broadcast();
    next();
    return item;
  }

  synchronized void broadcast() {
    MainActivity.emit("videoQueue", queue());
  }

  synchronized void next() throws Exception {
    if (current != null) return;
    JSONObject pending = null;
    for (JSONObject i : items)
      if (i.optString("state").equals("waiting")) {
        pending = i;
        break;
      }
    if (pending == null) {
      if (loaded) activity.releaseExportWhenIdle();
      return;
    }
    if (!loaded) {
      activity.ensureExport();
      return;
    }
    current = pending;
    lastProgress = android.os.SystemClock.elapsedRealtime();
    final String watched = current.getString("id");
    activity.exportUi.postDelayed(
        new Runnable() {
          public void run() {
            synchronized (VideoCoordinator.this) {
              if (current == null || !watched.equals(current.optString("id"))) return;
              if (android.os.SystemClock.elapsedRealtime() - lastProgress
                  < (current.optString("status").contains("合并音频") ? 650000 : 120000)) {
                activity.exportUi.postDelayed(this, 10000);
                return;
              }
            }
            activity.stopExportRenderer();
            RendererIPC.IO.execute(() -> rendererGone("后台生成超时，已释放资源"));
          }
        },
        120000);
    current.put("state", "rendering").put("status", "后台准备…");
    JSONObject request = new JSONObject(requests.get(current.getString("id")).toString());
    request.put("id", current.getString("id"));
    broadcast();
    activity.emitExport("videoJob", request);
  }

  synchronized boolean prepareIdleRelease() {
    if (current != null || items.stream().anyMatch(i -> i.optString("state").equals("waiting")))
      return false;
    loaded = false;
    return true;
  }

  synchronized void ready() throws Exception {
    loaded = true;
    next();
  }

  synchronized void rendererGone(String reason) {
    if (job != null) {
      job.cancelled = true;
      job.child.destroyForcibly();
      job = null;
    }
    try {
      if (current != null) {
        current.put("state", "failed").put("status", reason).put("error", reason);
        requests.remove(current.getString("id"));
        current = null;
      }
      loaded = false;
      broadcast();
      next();
    } catch (Exception e) {
      android.util.Log.e("JAP-Export", "Worker recovery", e);
    }
  }

  synchronized void progress(JSONObject p) throws Exception {
    if (current != null
        && (current.optDouble("progress") != p.optDouble("progress")
            || !current.optString("status").equals(p.optString("status"))))
      lastProgress = android.os.SystemClock.elapsedRealtime();
    if (current == null || !current.getString("id").equals(p.optString("id"))) return;
    current
        .put("progress", Math.max(0, Math.min(1, p.optDouble("progress"))))
        .put("status", p.optString("status"))
        .put("error", p.opt("error"));
    if (!p.optBoolean("running")) {
      String status = p.optString("status");
      current.put(
          "state", status.equals("导出完成") ? "done" : status.equals("已取消") ? "cancelled" : "failed");
      requests.remove(current.getString("id"));
      current = null;
      broadcast();
      next();
    } else broadcast();
  }

  synchronized void cancelJob(String id) throws Exception {
    for (JSONObject i : items)
      if (i.optString("id").equals(id)) {
        if (i == current) {
          cancel(id);
          i.put("state", "cancelled").put("status", "已取消");
          requests.remove(id);
          current = null;
          loaded = false;
          // Do not wait on an encoder flush or a stalled worker event loop.
          activity.runOnUiThread(
              () -> {
                activity.stopExportRenderer();
                RendererIPC.IO.execute(
                    () -> {
                      synchronized (VideoCoordinator.this) {
                        try {
                          next();
                        } catch (Exception e) {
                          android.util.Log.e("JAP-Export", "Restart after cancel", e);
                        }
                      }
                    });
              });
          broadcast();
        } else if (i.optString("state").equals("waiting")) {
          i.put("state", "cancelled").put("status", "已取消");
          requests.remove(id);
          broadcast();
        }
        break;
      }
  }

  synchronized String tempAudio(String extension) throws Exception {
    File f =
        new File(activity.getCacheDir(), "jap-export-audio-" + UUID.randomUUID() + "." + extension);
    temporaryAudio.add(f.getCanonicalPath());
    return f.getCanonicalPath();
  }

  String ffmpeg() {
    return activity.getApplicationInfo().nativeLibraryDir + "/libffmpeg.so";
  }

  JSONObject start(JSONObject options) throws Exception {
    if (job != null) throw new IOException("已有视频正在编码");
    int w = options.getInt("width"),
        h = options.getInt("height"),
        fps = options.getInt("fps"),
        quality = options.getInt("quality");
    if (w < 320
        || w > 3840
        || h < 180
        || h > 2160
        || (w & 1) != 0
        || (h & 1) != 0
        || !Arrays.asList(24, 30, 60).contains(fps)
        || !Arrays.asList(18, 23, 28).contains(quality)
        || options.optDouble("duration") <= 0
        || options.optDouble("duration") > 86400) throw new IOException("无效视频参数");
    String target;
    synchronized (this) {
      if (current == null || !current.getString("id").equals(options.optString("queueId")))
        throw new IOException("视频任务已取消");
      target = current.getString("target");
    }
    if (!new File(ffmpeg()).canExecute()) throw new IOException("APK 缺少此架构的 FFmpeg，请重新完整构建");
    Job j = new Job();
    j.id = options.getString("queueId");
    j.target = target;
    j.options = options;
    j.dir = Files.createTempDirectory(activity.getCacheDir().toPath(), "jap-video-").toFile();
    boolean encoded = options.optString("transport").equals("h264");
    List<String> command = new ArrayList<>(Arrays.asList(ffmpeg(), "-v", "error", "-y"));
    if (encoded)
      command.addAll(Arrays.asList("-fflags", "+genpts", "-f", "h264", "-r", String.valueOf(fps)));
    else
      command.addAll(
          Arrays.asList(
              "-f",
              "rawvideo",
              "-pixel_format",
              "rgba",
              "-video_size",
              w + "x" + h,
              "-framerate",
              String.valueOf(fps)));
    command.addAll(Arrays.asList("-i", "pipe:0", "-an", "-c:v"));
    if (encoded) command.add("copy");
    else
      command.addAll(
          Arrays.asList(
              "libx264",
              "-preset",
              "veryfast",
              "-crf",
              String.valueOf(quality),
              "-pix_fmt",
              "yuv420p"));
    command.add(new File(j.dir, "video.mp4").getPath());
    j.child = new ProcessBuilder(command).redirectError(new File(j.dir, "encode.log")).start();
    j.input = j.child.getOutputStream();
    job = j;
    return new JSONObject()
        .put("id", j.id)
        .put("encoder", encoded ? "系统视频编码 · GPU 帧直送" : "libx264 · Android 后台")
        .put("target", j.target);
  }

  Job require(String id) throws IOException {
    Job j = job;
    if (j == null || !j.id.equals(id) || j.cancelled) throw new IOException("导出已取消");
    return j;
  }

  void frame(String id, String base64) throws Exception {
    byte[] b = Base64.decode(base64, Base64.NO_WRAP);
    framePipe(id, new ByteArrayInputStream(b), b.length);
  }

  void framePipe(String id, InputStream source, int size) throws Exception {
    Job j = require(id);
    boolean encoded = j.options.optString("transport").equals("h264");
    if (encoded
        ? size <= 0 || size > 16 * 1024 * 1024
        : size != j.options.getInt("width") * j.options.getInt("height") * 4)
      throw new IOException("无效视频帧");
    byte[] buffer = new byte[65536];
    int remaining = size;
    while (remaining > 0) {
      if (j.cancelled) throw new IOException("导出已取消");
      int n = source.read(buffer, 0, Math.min(buffer.length, remaining));
      if (n < 0) throw new EOFException("视频帧传输中断");
      j.input.write(buffer, 0, n);
      remaining -= n;
    }
  }

  void waitFor(Process child, File log) throws Exception {
    if (!child.waitFor(10, TimeUnit.MINUTES)) {
      child.destroyForcibly();
      throw new IOException("编码超时");
    }
    if (child.exitValue() != 0) {
      byte[] b = Files.readAllBytes(log.toPath());
      throw new IOException(
          new String(
              b,
              Math.max(0, b.length - 8192),
              Math.min(b.length, 8192),
              java.nio.charset.StandardCharsets.UTF_8));
    }
  }

  void execute(Job j, List<String> args, String logName) throws Exception {
    if (j.cancelled) throw new IOException("导出已取消");
    List<String> cmd = new ArrayList<>();
    cmd.add(ffmpeg());
    cmd.addAll(args);
    File log = new File(j.dir, logName);
    j.child =
        new ProcessBuilder(cmd)
            .redirectError(log)
            .redirectOutput(ProcessBuilder.Redirect.to(new File("/dev/null")))
            .start();
    waitFor(j.child, log);
    if (j.cancelled) throw new IOException("导出已取消");
  }

  String finish(String id, String audioPath) throws Exception {
    Job j = require(id);
    try {
      j.input.close();
      waitFor(j.child, new File(j.dir, "encode.log"));
      JSONObject o = j.options;
      String audio = o.optString("audio", "aac");
      String source =
          audio.equals("copy") ? o.optString("originalSourcePath", o.optString("path")) : audioPath;
      double intro = o.optDouble("intro"),
          duration = o.getDouble("duration"),
          music = o.optDouble("musicDuration", duration - intro - o.optDouble("outro"));
      if (audio.equals("copy"))
        execute(
            j,
            new ArrayList<>(
                Arrays.asList(
                    "-v",
                    "error",
                    "-y",
                    "-ss",
                    String.valueOf(o.optDouble("start")),
                    "-t",
                    String.valueOf(music),
                    "-i",
                    source,
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "copy",
                    "-f",
                    "matroska",
                    new File(j.dir, "original.mka").getPath())),
            "cut.log");
      List<String> args =
          new ArrayList<>(
              Arrays.asList("-v", "error", "-y", "-i", new File(j.dir, "video.mp4").getPath()));
      if (audio.equals("copy"))
        args.addAll(
            Arrays.asList(
                "-itsoffset",
                String.valueOf(intro),
                "-i",
                new File(j.dir, "original.mka").getPath()));
      else args.addAll(Arrays.asList("-i", source));
      args.addAll(
          Arrays.asList(
              "-map",
              "0:v:0",
              "-map",
              "1:a:0",
              "-c:v",
              "copy",
              "-c:a",
              audio.equals("copy") ? "copy" : audio.equals("pcm") ? "pcm_s32le" : audio));
      if (!audio.equals("copy")) {
        if (audio.equals("flac"))
          args.addAll(
              Arrays.asList(
                  "-strict",
                  "-2",
                  "-bits_per_raw_sample",
                  String.valueOf(o.optInt("audioBits", 32))));
        if (audio.equals("opus")) args.addAll(Arrays.asList("-strict", "-2", "-ar", "48000"));
        if (audio.equals("aac") || audio.equals("opus"))
          args.addAll(Arrays.asList("-b:a", o.optInt("audioBitrate", 320) + "k"));
        args.addAll(
            Arrays.asList(
                "-af", "atrim=duration=" + music + ",asetpts=PTS-STARTPTS+" + intro + "/TB,apad"));
      }
      String format = audio.equals("aac") ? "mp4" : "mkv";
      args.addAll(Arrays.asList("-t", String.valueOf(duration)));
      if (format.equals("mp4")) args.addAll(Arrays.asList("-movflags", "+faststart"));
      File result = new File(j.dir, "final." + format);
      args.add(result.getPath());
      execute(j, args, "mux.log");
      File target = new File(j.target).getCanonicalFile(),
          staged = new File(target.getParentFile(), ".jap-" + j.id + ".tmp");
      try {
        Files.copy(result.toPath(), staged.toPath(), StandardCopyOption.REPLACE_EXISTING);
        if (j.cancelled) throw new IOException("导出已取消");
        if (o.optString("path").toLowerCase(Locale.ROOT).matches(".*\\.(mid|midi|kar|rmi)$")
            && o.optString("midiSoundfont", "").isEmpty()) {
          try (InputStream notice =
              activity.getAssets().open("licenses/MuseScore_General_HQ_License.md")) {
            Files.copy(
                notice,
                Paths.get(j.target + ".midi-license.txt"),
                StandardCopyOption.REPLACE_EXISTING);
          }
        }
        Files.move(
            staged.toPath(),
            target.toPath(),
            StandardCopyOption.REPLACE_EXISTING,
            StandardCopyOption.ATOMIC_MOVE);
      } finally {
        Files.deleteIfExists(staged.toPath());
      }
      return target.getPath();
    } finally {
      if (job == j) job = null;
      clean(j.dir);
      cleanupAudio();
    }
  }

  void cancel(String id) throws Exception {
    Job j = job;
    if (j != null && j.id.equals(id)) {
      j.cancelled = true;
      j.child.destroyForcibly();
      job = null;
      try {
        j.input.close();
      } catch (IOException ignored) {
      }
      clean(j.dir);
    }
    cleanupAudio();
  }

  synchronized void cleanupAudio() {
    for (String path : temporaryAudio)
      try {
        Files.deleteIfExists(Paths.get(path));
      } catch (IOException ignored) {
      }
    temporaryAudio.clear();
  }

  void clean(File directory) throws IOException {
    String root = activity.getCacheDir().getCanonicalPath();
    if (!directory.getCanonicalPath().startsWith(root + File.separator)
        || !directory.getName().startsWith("jap-video-"))
      throw new IOException("Invalid export cache path");
    try (var paths = Files.walk(directory.toPath())) {
      paths
          .sorted(Comparator.reverseOrder())
          .forEach(
              p -> {
                try {
                  Files.deleteIfExists(p);
                } catch (IOException ignored) {
                }
              });
    }
  }
}
