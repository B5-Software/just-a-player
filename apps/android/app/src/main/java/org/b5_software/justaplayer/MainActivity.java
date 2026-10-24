package org.b5_software.justaplayer;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.hardware.usb.*;
import android.net.Uri;
import android.os.*;
import android.util.*;
import android.view.*;
import android.webkit.*;
import java.io.*;
import java.lang.ref.WeakReference;
import java.util.*;
import org.json.*;

public final class MainActivity extends Activity {
  static WeakReference<MainActivity> current = new WeakReference<>(null);
  static volatile boolean visible;
  static volatile boolean visualsVisible;
  volatile boolean lightweight;
  volatile boolean lightMeters;
  WebView web;
  NativeLightView lightView;
  AppBridge bridge;
  android.widget.FrameLayout root;
  WebView exportWeb;
  AppBridge exportBridge;
  VideoCoordinator video;
  boolean bound;
  volatile HdrSurface hdrSurface;

  JSONObject viewportInfo() {
    JSONObject out = new JSONObject();
    try {
      int width, height;
      if (web != null && web.getWidth() > 0 && web.getHeight() > 0) {
        width = web.getWidth();
        height = web.getHeight();
      } else if (Build.VERSION.SDK_INT >= 30) {
        android.graphics.Rect bounds = getWindowManager().getCurrentWindowMetrics().getBounds();
        width = bounds.width();
        height = bounds.height();
      } else {
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(metrics);
        width = metrics.widthPixels;
        height = metrics.heightPixels;
      }
      out.put("width", width)
          .put("height", height)
          .put("density", getResources().getDisplayMetrics().density);
    } catch (Exception ignored) {
    }
    return out;
  }

  @Override
  public void onConfigurationChanged(Configuration config) {
    super.onConfigurationChanged(config);
    emit("viewport", viewportInfo());
  }

  JSONObject displayInfo() {
    JSONObject out = new JSONObject();
    try {
      Display display = getWindow().getDecorView().getDisplay();
      if (display == null) display = getWindowManager().getDefaultDisplay();
      Display.HdrCapabilities hdr = display.getHdrCapabilities();
      JSONArray types = new JSONArray();
      for (int type : hdr.getSupportedHdrTypes()) types.put(type);
      out.put("supported", types.length() > 0)
          .put("types", types)
          .put("maxLuminance", hdr.getDesiredMaxLuminance())
          .put("wideColor", display.isWideColorGamut());
      android.content.pm.PackageInfo pkg = WebView.getCurrentWebViewPackage();
      out.put("webView", pkg == null ? "unknown" : pkg.versionName);
    } catch (Exception ignored) {
    }
    return out;
  }

  boolean configureHdr(boolean enabled) throws Exception {
    if (enabled && !displayInfo().optBoolean("supported"))
      throw new IOException("Android 当前显示器未报告 HDR 支持");
    int mode = enabled ? HdrSurface.probe() : -1;
    if (enabled && mode < 0) throw new IOException("显示器支持 HDR，但驱动未提供 scRGB Float16 或 HDR10 EGL 表面");
    runOnUiThread(
        () -> {
          if (enabled) getWindow().setColorMode(android.content.pm.ActivityInfo.COLOR_MODE_HDR);
          if (enabled) {
            if (hdrSurface == null) {
              hdrSurface = new HdrSurface(this, mode == 0);
              root.addView(hdrSurface, 0, new android.widget.FrameLayout.LayoutParams(-1, -1));
            }
          } else {
            getWindow().setColorMode(android.content.pm.ActivityInfo.COLOR_MODE_DEFAULT);
            nativeHdrReady(false, "HDR 已关闭");
            HdrSurface surface = hdrSurface;
            hdrSurface = null;
            if (surface != null)
              root.postDelayed(
                  () -> {
                    root.removeView(surface);
                    if (hdrSurface == null)
                      getWindow().setColorMode(android.content.pm.ActivityInfo.COLOR_MODE_DEFAULT);
                  },
                  64);
          }
        });
    return enabled;
  }

