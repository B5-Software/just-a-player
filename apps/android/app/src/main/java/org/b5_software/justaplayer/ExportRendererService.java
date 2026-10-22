package org.b5_software.justaplayer;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.hardware.display.*;
import android.media.ImageReader;
import android.net.Uri;
import android.os.*;
import android.util.Base64;
import android.view.*;
import android.webkit.*;
import java.io.*;
import java.util.*;
import org.json.*;

/** Separate WebView/UI process on a private display, using the exact shared renderer. */
public final class ExportRendererService extends Service {
  private static boolean webDirectorySet;
  final Handler ui = new Handler(Looper.getMainLooper());
  Messenger owner;
  final Messenger inbox = new Messenger(new Handler(Looper.getMainLooper(), this::message));
  WebView web;
  VirtualDisplay display;
  ImageReader images;
  Presentation presentation;
  String snapshot = "{}";
  boolean foreground;

  @Override
  public void onCreate() {
    super.onCreate();
    if (!webDirectorySet) {
      WebView.setDataDirectorySuffix("video-export");
      webDirectorySet = true;
    }
    notifyActive();
  }

  void notifyActive() {
    NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
    manager.createNotificationChannel(
        new NotificationChannel("video-export", "后台视频导出", NotificationManager.IMPORTANCE_LOW));
    Notification n =
        new Notification.Builder(this, "video-export")
            .setSmallIcon(R.drawable.ic_player)
            .setContentTitle("Just A Player")
            .setContentText("正在后台生成音乐视频")
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this,
                    0,
                    new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            .build();
    startForeground(2, n);
    foreground = true;
  }

  boolean message(Message message) {
    final int kind = message.what;
    owner = message.replyTo == null ? owner : message.replyTo;
    RendererIPC.read(
        message,
        ui,
        text -> {
          try {
            if (kind == RendererIPC.INIT) {
              JSONObject init = new JSONObject(text);
              snapshot = init.getString("snapshot");
              open(init.optBoolean("e2e"));
            } else if (kind == RendererIPC.EVENT) {
              JSONObject event = new JSONObject(text);
              String key = event.getString("key");
              if (key.equals("videoJob") && !foreground) notifyActive();
              if (key.equals("videoIdle")) {
                stopForeground(STOP_FOREGROUND_REMOVE);
                foreground = false;
              }
              Object value = event.get("value");
              if (web != null)
                web.evaluateJavascript(
                    "window.__androidEvent?.("
                        + JSONObject.quote(key)
                        + ","
                        + (value instanceof String
                            ? JSONObject.quote((String) value)
                            : String.valueOf(value))
                        + ")",
                    null);
            }
          } catch (Exception e) {
            android.util.Log.e("JAP-Export", "Worker message", e);
          }
        });
    return true;
  }

