package org.b5_software.justaplayer;

import android.app.*;
import android.content.*;
import android.graphics.BitmapFactory;
import android.media.*;
import android.media.session.*;
import android.os.*;
import android.util.Base64;
import java.util.concurrent.*;
import org.json.*;

/** Native audio is owned independently of the Activity/WebView render lifecycle. */
public final class PlaybackService extends Service {
  static volatile PlaybackService instance;
  static final String CHANNEL = "playback";
  MediaSession session;
  AudioManager audio;
  AudioFocusRequest focus;
  boolean hasFocus, foreground;
  volatile boolean playingState;
  android.graphics.Bitmap cover;
  JSONObject state = new JSONObject();
  final java.util.Map<String, JSONObject> latest = new java.util.concurrent.ConcurrentHashMap<>();

  void replay() {
    for (String type :
        new String[] {"trackChanged", "signalPath", "dspChanged", "volume", "state", "position"}) {
      JSONObject value = latest.get(type);
      if (value != null)
        try {
          MainActivity.emit("engine", new JSONObject().put("kind", "event").put("event", value));
        } catch (JSONException ignored) {
        }
    }
  }

  final Handler main = new Handler(Looper.getMainLooper());
  final ScheduledExecutorService engine =
      Executors.newSingleThreadScheduledExecutor(r -> new Thread(r, "jap-android-host"));
  final BroadcastReceiver noisy =
      new BroadcastReceiver() {
        public void onReceive(Context c, Intent i) {
          command("pause");
        }
      };