  void nativeHdrReady(boolean active, String reason) {
    runOnUiThread(
        () -> {
          try {
            emit("nativeHdr", new JSONObject().put("active", active).put("reason", reason));
          } catch (Exception ignored) {
          }
          if (web != null) {
            if (active) web.setBackgroundColor(Color.TRANSPARENT);
            else
              web.postDelayed(
                  () -> {
                    if (hdrSurface == null && web != null)
                      web.setBackgroundColor(Color.rgb(7, 7, 11));
                  },
                  64);
          }
        });
  }

  void applyPlaybackWindow() {
    runOnUiThread(
        () -> {
          try {
            JSONObject settings =
                new JSONObject(getSharedPreferences("player", 0).getString("settings", "{}"));
            boolean playing =
                PlaybackService.instance != null && PlaybackService.instance.playingState;
            boolean hold = visible && playing && settings.optBoolean("keepScreenAwake", false);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            // ViewRoot propagates this flag on every traversal, including release.
            // It also avoids a stale Window attributes copy retaining KEEP_SCREEN_ON.
            if (root != null) root.setKeepScreenOn(hold);
            // WebView can retain its own media keep-awake bit after native pause.
            // Native playback state and the user setting own the entire window.
            if (web != null) web.setKeepScreenOn(hold);
          } catch (Exception ignored) {
          }
        });
  }

  OpenedMusic opened;

  PictureInPictureParams pipParams() {
    PlaybackService player = PlaybackService.instance;
    boolean playing = player != null && player.playingState;
    java.util.List<RemoteAction> actions = new ArrayList<>();
    if (player != null) {
      actions.add(
          new RemoteAction(
              android.graphics.drawable.Icon.createWithResource(
                  this, android.R.drawable.ic_media_previous),
              "上一首",
              "上一首",
              player.action("previous", 1)));
      actions.add(
          new RemoteAction(
              android.graphics.drawable.Icon.createWithResource(
                  this,
                  playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play),
              playing ? "暂停" : "播放",
              playing ? "暂停" : "播放",
              player.action(playing ? "pause" : "play", 2)));
      actions.add(
          new RemoteAction(
              android.graphics.drawable.Icon.createWithResource(
                  this, android.R.drawable.ic_media_next),
              "下一首",
              "下一首",
              player.action("next", 3)));
    }
    PictureInPictureParams.Builder builder =
        new PictureInPictureParams.Builder()
            .setAspectRatio(new Rational(16, 9))
            .setActions(actions);
    if (Build.VERSION.SDK_INT >= 31) builder.setSeamlessResizeEnabled(true);
    return builder.build();
  }

  void refreshPip() {
    runOnUiThread(
        () -> {
          if (isInPictureInPictureMode()) setPictureInPictureParams(pipParams());
        });
  }

  synchronized JSONArray takeOpenFiles() {
    return opened.take();
  }

