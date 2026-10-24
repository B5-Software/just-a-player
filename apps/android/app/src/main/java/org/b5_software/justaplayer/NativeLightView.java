package org.b5_software.justaplayer;

import android.content.*;
import android.graphics.*;
import android.os.*;
import android.view.*;
import android.view.inputmethod.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.*;

/** A native View presenting Rust/egui pixels; never creates a WebView. */
final class NativeLightView extends View {
  final MainActivity activity;
  final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
  final JSONArray events = new JSONArray();
  Bitmap bitmap;
  boolean keyboard, closed;
  float lastX, lastY, downX, downY;
  boolean scrolling;
  long renders;
  final Runnable redraw = this::redrawTick;

  void redrawTick() {
    if (closed) return;
    if (MainActivity.visible) invalidate();
    postDelayed(redraw, activity.lightMeters ? 34 : 200);
  }

  NativeLightView(MainActivity activity) {
    super(activity);
    this.activity = activity;
    setFocusable(true);
    setFocusableInTouchMode(true);
    try {
      File file = new File(activity.getFilesDir(), "light-handoff.json");
      String handoff =
          file.isFile()
              ? new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8)
              : "null";
      file.delete();
      Native.lightInit(
          activity.getFilesDir().getAbsolutePath(),
          activity.getSharedPreferences("player", 0).getString("settings", "{}"),
          handoff);
    } catch (Exception e) {
      android.util.Log.e("JAP-Native", "Native UI init", e);
    }
    post(redraw);
    post(
        () -> {
          if (PlaybackService.instance != null) PlaybackService.instance.replay();
        });
  }

  void close(boolean release) {
    closed = true;
    removeCallbacks(redraw);
    if (release) Native.lightControl("{\"type\":\"close\"}");
    if (bitmap != null) {
      bitmap.recycle();
      bitmap = null;
    }
  }

  void event(String type, float x, float y) {
    try {
      events.put(
          new JSONObject()
              .put("type", type)
              .put("x", x / Math.max(1, getWidth()))
              .put("y", y / Math.max(1, getHeight()))
              .put("touch", true));
    } catch (Exception ignored) {
    }
  }

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    if (closed || getWidth() < 1 || getHeight() < 1) return;
    float scale = Math.min(1f, Math.min(1600f / getWidth(), 1000f / getHeight()));
    int width = Math.max(160, Math.round(getWidth() * scale)),
        height = Math.max(90, Math.round(getHeight() * scale));
    try {
      if (bitmap == null || bitmap.getWidth() != width || bitmap.getHeight() != height) {
        if (bitmap != null) bitmap.recycle();
        bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
      }
      JSONObject input =
          new JSONObject()
              .put("width", width)
              .put("height", height)
              .put("visible", MainActivity.visible)
              .put("mini", activity.isInPictureInPictureMode())
              .put("events", new JSONArray(events.toString()));
      while (events.length() > 0) events.remove(events.length() - 1);
      JSONObject result = new JSONObject(Native.lightDraw(bitmap, input.toString()));
      if (result.has("error")) throw new IOException(result.optString("error"));
      activity.lightMeters = result.optBoolean("visual");
      MainActivity.visualsVisible = false; // Rust owns native-only analysis.
      canvas.drawBitmap(bitmap, null, new Rect(0, 0, getWidth(), getHeight()), paint);
      renders++;
      boolean wants = result.optBoolean("keyboard");
      if (wants && !keyboard) {
        requestFocus();
        ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE))
            .showSoftInput(this, InputMethodManager.SHOW_IMPLICIT);
      }
      if (!wants && keyboard)
        ((InputMethodManager) activity.getSystemService(Context.INPUT_METHOD_SERVICE))
            .hideSoftInputFromWindow(getWindowToken(), 0);
      keyboard = wants;
      JSONArray actions = result.optJSONArray("actions");
      if (actions != null)
        for (int i = 0; i < actions.length(); i++) action(actions.getJSONObject(i));
      if (BuildConfig.DEBUG
          && activity.getIntent().getBooleanExtra("e2e", false)
          && renders % 5 == 0) {
        try (FileOutputStream out =
            new FileOutputStream(new File(activity.getFilesDir(), "native-report.json"))) {
          JSONObject report = new JSONObject(Native.lightControl("{\"type\":\"debug\"}"));
          int[] at = new int[2];
          getLocationOnScreen(at);
          report
              .put("viewWidth", getWidth())
              .put("viewHeight", getHeight())
              .put("viewX", at[0])
              .put("viewY", at[1]);
          out.write(report.toString().getBytes(StandardCharsets.UTF_8));
        }
      }
    } catch (Exception e) {
      canvas.drawColor(Color.rgb(19, 18, 26));
      paint.setColor(Color.rgb(236, 232, 245));
      paint.setTextSize(24);
      canvas.drawText("Just A Player · " + e.getMessage(), 24, 60, paint);
      android.util.Log.e("JAP-Native", "Draw", e);
    }
  }

  void action(JSONObject action) throws Exception {
    switch (action.optString("type")) {
      case "returnFull":
        JSONObject handoff = action.getJSONObject("handoff");
        try (FileOutputStream out =
            new FileOutputStream(new File(activity.getFilesDir(), "light-handoff.json"))) {
          out.write(handoff.toString().getBytes(StandardCharsets.UTF_8));
        }
        activity.getSharedPreferences("player", 0).edit().putBoolean("lightweight", false).apply();
        post(activity::loadPlayerPage);
        break;
      case "settings":
        activity
            .getSharedPreferences("player", 0)
            .edit()
            .putString("settings", action.getJSONObject("settings").toString())
            .apply();
        activity.applyPlaybackWindow();
        break;
      case "media":
        if (PlaybackService.instance != null)
          PlaybackService.instance.metadata(action.getJSONObject("value"));
        break;
      case "importPicker":
        Intent picker =
            new Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        activity.startActivityForResult(picker, 6190);
        break;
      case "usb":
        activity.bridge.request(1900000000, "connectUsb", "{}");
        break;
    }
  }

  void receive(String key, Object value) {
    try {
      if (key.equals("engine")) {
        JSONObject message =
            value instanceof JSONObject
                ? (JSONObject) value
                : new JSONObject(String.valueOf(value));
        if (message.optString("kind").equals("event")) Native.lightEvent(message.toString());
        JSONObject event = message.optJSONObject("event");
        if (event != null
            && (event.optString("type").equals("state")
                || event.optString("type").equals("trackChanged"))) {
          if (PlaybackService.instance != null)
            PlaybackService.instance.metadata(
                new JSONObject(Native.lightControl("{\"type\":\"mediaState\"}")));
        }
      } else if (key.equals("openFiles"))
        Native.lightControl(
            new JSONObject()
                .put("type", "external")
                .put("paths", activity.takeOpenFiles())
                .toString());
      else if (key.equals("visibility"))
        Native.lightControl(
            new JSONObject().put("type", "visible").put("visible", value).toString());
      else if (key.equals("nativeError"))
        Native.lightControl(
            new JSONObject().put("type", "error").put("message", String.valueOf(value)).toString());
    } catch (Exception e) {
      android.util.Log.e("JAP-Native", "Event", e);
    }
    if (MainActivity.visible
        && (!key.equals("engine") || !String.valueOf(value).contains("\"type\":\"position\"")))
      invalidate();
  }

  @Override
  public boolean onTouchEvent(MotionEvent e) {
    if (e.getPointerId(e.getActionIndex()) != e.getPointerId(0)) return true;
    float x = e.getX(), y = e.getY();
    switch (e.getActionMasked()) {
      case MotionEvent.ACTION_DOWN:
        downX = lastX = x;
        downY = lastY = y;
        scrolling = false;
        event("down", x, y);
        break;
      case MotionEvent.ACTION_MOVE:
        if (!scrolling
            && Math.abs(y - downY) > 12
            && Math.abs(y - downY) > Math.abs(x - downX) * 1.3) {
          scrolling = true;
          event("cancel", x, y);
        }
        if (scrolling) {
          try {
            events.put(
                new JSONObject()
                    .put("type", "scroll")
                    .put("dy", (y - lastY) * 540f / Math.max(1, getHeight()))
                    .put("x", x / Math.max(1, getWidth()))
                    .put("y", y / Math.max(1, getHeight())));
          } catch (Exception ignored) {
          }
        } else event("move", x, y);
        lastX = x;
        lastY = y;
        break;
      case MotionEvent.ACTION_UP:
        if (!scrolling) event("up", x, y);
        scrolling = false;
        break;
      case MotionEvent.ACTION_CANCEL:
        event("cancel", x, y);
        scrolling = false;
        break;
    }
    invalidate();
    return true;
  }

  @Override
  public boolean onKeyDown(int code, KeyEvent event) {
    try {
      if (code == KeyEvent.KEYCODE_DEL) {
        events.put(new JSONObject().put("type", "backspace"));
        invalidate();
        return true;
      }
      int ch = event.getUnicodeChar();
      if (ch > 0) {
        events.put(
            new JSONObject().put("type", "text").put("text", new String(Character.toChars(ch))));
        invalidate();
        return true;
      }
    } catch (Exception ignored) {
    }
    return super.onKeyDown(code, event);
  }

  @Override
  public boolean onCheckIsTextEditor() {
    return true;
  }

  @Override
  public InputConnection onCreateInputConnection(EditorInfo info) {
    info.inputType = android.text.InputType.TYPE_CLASS_TEXT;
    info.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_ACTION_DONE;
    return new BaseInputConnection(this, false) {
      @Override
      public boolean commitText(CharSequence text, int position) {
        try {
          events.put(new JSONObject().put("type", "text").put("text", text.toString()));
          invalidate();
        } catch (Exception ignored) {
        }
        return true;
      }

      @Override
      public boolean deleteSurroundingText(int before, int after) {
        try {
          for (int n = 0; n < Math.min(before, 100); n++)
            events.put(new JSONObject().put("type", "backspace"));
          invalidate();
        } catch (Exception ignored) {
        }
        return true;
      }

      @Override
      public boolean performEditorAction(int action) {
        clearFocus();
        return true;
      }
    };
  }
}