  @Override
  public void onCreate() {
    super.onCreate();
    instance = this;
    Native.init(getCacheDir().getAbsolutePath(), getApplicationInfo().nativeLibraryDir);
    engine.execute(
        () -> {
          try {
            MidiResources.ensure(this);
          } catch (Exception e) {
            android.util.Log.e("JAP", "Bundled MIDI bank", e);
          }
        });
    audio = (AudioManager) getSystemService(AUDIO_SERVICE);
    focus =
        new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build())
            .setOnAudioFocusChangeListener(
                change -> {
                  if (change == AudioManager.AUDIOFOCUS_LOSS
                      || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                      || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
                    command("pause");
                },
                main)
            .build();
    session = new MediaSession(this, "Just A Player");
    session.setCallback(
        new MediaSession.Callback() {
          public void onPlay() {
            command("play");
          }

          public void onPause() {
            command("pause");
          }

          public void onSkipToNext() {
            command("next");
          }

          public void onSkipToPrevious() {
            command("previous");
          }

          public void onStop() {
            command("stop");
          }

          public void onSeekTo(long ms) {
            send(
                "{\"kind\":\"command\",\"command\":{\"type\":\"seek\",\"positionMs\":" + ms + "}}");
          }
        });
    session.setFlags(
        MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
    session.setActive(true);
    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
        .createNotificationChannel(
            new NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW));
    registerReceiver(noisy, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));
    engine.scheduleWithFixedDelay(
        () -> {
          try {
            JSONArray messages = new JSONArray(Native.poll(MainActivity.visualsVisible));
            for (int n = 0; n < messages.length(); n++) {
              JSONObject e = messages.getJSONObject(n);
              if (!e.has("kind")) {
                String type = e.optString("type");
                if (type.equals("state")) {
                  playingState = e.optString("state").equals("playing");
                  MainActivity a = MainActivity.current.get();
                  if (a != null) {
                    a.applyPlaybackWindow();
                    a.refreshPip();
                  }
                }
                if (java.util.Arrays.asList(
                        "trackChanged", "signalPath", "dspChanged", "volume", "state", "position")
                    .contains(type)) latest.put(type, e);
                JSONObject wrapped = new JSONObject();
                wrapped.put("kind", "event");
                wrapped.put("event", e);
                e = wrapped;
              }
              MainActivity.emit("engine", e);
            }
          } catch (Exception e) {
            android.util.Log.e("JAP", "Engine poll", e);
          }
        },
        0,
        32,
        TimeUnit.MILLISECONDS);
  }

  static void command(String command) {
    PlaybackService s = instance;
    // Pause/stop must work even when WebView is absent or busy.
    if (s != null && (command.equals("pause") || command.equals("stop")))
      s.send("{\"kind\":\"command\",\"command\":{\"type\":\"" + command + "\"}}");
    MainActivity.emit("media", command);
  }

  void send(String message) {
    engine.execute(
        () -> {
          String response = Native.message(message);
          try {
            JSONObject r = new JSONObject(response);
            if (r.has("kind")) MainActivity.emit("engine", r);
            else if (r.has("error")) MainActivity.emit("nativeError", r.optString("error"));
          } catch (JSONException ignored) {
          }
        });
  }

  void metadata(JSONObject value) {
    main.post(
        () -> {
          state = value;
          boolean playing = "playing".equals(value.optString("state"));
          if (playing && !hasFocus) {
            hasFocus = audio.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            if (!hasFocus) {
              command("pause");
              return;
            }
          }
          MediaMetadata.Builder meta =
              new MediaMetadata.Builder()
                  .putString(MediaMetadata.METADATA_KEY_TITLE, value.optString("title"))
                  .putString(MediaMetadata.METADATA_KEY_ARTIST, value.optString("artist"))
                  .putString(MediaMetadata.METADATA_KEY_ALBUM, value.optString("album"))
                  .putLong(MediaMetadata.METADATA_KEY_DURATION, value.optLong("durationMs"));
          if (value.has("coverBase64")) {
            String data = value.optString("coverBase64");
            cover = null;
            if (!data.isEmpty())
              try {
                byte[] b = Base64.decode(data, 0);
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(b, 0, b.length, options);
                options.inSampleSize = 1;
                while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 512)
                  options.inSampleSize *= 2;
                options.inJustDecodeBounds = false;
                cover = BitmapFactory.decodeByteArray(b, 0, b.length, options);
              } catch (Exception ignored) {
              }
          }
          if (cover != null) meta.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cover);
          session.setMetadata(meta.build());
          session.setPlaybackState(
              new PlaybackState.Builder()
                  .setActions(
                      PlaybackState.ACTION_PLAY
                          | PlaybackState.ACTION_PAUSE
                          | PlaybackState.ACTION_PLAY_PAUSE
                          | PlaybackState.ACTION_SKIP_TO_NEXT
                          | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                          | PlaybackState.ACTION_STOP
                          | PlaybackState.ACTION_SEEK_TO)
                  .setState(
                      playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                      value.optLong("positionMs"),
                      playing ? 1 : 0)
                  .build());
          if (playing || foreground) {
            Notification n = notification(playing);
            if (!foreground) {
              startService(new Intent(this, PlaybackService.class));
              startForeground(1, n);
              foreground = true;
            } else ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(1, n);
          }
          if (!playing && hasFocus) {
            audio.abandonAudioFocusRequest(focus);
            hasFocus = false;
          }
        });
  }

  PendingIntent action(String action, int id) {
    return PendingIntent.getService(
        this,
        id,
        new Intent(this, PlaybackService.class).setAction(action),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
  }

  Notification notification(boolean playing) {
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new Notification.Builder(this, CHANNEL)
        .setSmallIcon(org.b5_software.justaplayer.R.drawable.ic_player)
        .setLargeIcon(cover)
        .setContentTitle(state.optString("title", "Just A Player"))
        .setContentText(state.optString("artist"))
        .setContentIntent(open)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setOnlyAlertOnce(true)
        .setOngoing(playing)
        .addAction(
            new Notification.Action.Builder(
                    android.R.drawable.ic_media_previous, "上一首", action("previous", 1))
                .build())
        .addAction(
            new Notification.Action.Builder(
                    playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    playing ? "暂停" : "播放",
                    action(playing ? "pause" : "play", 2))
                .build())
        .addAction(
            new Notification.Action.Builder(
                    android.R.drawable.ic_media_next, "下一首", action("next", 3))
                .build())
        .setStyle(
            new Notification.MediaStyle()
                .setMediaSession(session.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2))
        .build();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int id) {
    if (intent != null && intent.getAction() != null) command(intent.getAction());
    return START_NOT_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return new Binder();
  }

  @Override
  public void onDestroy() {
    command("stop");
    engine.shutdown();
    unregisterReceiver(noisy);
    if (hasFocus) audio.abandonAudioFocusRequest(focus);
    session.release();
    instance = null;
    super.onDestroy();
  }
}