  @Override
  public void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    opened.receive(intent);
  }

  final ServiceConnection service =
      new ServiceConnection() {
        public void onServiceConnected(ComponentName n, IBinder b) {
          bound = true;
        }

        public void onServiceDisconnected(ComponentName n) {
          bound = false;
        }
      };
  static final String ORIGIN = "https://appassets.androidplatform.net";

  static void emit(String event, Object value) {
    MainActivity a = current.get();
    if (a != null)
      a.runOnUiThread(
          () -> {
            if (a.lightView != null) a.lightView.receive(event, value);
            else if (a.web != null)
              a.web.evaluateJavascript(
                  "window.__androidEvent?.("
                      + JSONObject.quote(event)
                      + ","
                      + (value instanceof String
                          ? JSONObject.quote((String) value)
                          : String.valueOf(value))
                      + ")",
                  null);
          });
  }

  Messenger exportMessenger;
  boolean exportBound, closingExport;
  final Handler exportUi = new Handler(Looper.getMainLooper());
  final Messenger exportInbox =
      new Messenger(
          new Handler(
              Looper.getMainLooper(),
              message -> {
                final int kind = message.what;
                if (exportBridge == null) return true;
                if (kind == RendererIPC.VIDEO_PIPE) {
                  Bundle b = message.getData();
                  ParcelFileDescriptor fd = b.getParcelable("fd");
                  int id = b.getInt("id"), size = b.getInt("size");
                  String job = b.getString("job");
                  exportBridge.io.execute(
                      () -> {
                        try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
                          video.framePipe(job, in, size);
                          exportBridge.emit(
                              "rpc", new JSONObject().put("id", id).put("value", JSONObject.NULL));
                        } catch (Exception e) {
                          try {
                            exportBridge.emit(
                                "rpc", new JSONObject().put("id", id).put("error", e.toString()));
                          } catch (Exception ignored) {
                          }
                        }
                      });
                  return true;
                }
                RendererIPC.read(
                    message,
                    exportUi,
                    text -> {
                      try {
                        if (kind == RendererIPC.ENGINE) exportBridge.engine(text);
                        else if (kind == RendererIPC.REQUEST) {
                          JSONObject p = new JSONObject(text);
                          if (p.getString("method").equals("videoProgress")) {
                            video.progress(new JSONObject(p.getString("payload")));
                            exportBridge.emit(
                                "rpc",
                                new JSONObject()
                                    .put("id", p.getInt("id"))
                                    .put("value", JSONObject.NULL));
                          } else
                            exportBridge.request(
                                p.getInt("id"), p.getString("method"), p.getString("payload"));
                        }
                      } catch (Exception e) {
                        android.util.Log.e("JAP-Export", "Worker IPC", e);
                      }
                    });
                return true;
              }));
  final ServiceConnection exportConnection =
      new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
          exportMessenger = new Messenger(binder);
          try {
            RendererIPC.send(
                exportMessenger,
                RendererIPC.INIT,
                new JSONObject()
                    .put("snapshot", exportBridge.snapshot())
                    .put("e2e", BuildConfig.DEBUG && getIntent().getBooleanExtra("e2e", false))
                    .toString(),
                exportInbox);
          } catch (Exception e) {
            android.util.Log.e("JAP-Export", "Worker init", e);
          }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
          exportMessenger = null;
          if (exportBound) {
            unbindService(this);
            exportBound = false;
          }
          if (!closingExport && video != null)
            RendererIPC.IO.execute(() -> video.rendererGone("后台渲染进程已退出，前台播放继续"));
        }
      };

  void emitExport(String event, Object value) {
    runOnUiThread(
        () -> {
          if (exportMessenger == null) return;
          try {
            RendererIPC.send(
                exportMessenger,
                RendererIPC.EVENT,
                new JSONObject()
                    .put("key", event)
                    .put("value", value == null ? JSONObject.NULL : value)
                    .toString(),
                exportInbox);
          } catch (Exception e) {
            android.util.Log.e("JAP-Export", "Worker event", e);
          }
        });
  }

  void stopExportRenderer() {
    closingExport = true;
    if (exportBound) {
      unbindService(exportConnection);
      exportBound = false;
    }
    exportMessenger = null;
    stopService(new Intent(this, ExportRendererService.class));
    if (exportBridge != null) {
      exportBridge.close();
      exportBridge = null;
    }
  }

  void releaseExportWhenIdle() {
    exportUi.postDelayed(
        () -> {
          if (video != null && video.prepareIdleRelease()) {
            stopExportRenderer();
          }
        },
        500);
  }

  void ensureExport() {
    runOnUiThread(
        () -> {
          if (exportBound) return;
          closingExport = false;
          if (exportBridge == null) exportBridge = new AppBridge(this, true);
          Intent intent = new Intent(this, ExportRendererService.class);
          startForegroundService(intent);
          exportBound = bindService(intent, exportConnection, Context.BIND_AUTO_CREATE);
        });
  }

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    opened = new OpenedMusic(this);
    opened.receive(getIntent());
    current = new WeakReference<>(this);
    getWindow().setStatusBarColor(Color.rgb(7, 7, 11));
    getWindow().setNavigationBarColor(Color.rgb(7, 7, 11));
    getWindow()
        .setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
    Native.init(getCacheDir().getAbsolutePath(), getApplicationInfo().nativeLibraryDir);
    bindService(new Intent(this, PlaybackService.class), service, Context.BIND_AUTO_CREATE);
    video = new VideoCoordinator(this);
    root = new android.widget.FrameLayout(this);
    bridge = new AppBridge(this);
    setContentView(root);
    loadPlayerPage();
  }

  void createFullWeb() {
    web =
        new WebView(this) {
          @Override
          protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
            super.onSizeChanged(width, height, oldWidth, oldHeight);
            post(() -> emit("viewport", viewportInfo()));
          }
        };
    web.setBackgroundColor(Color.rgb(7, 7, 11));
    web.setOverScrollMode(View.OVER_SCROLL_NEVER);
    web.setFocusable(true);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setUseWideViewPort(true);
    s.setTextZoom(100);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setSupportZoom(false);
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    if (bridge == null) bridge = new AppBridge(this);
    web.addJavascriptInterface(bridge, "NativeAndroid");
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            return !ORIGIN.equals(r.getUrl().getScheme() + "://" + r.getUrl().getHost());
          }

          @Override
          public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (!"appassets.androidplatform.net".equals(u.getHost())
                || !"https".equals(u.getScheme()))
              return new WebResourceResponse(
                  "text/plain",
                  "UTF-8",
                  403,
                  "Forbidden",
                  Collections.emptyMap(),
                  new ByteArrayInputStream(new byte[0]));
            String path = u.getPath();
            if (path == null || path.contains("..") || !path.startsWith("/web/")) return null;
            try {
              String name = path.substring(1);
              String ext = MimeTypeMap.getFileExtensionFromUrl(name);
              String mime =
                  (ext.equals("js") || ext.equals("mjs"))
                      ? "application/javascript"
                      : ext.equals("css")
                          ? "text/css"
                          : ext.equals("wasm")
                              ? "application/wasm"
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
                  getAssets().open(name));
            } catch (IOException e) {
              return new WebResourceResponse(
                  "text/plain",
                  "UTF-8",
                  404,
                  "Not Found",
                  Collections.emptyMap(),
                  new ByteArrayInputStream(new byte[0]));
            }
          }

          @Override
          public void onPageFinished(WebView v, String url) {
            if (v == web) {
              emit("visibility", visible);
              PlaybackService service = PlaybackService.instance;
              if (service != null) service.replay();
            }
          }

          @Override
          public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
            android.util.Log.e("JAP", "WebView renderer exited");
            recreate();
            return true;
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onConsoleMessage(ConsoleMessage m) {
            android.util.Log.println(
                m.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? Log.ERROR : Log.INFO,
                "JAP-Web",
                m.message() + " @" + m.lineNumber());
            return true;
          }

          @Override
          public boolean onJsAlert(WebView v, String url, String message, JsResult result) {
            result.cancel();
            emit("nativeError", message);
            return true;
          }

          @Override
          public boolean onJsConfirm(WebView v, String url, String message, JsResult result) {
            result.cancel();
            emit("nativeError", message);
            return true;
          }

          @Override
          public boolean onJsPrompt(
              WebView v, String url, String message, String initial, JsPromptResult result) {
            result.cancel();
            emit("nativeError", message);
            return true;
          }
        });
  }

  void loadPlayerPage() {
    lightweight = getSharedPreferences("player", 0).getBoolean("lightweight", false);
    lightMeters = false;
    visualsVisible = visible && !isInPictureInPictureMode() && !lightweight;
    if (lightView != null) {
      root.removeView(lightView);
      lightView.close(true);
      lightView = null;
    }
    if (lightweight) {
      if (web != null) {
        root.removeView(web);
        web.removeJavascriptInterface("NativeAndroid");
        web.destroy();
        web = null;
      }
      lightView = new NativeLightView(this);
      root.addView(lightView, new android.widget.FrameLayout.LayoutParams(-1, -1));
    } else {
      if (web == null) createFullWeb();
      if (web.getParent() == null)
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
      String query = BuildConfig.DEBUG && getIntent().getBooleanExtra("e2e", false) ? "?e2e=1" : "";
      web.loadUrl(ORIGIN + "/web/index.html" + query);
    }
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 6190 && result == RESULT_OK && data != null) opened.receive(data);
  }

  void mediaPermission() {
    runOnUiThread(
        () -> {
          String p =
              Build.VERSION.SDK_INT >= 33
                  ? Manifest.permission.READ_MEDIA_AUDIO
                  : Manifest.permission.READ_EXTERNAL_STORAGE;
          if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] {p}, 1);
        });
  }

  @Override
  public void onRequestPermissionsResult(int code, String[] permissions, int[] grants) {
    super.onRequestPermissionsResult(code, permissions, grants);
    emit("filesChanged", grants.length > 0 && grants[0] == PackageManager.PERMISSION_GRANTED);
  }

  @Override
  protected void onResume() {
    super.onResume();
    visible = true;
    applyPlaybackWindow();
    visualsVisible = !isInPictureInPictureMode() && (!lightweight || lightMeters);
    emit("visibility", true);
  }

  @Override
  protected void onPause() {
    super.onPause();
    visualsVisible = false;
    visible = isInPictureInPictureMode();
    applyPlaybackWindow();
    emit("visibility", visible);
    if (!visible)
      try {
        JSONObject settings =
            new JSONObject(getSharedPreferences("player", 0).getString("settings", "{}"));
        if (!settings.optBoolean("backgroundPlayback", true)) PlaybackService.command("pause");
      } catch (Exception ignored) {
      }
  }

  @Override
  public void onPictureInPictureModeChanged(boolean mini, Configuration config) {
    super.onPictureInPictureModeChanged(mini, config);
    visible = mini || hasWindowFocus();
    visualsVisible = visible && !mini && (!lightweight || lightMeters);
    if (mini && hdrSurface != null)
      try {
        configureHdr(false);
      } catch (Exception ignored) {
      }
    emit("windowMode", mini ? "mini" : "normal");
    emit("visibility", visible);
  }

  @Override
  public void onBackPressed() {
    if (isInPictureInPictureMode()) moveTaskToBack(true);
    else if (lightView != null) {
      try {
        if (!new JSONObject(Native.lightControl("{\"type\":\"back\"}")).optBoolean("closed"))
          moveTaskToBack(true);
      } catch (Exception ignored) {
      }
      lightView.invalidate();
    } else if (web != null)
      web.evaluateJavascript(
          "(()=>{const"
              + " open=!!document.querySelector('[data-app-dialog],[data-panel-root],[data-onboarding]');if(open)window.dispatchEvent(new"
              + " KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return open})()",
          value -> {
            if ("false".equals(value)) moveTaskToBack(true);
          });
  }

  @Override
  protected void onDestroy() {
    if (lightView != null) {
      lightView.close(false);
      lightView = null;
    }
    if (hdrSurface != null) {
      root.removeView(hdrSurface);
      hdrSurface = null;
    }
    if (opened != null) opened.io.shutdown();
    closingExport = true;
    if (video != null) video.close();
    if (exportBound) {
      unbindService(exportConnection);
      exportBound = false;
    }
    stopService(new Intent(this, ExportRendererService.class));
    if (exportBridge != null) exportBridge.close();
    if (exportWeb != null) {
      exportWeb.removeJavascriptInterface("NativeAndroid");
      exportWeb.destroy();
      exportWeb = null;
    }
    if (bound) unbindService(service);
    if (bridge != null) bridge.close();
    if (web != null) {
      web.removeJavascriptInterface("NativeAndroid");
      web.destroy();
      web = null;
    }
    if (current.get() == this) current.clear();
    super.onDestroy();
  }
}
