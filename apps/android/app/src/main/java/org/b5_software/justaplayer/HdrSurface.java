package org.b5_software.justaplayer;

import android.graphics.PixelFormat;
import android.opengl.*;
import android.util.Base64;
import android.view.*;
import java.nio.*;

/** Draws the portable shader once on the native GPU; no per-frame pixel transport. */
final class HdrSurface extends SurfaceView implements SurfaceHolder.Callback {
  static final int EGL_COLORSPACE = 0x309d, SCRGB_LINEAR = 0x3350, BT2020_PQ = 0x3340;
  final MainActivity activity;
  final boolean floating;
  final Object gate = new Object();
  volatile boolean running;
  volatile long generation;
  volatile int surfaceWidth = 1, surfaceHeight = 1;
  org.json.JSONObject pending;
  String requestedShader = "", requestedCover = "";
  boolean coverChanged;
  Thread thread;

  static int[] config(boolean floating) {
    return floating
        ? new int[] {
          EGL14.EGL_RED_SIZE,
          16,
          EGL14.EGL_GREEN_SIZE,
          16,
          EGL14.EGL_BLUE_SIZE,
          16,
          EGL14.EGL_ALPHA_SIZE,
          16,
          0x3339,
          0x333b,
          EGL14.EGL_RENDERABLE_TYPE,
          64,
          EGL14.EGL_SURFACE_TYPE,
          EGL14.EGL_WINDOW_BIT,
          EGL14.EGL_NONE
        }
        : new int[] {
          EGL14.EGL_RED_SIZE,
          10,
          EGL14.EGL_GREEN_SIZE,
          10,
          EGL14.EGL_BLUE_SIZE,
          10,
          EGL14.EGL_ALPHA_SIZE,
          2,
          EGL14.EGL_RENDERABLE_TYPE,
          64,
          EGL14.EGL_SURFACE_TYPE,
          EGL14.EGL_WINDOW_BIT,
          EGL14.EGL_NONE
        };
  }

  static EGLConfig choose(EGLDisplay display, boolean floating) {
    EGLConfig[] configs = new EGLConfig[1];
    int[] count = new int[1];
    return EGL14.eglChooseConfig(display, config(floating), 0, configs, 0, 1, count, 0)
            && count[0] > 0
        ? configs[0]
        : null;
  }

