package org.b5_software.justaplayer;

import android.os.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.function.Consumer;

/** Large messages use an fd; Binder transactions never contain video pixels. */
final class RendererIPC {
  static final int INIT = 1, EVENT = 2, REQUEST = 3, ENGINE = 4, VIDEO_PIPE = 5;
  static final ExecutorService IO =
      Executors.newCachedThreadPool(
          r ->
              new Thread(
                  () -> {
                    android.os.Process.setThreadPriority(
                        android.os.Process.THREAD_PRIORITY_BACKGROUND);
                    r.run();
                  },
                  "jap-renderer-ipc"));

  static void send(Messenger target, int what, String text, Messenger reply) throws Exception {
    Message message = Message.obtain(null, what);
    message.replyTo = reply;
    Bundle b = new Bundle();
    message.setData(b);
    if (text.length() < 30000) {
      b.putString("text", text);
      target.send(message);
      return;
    }
    ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
    b.putParcelable("textFd", pipe[0]);
    try {
      target.send(message);
    } catch (Exception e) {
      pipe[1].close();
      throw e;
    } finally {
      pipe[0].close();
    }
    IO.execute(
        () -> {
          try (OutputStream out = new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
          } catch (Exception e) {
            android.util.Log.w("JAP-Export", "IPC closed", e);
          }
        });
  }

  static void read(Message message, Handler ui, Consumer<String> consumer) {
    Bundle b = message.getData();
    String text = b.getString("text");
    if (text != null) {
      consumer.accept(text);
      return;
    }
    ParcelFileDescriptor fd = b.getParcelable("textFd");
    if (fd == null) return;
    IO.execute(
        () -> {
          try (InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(fd)) {
            String value = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            ui.post(() -> consumer.accept(value));
          } catch (Exception e) {
            android.util.Log.w("JAP-Export", "IPC read", e);
          }
        });
  }
}
