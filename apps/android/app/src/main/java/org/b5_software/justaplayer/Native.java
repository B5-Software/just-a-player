package org.b5_software.justaplayer;

final class Native {
  static {
    System.loadLibrary("jap_android");
  }

  static native String init(String home, String libraries);

  static native String message(String message);

  static native String poll(boolean visual);

  static native String lightInit(String root, String settings, String handoff);

  static native String lightEvent(String message);

  static native String lightControl(String message);

  static native String lightDraw(android.graphics.Bitmap target, String input);

  static native String usbAttach(
      String id, int fd, String name, String descriptors, int vendor, int product);

  static native String usbDetach(String id);
}