  /** 0 = extended linear F16, 1 = HDR10/PQ, -1 = unavailable. */
  static int probe() {
    EGLDisplay display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] version = new int[2];
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) return -1;
    try {
      String extensions = EGL14.eglQueryString(display, EGL14.EGL_EXTENSIONS);
      if (extensions != null
          && extensions.contains("EGL_EXT_gl_colorspace_scrgb_linear")
          && choose(display, true) != null) return 0;
      if (extensions != null
          && extensions.contains("EGL_EXT_gl_colorspace_bt2020_pq")
          && choose(display, false) != null) return 1;
      return -1;
    } finally {
      /* The default EGL display is shared with WebView; never terminate it. */
    }
  }

  HdrSurface(MainActivity activity, boolean floating) {
    super(activity);
    this.activity = activity;
    this.floating = floating;
    setZOrderOnTop(false);
    setZOrderMediaOverlay(false);
    getHolder().setFormat(floating ? PixelFormat.RGBA_F16 : 43 /* RGBA_1010102 */);
    getHolder().addCallback(this);
    setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
  }

  void offer(org.json.JSONObject frame) {
    int width = frame.optInt("width"), height = frame.optInt("height");
    if (width < 2 || height < 2 || width > 16384 || height > 16384)
      throw new IllegalArgumentException("无效 HDR 目标尺寸");
    synchronized (gate) {
      if (frame.has("fragment")) requestedShader = frame.optString("fragment");
      if (requestedShader.length() > 65536) throw new IllegalArgumentException("HDR 插件过大");
      if (frame.has("backdrop")) {
        requestedCover = frame.isNull("backdrop") ? "" : frame.optString("backdrop");
        coverChanged = true;
      }
      pending = frame;
      gate.notifyAll();
    }
  }

  @Override
  public void surfaceCreated(SurfaceHolder holder) {
    running = true;
    final long token = ++generation;
    thread = new Thread(() -> render(token), "jap-native-hdr");
    thread.start();
  }

  @Override
  public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
    surfaceWidth = width;
    surfaceHeight = height;
  }

  @Override
  public void surfaceDestroyed(SurfaceHolder holder) {
    running = false;
    synchronized (gate) {
      gate.notifyAll();
    }
    generation++;
    if (activity.hdrSurface == this) activity.nativeHdrReady(false, "HDR 已关闭（显示表面挂起）");
  }

  static int shader(int type, String code) {
    int id = GLES30.glCreateShader(type);
    GLES30.glShaderSource(id, code);
    GLES30.glCompileShader(id);
    int[] status = new int[1];
    GLES30.glGetShaderiv(id, GLES30.GL_COMPILE_STATUS, status, 0);
    if (status[0] == 0) throw new IllegalStateException(GLES30.glGetShaderInfoLog(id));
    return id;
  }

  static final String VERTEX =
      "#version 300 es\n"
          + "precision highp float;out vec2 vUv;void main(){vec2"
          + " p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));vUv=p;gl_Position=vec4(p*2.-1.,0.,1.);}";

  static int program(String fragment) {
    int id = GLES30.glCreateProgram(),
        vs = shader(GLES30.GL_VERTEX_SHADER, VERTEX),
        fs = shader(GLES30.GL_FRAGMENT_SHADER, fragment);
    GLES30.glAttachShader(id, vs);
    GLES30.glAttachShader(id, fs);
    GLES30.glLinkProgram(id);
    GLES30.glDeleteShader(vs);
    GLES30.glDeleteShader(fs);
    int[] ok = new int[1];
    GLES30.glGetProgramiv(id, GLES30.GL_LINK_STATUS, ok, 0);
    if (ok[0] == 0) {
      String log = GLES30.glGetProgramInfoLog(id);
      GLES30.glDeleteProgram(id);
      throw new IllegalStateException(log);
    }
    return id;
  }

  static void texture(int id) {
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, id);
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR);
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR);
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE);
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE);
  }

  String antialiasSource() throws java.io.IOException {
    try (java.io.InputStream in = activity.getAssets().open("web/shaders/antialias.glsl")) {
      java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      int n;
      while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
      return new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
    }
  }

  static void uniforms(int program, org.json.JSONObject values) throws Exception {
    for (java.util.Iterator<String> keys = values.keys(); keys.hasNext(); ) {
      String key = keys.next();
      int location = GLES30.glGetUniformLocation(program, key);
      if (location < 0) continue;
      Object value = values.get(key);
      if (value instanceof Number) GLES30.glUniform1f(location, ((Number) value).floatValue());
      else if (value instanceof org.json.JSONArray) {
        org.json.JSONArray a = (org.json.JSONArray) value;
        float[] v = new float[a.length()];
        for (int i = 0; i < v.length; i++) v[i] = (float) a.getDouble(i);
        if (v.length == 2) GLES30.glUniform2fv(location, 1, v, 0);
        else if (v.length == 3) GLES30.glUniform3fv(location, 1, v, 0);
        else if (v.length == 4) GLES30.glUniform4fv(location, 1, v, 0);
        else if (v.length > 4 && v.length % 4 == 0)
          GLES30.glUniform4fv(location, v.length / 4, v, 0);
      }
    }
  }

  static void textureUniforms(
      int program, org.json.JSONObject data, java.util.LinkedHashMap<String, int[]> images)
      throws Exception {
    GLES30.glActiveTexture(GLES30.GL_TEXTURE2);
    org.json.JSONArray updates = data.optJSONArray("textures");
    if (updates != null)
      for (int i = 0; i < updates.length(); i++) {
        org.json.JSONObject item = updates.getJSONObject(i);
        String name = item.getString("name");
        int w = item.getInt("width"), h = item.getInt("height");
        if (!name.matches("u[A-Za-z0-9_]{1,63}")
            || w < 1
            || h < 1
            || w > 2048
            || h > 2048
            || (!images.containsKey(name) && images.size() >= 4))
          throw new IllegalArgumentException("效果纹理无效");
        String encoded = item.getString("data");
        if (encoded.length() > (long) w * h * 2 + 8) throw new IllegalArgumentException("效果纹理长度无效");
        byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
        if (bytes.length != w * h) throw new IllegalArgumentException("效果纹理尺寸无效");
        int[] image = images.get(name);
        if (image == null) {
          image = new int[3];
          GLES30.glGenTextures(1, image, 0);
          images.put(name, image);
        }
        texture(image[0]);
        GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1);
        if (image[1] != w || image[2] != h)
          GLES30.glTexImage2D(
              GLES30.GL_TEXTURE_2D,
              0,
              GLES30.GL_R8,
              w,
              h,
              0,
              GLES30.GL_RED,
              GLES30.GL_UNSIGNED_BYTE,
              ByteBuffer.wrap(bytes));
        else
          GLES30.glTexSubImage2D(
              GLES30.GL_TEXTURE_2D,
              0,
              0,
              0,
              w,
              h,
              GLES30.GL_RED,
              GLES30.GL_UNSIGNED_BYTE,
              ByteBuffer.wrap(bytes));
        image[1] = w;
        image[2] = h;
      }
    int unit = 2;
    for (java.util.Map.Entry<String, int[]> entry : images.entrySet()) {
      GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit);
      GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, entry.getValue()[0]);
      GLES30.glUniform1i(GLES30.glGetUniformLocation(program, entry.getKey()), unit++);
    }
  }

  static void disposeTextures(java.util.LinkedHashMap<String, int[]> images) {
    for (int[] image : images.values()) GLES30.glDeleteTextures(1, image, 0);
    images.clear();
  }

  static org.json.JSONObject validate(org.json.JSONObject data) throws Exception {
    EGLDisplay display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
    int[] version = new int[2];
    EGL14.eglInitialize(display, version, 0, version, 1);
    EGLConfig[] choices = new EGLConfig[1];
    int[] count = new int[1];
    EGL14.eglChooseConfig(
        display,
        new int[] {
          EGL14.EGL_RED_SIZE,
          8,
          EGL14.EGL_GREEN_SIZE,
          8,
          EGL14.EGL_BLUE_SIZE,
          8,
          EGL14.EGL_ALPHA_SIZE,
          8,
          EGL14.EGL_RENDERABLE_TYPE,
          64,
          EGL14.EGL_SURFACE_TYPE,
          EGL14.EGL_PBUFFER_BIT,
          EGL14.EGL_NONE
        },
        0,
        choices,
        0,
        1,
        count,
        0);
    if (count[0] == 0) throw new IllegalStateException("QA EGL configuration unavailable");
    EGLContext context =
        EGL14.eglCreateContext(
            display,
            choices[0],
            EGL14.EGL_NO_CONTEXT,
            new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE},
            0);
    EGLSurface surface =
        EGL14.eglCreatePbufferSurface(
            display,
            choices[0],
            new int[] {EGL14.EGL_WIDTH, 32, EGL14.EGL_HEIGHT, 18, EGL14.EGL_NONE},
            0);
    try {
      if (!EGL14.eglMakeCurrent(display, surface, surface, context))
        throw new IllegalStateException("QA EGL context unavailable");
      int[] textures = new int[2], fbo = new int[1];
      GLES30.glGenTextures(2, textures, 0);
      GLES30.glGenFramebuffers(1, fbo, 0);
      texture(textures[0]);
      GLES30.glTexImage2D(
          GLES30.GL_TEXTURE_2D,
          0,
          GLES30.GL_RGBA16F,
          32,
          18,
          0,
          GLES30.GL_RGBA,
          GLES30.GL_HALF_FLOAT,
          null);
      GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbo[0]);
      GLES30.glFramebufferTexture2D(
          GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, textures[0], 0);
      if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER) != GLES30.GL_FRAMEBUFFER_COMPLETE)
        throw new IllegalStateException("QA float framebuffer unavailable");
      texture(textures[1]);
      GLES30.glTexImage2D(
          GLES30.GL_TEXTURE_2D,
          0,
          GLES30.GL_RGBA8,
          1,
          1,
          0,
          GLES30.GL_RGBA,
          GLES30.GL_UNSIGNED_BYTE,
          ByteBuffer.wrap(new byte[] {0, 0, 0, -1}));
      int program =
          program(
              "#version 300 es\nprecision highp float;in vec2 vUv;out vec4 color;"
                  + data.getString("fragment")
                  + "\nvoid main(){color=vec4(clamp(visualize(vUv),vec3(0.),vec3(8.)),1.);}");
      GLES30.glUseProgram(program);
      uniforms(program, data.getJSONObject("uniforms"));
      java.util.LinkedHashMap<String, int[]> extraTextures = new java.util.LinkedHashMap<>();
      textureUniforms(program, data, extraTextures);
      GLES30.glViewport(0, 0, 32, 18);
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3);
      FloatBuffer pixels =
          ByteBuffer.allocateDirect(32 * 18 * 4 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
      // Debug-only, one-off cross-runtime comparison. Live HDR never reads pixels.
      GLES30.glReadPixels(0, 0, 32, 18, GLES30.GL_RGBA, GLES30.GL_FLOAT, pixels);
      int error = GLES30.glGetError();
      if (error != GLES30.GL_NO_ERROR)
        throw new IllegalStateException("QA GL " + Integer.toHexString(error));
      org.json.JSONArray values = new org.json.JSONArray();
      for (int n = 0; n < pixels.capacity(); n++) values.put(pixels.get(n));
      org.json.JSONObject result =
          new org.json.JSONObject()
              .put("pixels", values)
              .put("renderer", GLES30.glGetString(GLES30.GL_RENDERER));
      GLES30.glDeleteProgram(program);
      disposeTextures(extraTextures);
      GLES30.glDeleteTextures(2, textures, 0);
      GLES30.glDeleteFramebuffers(1, fbo, 0);
      return result;
    } finally {
      EGL14.eglMakeCurrent(
          display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
      EGL14.eglDestroySurface(display, surface);
      EGL14.eglDestroyContext(display, context);
      EGL14.eglReleaseThread();
    }
  }

  void render(long token) {
    EGLDisplay display = EGL14.EGL_NO_DISPLAY;
    EGLContext context = EGL14.EGL_NO_CONTEXT;
    EGLSurface surface = EGL14.EGL_NO_SURFACE;
    try {
      display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY);
      int[] v = new int[2];
      if (!EGL14.eglInitialize(display, v, 0, v, 1)) throw new IllegalStateException("EGL 初始化失败");
      EGLConfig cfg = choose(display, floating);
      if (cfg == null) throw new IllegalStateException("无 HDR EGL 配置");
      context =
          EGL14.eglCreateContext(
              display,
              cfg,
              EGL14.EGL_NO_CONTEXT,
              new int[] {EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE},
              0);
      surface =
          EGL14.eglCreateWindowSurface(
              display,
              cfg,
              getHolder().getSurface(),
              new int[] {EGL_COLORSPACE, floating ? SCRGB_LINEAR : BT2020_PQ, EGL14.EGL_NONE},
              0);
      if (context == EGL14.EGL_NO_CONTEXT
          || surface == EGL14.EGL_NO_SURFACE
          || !EGL14.eglMakeCurrent(display, surface, surface, context))
        throw new IllegalStateException("无法创建 HDR 表面：" + Integer.toHexString(EGL14.eglGetError()));
      EGL14.eglSwapInterval(display, 1);
      String present =
          "#version 300 es\n"
              + "#define JA_TEXTURE texture\n"
              + "precision highp float;\n"
              + antialiasSource()
              + "precision highp float;in vec2 vUv;out vec4 color;uniform highp sampler2D"
              + " image;uniform highp sampler2D previous;uniform vec2 resolution;uniform float"
              + " blend;uniform int pq;vec3 encode(vec3"
              + " x){x=pow(clamp(x/10000.,0.,1.),vec3(.1593017578125));return"
              + " pow((.8359375+18.8515625*x)/(1.+18.6875*x),vec3(78.84375));}void main(){vec3"
              + " c=jaAntialias(image,vUv,resolution);if(blend<1.)c=mix(jaAntialias(previous,vUv,resolution),c,blend);if(pq==1){c=mat3(.627404,.069097,.016392,.329283,.919540,.088013,.043313,.011362,.895595)*max(c,vec3(0.));color=vec4(encode(c*203.),1.);}else"
              + " color=vec4(max(c,vec3(0.))*(203./80.),1.);}";
      int presenter = program(present), scene = 0, current = 0, width = 0, height = 0, cover = 0;
      int[] images = new int[2], fbos = new int[2], covers = new int[2], limit = new int[1];
      GLES30.glGetIntegerv(GLES30.GL_MAX_TEXTURE_SIZE, limit, 0);
      GLES30.glGenTextures(2, images, 0);
      GLES30.glGenFramebuffers(2, fbos, 0);
      GLES30.glGenTextures(2, covers, 0);
      for (int id : covers) {
        texture(id);
        GLES30.glTexImage2D(
            GLES30.GL_TEXTURE_2D,
            0,
            GLES30.GL_SRGB8_ALPHA8,
            1,
            1,
            0,
            GLES30.GL_RGBA,
            GLES30.GL_UNSIGNED_BYTE,
            ByteBuffer.wrap(new byte[] {0, 0, 0, -1}));
      }
      String source = "";
      java.util.LinkedHashMap<String, int[]> extraTextures = new java.util.LinkedHashMap<>();
      boolean first = true, hasImage = false;
      long transition = 0, coverTransition = 0;
      while (running && token == generation) {
        org.json.JSONObject data;
        String next, art = null;
        boolean newCover;
        synchronized (gate) {
          while (running && token == generation && pending == null) gate.wait();
          if (!running || token != generation) break;
          data = pending;
          pending = null;
          next = requestedShader;
          newCover = coverChanged;
          if (newCover) {
            art = requestedCover;
            coverChanged = false;
          }
        }
        if (next.isEmpty()) continue;
        long now = System.nanoTime();
        if (!source.equals(next)) {
          int compiled =
              program(
                  "#version 300 es\nprecision highp float;in vec2 vUv;out vec4 color;"
                      + next
                      + "\nvoid main(){color=vec4(clamp(visualize(vUv),vec3(0.),vec3(8.)),1.);}");
          if (scene != 0) GLES30.glDeleteProgram(scene);
          scene = compiled;
          disposeTextures(extraTextures);
          source = next;
          if (hasImage) {
            current = 1 - current;
            transition = now;
          }
        }
        int w = Math.min(limit[0], data.getInt("width")),
            h = Math.min(limit[0], data.getInt("height"));
        if (w != width || h != height) {
          width = w;
          height = h;
          hasImage = false;
          transition = 0;
          final int bw = w, bh = h;
          activity.runOnUiThread(() -> getHolder().setFixedSize(bw, bh));
          for (int i = 0; i < 2; i++) {
            texture(images[i]);
            GLES30.glTexImage2D(
                GLES30.GL_TEXTURE_2D,
                0,
                GLES30.GL_RGBA16F,
                w,
                h,
                0,
                GLES30.GL_RGBA,
                GLES30.GL_HALF_FLOAT,
                null);
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbos[i]);
            GLES30.glFramebufferTexture2D(
                GLES30.GL_FRAMEBUFFER,
                GLES30.GL_COLOR_ATTACHMENT0,
                GLES30.GL_TEXTURE_2D,
                images[i],
                0);
            if (GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER)
                != GLES30.GL_FRAMEBUFFER_COMPLETE) throw new IllegalStateException("HDR 浮点目标不完整");
          }
        }
        if (newCover) {
          cover = 1 - cover;
          texture(covers[cover]);
          if (art == null || art.isEmpty())
            GLES30.glTexImage2D(
                GLES30.GL_TEXTURE_2D,
                0,
                GLES30.GL_SRGB8_ALPHA8,
                1,
                1,
                0,
                GLES30.GL_RGBA,
                GLES30.GL_UNSIGNED_BYTE,
                ByteBuffer.wrap(new byte[] {0, 0, 0, -1}));
          else {
            byte[] bytes = Base64.decode(art.substring(art.indexOf(',') + 1), Base64.NO_WRAP);
            android.graphics.Bitmap bitmap =
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap != null) {
              GLUtils.texImage2D(
                  GLES30.GL_TEXTURE_2D,
                  0,
                  GLES30.GL_SRGB8_ALPHA8,
                  bitmap,
                  GLES30.GL_UNSIGNED_BYTE,
                  0);
              bitmap.recycle();
            }
          }
          coverTransition = now;
        }
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, fbos[current]);
        GLES30.glViewport(0, 0, width, height);
        GLES30.glUseProgram(scene);
        uniforms(scene, data.getJSONObject("uniforms"));
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, covers[cover]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(scene, "uBackdrop"), 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, covers[1 - cover]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(scene, "uBackdropPrevious"), 1);
        GLES30.glUniform1f(GLES30.glGetUniformLocation(scene, "uBackdropFlip"), 1f);
        GLES30.glUniform1f(
            GLES30.glGetUniformLocation(scene, "uBackdropMix"),
            Math.min(1f, (now - coverTransition) / 850000000f));
        textureUniforms(scene, data, extraTextures);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3);
        GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0);
        GLES30.glViewport(0, 0, surfaceWidth, surfaceHeight);
        GLES30.glUseProgram(presenter);
        GLES30.glUniform2f(GLES30.glGetUniformLocation(presenter, "resolution"), width, height);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE0);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, images[current]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(presenter, "image"), 0);
        GLES30.glActiveTexture(GLES30.GL_TEXTURE1);
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, images[hasImage ? 1 - current : current]);
        GLES30.glUniform1i(GLES30.glGetUniformLocation(presenter, "previous"), 1);
        GLES30.glUniform1f(
            GLES30.glGetUniformLocation(presenter, "blend"),
            transition == 0 ? 1 : Math.min(1f, (now - transition) / 650000000f));
        GLES30.glUniform1i(GLES30.glGetUniformLocation(presenter, "pq"), floating ? 0 : 1);
        GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3);
        int error = GLES30.glGetError();
        if (error != GLES30.GL_NO_ERROR)
          throw new IllegalStateException("HDR OpenGL " + Integer.toHexString(error));
        if (!EGL14.eglSwapBuffers(display, surface)) throw new IllegalStateException("HDR 显示提交失败");
        hasImage = true;
        if (first) {
          first = false;
          if (activity.hdrSurface == this && token == generation)
            activity.nativeHdrReady(
                true, "Android 原生 GPU " + (floating ? "scRGB Float16" : "HDR10 / PQ"));
        }
      }
      GLES30.glDeleteTextures(2, images, 0);
      GLES30.glDeleteTextures(2, covers, 0);
      disposeTextures(extraTextures);
      GLES30.glDeleteFramebuffers(2, fbos, 0);
      if (scene != 0) GLES30.glDeleteProgram(scene);
      GLES30.glDeleteProgram(presenter);
    } catch (Exception e) {
      if (running && activity.hdrSurface == this && token == generation)
        activity.nativeHdrReady(false, e.toString());
    } finally {
      if (display != EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(
            display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT);
        if (surface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, surface);
        if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context);
        EGL14.eglReleaseThread();
      }
      if (token == generation) running = false;
    }
  }
}