  void open(boolean e2e) {
    if (web != null) return;
    // PRIVATE images are drained without mapping or reading pixels on the CPU.
    images = ImageReader.newInstance(1280, 720, ImageFormat.PRIVATE, 2);
    images.setOnImageAvailableListener(
        reader -> {
          try (android.media.Image image = reader.acquireLatestImage()) {}
        },
        ui);
    DisplayManager manager = (DisplayManager) getSystemService(DISPLAY_SERVICE);
    display =
        manager.createVirtualDisplay(
            "Just A Player Export",
            1280,
            720,
            160,
            images.getSurface(),
            DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY
                | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION);
    if (display == null) throw new IllegalStateException("无法创建后台绘制表面");
    presentation = new Presentation(this, display.getDisplay());
    presentation.getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
    web = new WebView(presentation.getContext());
    WebSettings settings = web.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setMediaPlaybackRequiresUserGesture(false);
    if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
    web.addJavascriptInterface(new Bridge(), "NativeAndroid");
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage m) {
            android.util.Log.println(
                m.messageLevel() == ConsoleMessage.MessageLevel.ERROR
                    ? android.util.Log.ERROR
                    : android.util.Log.INFO,
                "JAP-Export",
                m.message());
            return true;
          }
        });
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            return true;
          }

          @Override
          public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            android.os.Process.killProcess(android.os.Process.myPid());
            return true;
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
            Uri u = request.getUrl();
            String p = u.getPath();
            if (!"https".equals(u.getScheme())
                || !"appassets.androidplatform.net".equals(u.getHost())
                || p == null
                || !p.startsWith("/web/")
                || p.contains(".."))
              return new WebResourceResponse(
                  "text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            try {
              String ext = MimeTypeMap.getFileExtensionFromUrl(p);
              String mime =
                  ext.equals("js")
                      ? "application/javascript"
                      : ext.equals("css")
                          ? "text/css"
                          : ext.equals("woff2")
                              ? "font/woff2"
                              : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
              if (mime == null) mime = "application/octet-stream";
              return new WebResourceResponse(
                  mime,
                  "UTF-8",
                  200,
                  "OK",
                  Collections.singletonMap(
                      "Content-Security-Policy",
                      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';"
                          + " img-src 'self' data: blob:; font-src 'self' data: blob:; connect-src"
                          + " 'self' blob:; worker-src 'self' blob:; base-uri 'none'; frame-src"
                          + " 'none'"),
                  getAssets().open(p.substring(1)));
            } catch (IOException e) {
              return new WebResourceResponse(
                  "text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
          }
        });
    presentation.setContentView(web);
    presentation.show();
    web.loadUrl(
        MainActivity.ORIGIN
            + "/web/index.html?surface=export"
            + (BuildConfig.DEBUG && e2e ? "&e2e=1" : ""));
  }

  final class Bridge {
    @JavascriptInterface
    public String snapshot() {
      return snapshot;
    }

    @JavascriptInterface
    public void flushLibrary(String ignored) {}

    @JavascriptInterface
    public void engine(String data) {
      try {
        RendererIPC.send(owner, RendererIPC.ENGINE, data, inbox);
      } catch (Exception e) {
        android.util.Log.e("JAP-Export", "Engine IPC", e);
      }
    }

    @JavascriptInterface
    public void request(int id, String method, String payload) {
      RendererIPC.IO.execute(
          () -> {
            try {
              if (method.equals("videoFrame")) {
                JSONObject p = new JSONObject(payload);
                byte[] bytes = Base64.decode(p.getString("data"), Base64.NO_WRAP);
                ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
                Message message = Message.obtain(null, RendererIPC.VIDEO_PIPE);
                message.replyTo = inbox;
                Bundle b = new Bundle();
                b.putInt("id", id);
                b.putString("job", p.getString("id"));
                b.putInt("size", bytes.length);
                b.putParcelable("fd", pipe[0]);
                message.setData(b);
                try {
                  owner.send(message);
                } catch (Exception e) {
                  pipe[1].close();
                  throw e;
                } finally {
                  pipe[0].close();
                }
                try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
                  out.write(bytes);
                }
              } else
                RendererIPC.send(
                    owner,
                    RendererIPC.REQUEST,
                    new JSONObject()
                        .put("id", id)
                        .put("method", method)
                        .put("payload", payload)
                        .toString(),
                    inbox);
            } catch (Exception e) {
              ui.post(
                  () -> {
                    if (web != null)
                      web.evaluateJavascript(
                          "window.__androidEvent?.('rpc',"
                              + "{id:"
                              + id
                              + ",error:"
                              + JSONObject.quote(e.toString())
                              + "})",
                          null);
                  });
            }
          });
    }
  }

  @Override
  public IBinder onBind(Intent intent) {
    return inbox.getBinder();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int id) {
    return START_NOT_STICKY;
  }

  @Override
  public void onDestroy() {
    if (web != null) {
      web.removeJavascriptInterface("NativeAndroid");
      web.destroy();
    }
    if (presentation != null) presentation.dismiss();
    if (display != null) display.release();
    if (images != null) images.close();
    super.onDestroy();
  }
}
